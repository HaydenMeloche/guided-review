import path from 'node:path';
import { changedCount, maxRisk } from '../diff/lines.js';
import { escapeRe } from '../util/regex.js';
import { SCHEMA_PATH, sqlTableRefs } from './patterns.js';
import { SPECIAL_CHAPTERS, specialKindOf, type SpecialKind } from './special.js';
import { testStem } from './testPaths.js';
import type { Chapter, ChapterKind, DiffFile, FileKind, Flag, Graph, GraphEdge, GraphNode, Hunk } from '../types.js';
import type { CallEdge, Decl, SymbolIndex } from './symbols.js';

const LOW_PRIORITY: { kind: FileKind; chapter: ChapterKind; title: string; collapsed: boolean }[] = [
  { kind: 'config', chapter: 'config', title: 'Config, infra and docs', collapsed: false },
  { kind: 'mechanical', chapter: 'mechanical', title: 'Mechanical changes', collapsed: true },
  { kind: 'generated', chapter: 'generated', title: 'Generated code', collapsed: true },
  { kind: 'vendored', chapter: 'vendored', title: 'Vendored code', collapsed: true },
];

// Flow chapter sizes, in changed lines. A smaller flow folds into its nearest caller's chapter (or,
// with none, into supporting changes); a mid-sized one folds into a direct caller while the
// result stays under the maximum.
const MIN_FLOW_LINES = 40;
const FOLD_FLOW_LINES = 150;
const MAX_FOLDED_LINES = 500;

function shortName(qualified: string): string {
  return qualified.split('#')[1] ?? qualified;
}

function newChapter(id: string, kind: ChapterKind, title: string, hunkIds: string[], hunks: Record<string, Hunk>): Chapter {
  return {
    id,
    kind,
    title,
    risk: maxRisk(hunkIds, hunks),
    hunkIds,
    linkedHunkIds: [],
    orphanReasons: {},
    untestedBranches: [],
    collapsed: false,
  };
}

const BRANCH = /^\s*(?:\}\s*)?(?:if\b|else\b|switch\b|case\b|catch\b|elif\b|except\b|match\b)|\?\s*[^:]+:/;

function untestedBranches(ids: string[], hunks: Record<string, Hunk>): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const h = hunks[id];
    if (!h || h.coverage === 'tested') continue;
    for (const l of h.lines) {
      if (l.kind === 'add' && l.newLine && BRANCH.test(l.text)) {
        out.push(`${h.file}:${l.newLine} ${l.text.trim().slice(0, 60)}`);
      }
    }
  }
  return out.slice(0, 20);
}

function orphanReason(h: Hunk, file: DiffFile | undefined, decls: Decl[]): string {
  const adds = h.lines.filter((l) => l.kind === 'add').length;
  const dels = h.lines.filter((l) => l.kind === 'del').length;
  if (adds === 0 && dels > 0) return 'dead code removal';
  if (decls.length && decls.every((d) => d.kind === 'type' || d.kind === 'interface' || d.kind === 'enum')) {
    return 'type-only change';
  }
  if (file && /(config|settings|defaults?|constants?|env)\b/i.test(path.basename(file.path))) return 'config default';
  if (decls.length && decls.every((d) => d.kind === 'const')) return 'constant change';
  // Import-only hunks never get here: separateImportChapter moves them to their own chapter.
  if (!decls.length) return 'top-level change outside any function';
  return 'helper not called by changed code';
}

// An entry point with no declaration in its hunk is named after its reason (`file#route GET /x`);
// that name adds nothing to a title.
function entryName(reason: string, symbol: string): string | undefined {
  const name = shortName(symbol);
  return name === reason ? undefined : name;
}

function titleFor(reason: string, symbol: string): string {
  const name = entryName(reason, symbol);
  const route = /^route (.+)$/.exec(reason);
  if (route) return !name || route[1].includes(name) ? route[1] : `${route[1]} → ${name}`;
  if (!name) return reason;
  if (reason === 'exported API') return name;
  if (reason === 'React component') return `<${name}>`;
  return `${reason} → ${name}`;
}

// Moves each type-only hunk to just before the first hunk that mentions one of its type names.
function typesBeforeFirstUse(order: string[], hunks: Record<string, Hunk>, index: SymbolIndex): string[] {
  const result = [...order];
  for (const id of order) {
    const decls = index.hunkDecls[id] ?? [];
    if (!decls.length || !decls.every((q) => index.typeDecls.has(q))) continue;
    const names = decls.map(shortName).map((n) => n.split('.').pop()!);
    const re = new RegExp(`\\b(${names.map(escapeRe).join('|')})\\b`);
    const from = result.indexOf(id);
    result.splice(from, 1);
    const user = result.findIndex((other) => hunks[other]?.lines.some((l) => l.kind !== 'del' && re.test(l.text)));
    result.splice(user === -1 ? from : user, 0, id);
  }
  return result;
}

function callDiagram(title: string, ids: string[], index: SymbolIndex, declByQ: Map<string, Decl>): Graph | undefined {
  const qs = [...new Set(ids.flatMap((id) => index.hunkDecls[id] ?? []))];
  const fns = qs.filter((q) => {
    const k = declByQ.get(q)?.kind;
    return k !== 'type' && k !== 'interface' && k !== 'enum' && k !== 'const';
  });
  if (fns.length < 3) return undefined;
  const set = new Set(fns);
  const nodes: GraphNode[] = fns.map((q) => ({
    id: q,
    label: shortName(q),
    changed: true,
    hunkId: ids.find((id) => index.hunkDecls[id]?.includes(q)),
  }));
  const edges: GraphEdge[] = index.edges.filter((e) => set.has(e.from) && set.has(e.to)).map((e) => ({ from: e.from, to: e.to, confidence: e.source }));
  return { kind: 'call', title, nodes, edges };
}

// A union of string literals or an enum that gains members becomes a state diagram.
// Only lines inside the declaration count, so imports, props and JSX in the same hunk are not
// mistaken for members; an object type (`type Props = { a: string }`) is not a union.
export function stateDiagram(title: string, ids: string[], hunks: Record<string, Hunk>, index: SymbolIndex, declByQ: Map<string, Decl>): Graph | undefined {
  for (const id of ids) {
    const h = hunks[id];
    for (const q of index.hunkDecls[id] ?? []) {
      const d = declByQ.get(q);
      if (!d || d.side !== 'head' || (d.kind !== 'enum' && d.kind !== 'type')) continue;
      const body = h.lines.filter((l) => l.kind !== 'del' && l.newLine !== undefined && l.newLine >= d.startLine && l.newLine <= d.endLine);
      if (d.kind === 'type' && body.some((l) => /[{:]/.test(l.text.replace(/['"][^'"]*['"]/g, '')))) continue;
      const members: { name: string; changed: boolean }[] = [];
      for (const l of body) {
        const names = d.kind === 'type' ? [...l.text.matchAll(/['"]([A-Za-z_][\w-]*)['"]/g)].map((m) => m[1]) : [/^\s*([A-Za-z_]\w*)\s*(=|,|$)/.exec(l.text)?.[1]].filter((n): n is string => !!n);
        for (const name of names) {
          if (!members.some((m) => m.name === name)) members.push({ name, changed: l.kind === 'add' });
        }
      }
      if (members.length < 2 || !members.some((m) => m.changed)) continue;
      const nodes = members.map((m) => ({ id: `${q}:${m.name}`, label: m.name, changed: m.changed, hunkId: id }));
      const edges: GraphEdge[] = [];
      for (let i = 1; i < nodes.length; i++) edges.push({ from: nodes[i - 1].id, to: nodes[i].id });
      return { kind: 'state', title: `${title}: ${shortName(q)} states`, nodes, edges };
    }
  }
  return undefined;
}

function entityDiagram(title: string, files: DiffFile[], hunks: Record<string, Hunk>): Graph | undefined {
  const tables = new Map<string, { cols: string[]; changed: boolean; hunkId?: string }>();
  const edges: GraphEdge[] = [];
  const touch = (name: string, hunkId: string) => {
    const t = tables.get(name) ?? { cols: [], changed: true, hunkId };
    tables.set(name, t);
    return t;
  };
  for (const f of files) {
    if (!SCHEMA_PATH.test(f.path)) continue;
    for (const id of f.hunkIds) {
      const h = hunks[id];
      if (!h) continue;
      let current: string | undefined;
      for (const l of h.lines) {
        if (l.kind === 'del') continue;
        const text = l.text;
        const refs = sqlTableRefs(text);
        const alter = refs.find((r) => r.verb === 'alter');
        const added = alter && /^\s+add\s+(?:column\s+)?[`"]?(\w+)/i.exec(alter.rest);
        if (alter && added) {
          touch(alter.table, id).cols.push(`+${added[1]}`);
          continue;
        }
        const created = refs.find((r) => r.verb === 'create')?.table ?? /^\s*model\s+(\w+)\s*\{/.exec(text)?.[1];
        if (created) {
          current = created;
          touch(current, id);
          continue;
        }
        if (current) {
          if (/^\s*\)|^\s*\}/.test(text)) {
            current = undefined;
            continue;
          }
          const col = /^\s*[`"]?(\w+)[`"]?\s+\w+/.exec(text);
          if (col && !/^(primary|constraint|unique|index|key|foreign|@@)/i.test(col[1])) {
            touch(current, id).cols.push(`${l.kind === 'add' ? '+' : ''}${col[1]}`);
          }
          const ref = /references\s+[`"]?(\w+)/i.exec(text) ?? /@relation\(.*?\)|^\s*\w+\s+([A-Z]\w*)\??\s*(?:@|$)/.exec(text);
          if (ref?.[1] && ref[1] !== current) edges.push({ from: current, to: ref[1], label: 'refs' });
        }
      }
    }
  }
  if (!tables.size) return undefined;
  for (const e of edges) if (!tables.has(e.to)) tables.set(e.to, { cols: [], changed: false });
  const nodes: GraphNode[] = [...tables].map(([name, t]) => ({
    id: name,
    label: t.cols.length ? `${name}\n${t.cols.slice(0, 6).join(', ')}${t.cols.length > 6 ? ', …' : ''}` : name,
    changed: t.changed,
    hunkId: t.hunkId,
  }));
  return { kind: 'entity', title, nodes, edges };
}

// Import changes across modules: who gained or lost an import of whom.
function depsDiagram(title: string, files: DiffFile[], hunks: Record<string, Hunk>): Graph | undefined {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  for (const f of files) {
    if (f.kind !== 'logic') continue;
    for (const id of f.hunkIds) {
      const h = hunks[id];
      if (!h) continue;
      for (const l of h.lines) {
        if (l.kind === 'ctx') continue;
        const m = /(?:import\s.*?from\s+|import\s+|require\(\s*)['"]([^'"]+)['"]/.exec(l.text) ?? /^\s*from\s+([\w.]+)\s+import/.exec(l.text);
        if (!m) continue;
        const target = m[1].startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(f.path), m[1])) : m[1];
        const src = f.path.replace(/\.\w+$/, '');
        if (!nodes.has(src)) nodes.set(src, { id: src, label: path.posix.basename(src), changed: true, hunkId: id });
        if (!nodes.has(target)) nodes.set(target, { id: target, label: path.posix.basename(target), changed: false });
        edges.push({ from: src, to: target, label: l.kind === 'add' ? '+import' : '-import' });
      }
    }
  }
  if (!edges.length) return undefined;
  return { kind: 'deps', title, nodes: [...nodes.values()].slice(0, 24), edges: edges.slice(0, 40) };
}

// The flow chapter a paired test file belongs to: the one owning the most changed lines whose
// tests link to it, then the one owning a same-named source file. Undefined for a test file that
// pairs with no logic file at all.
function pairedChapter(f: DiffFile, logicFiles: DiffFile[], hunks: Record<string, Hunk>, owner: Map<string, string>): { paired: boolean; chapterId?: string } {
  const votes = new Map<string, number>();
  let paired = false;
  for (const lf of logicFiles) {
    for (const id of lf.hunkIds) {
      if (!hunks[id]?.tests.some((t) => t.testFile === f.path)) continue;
      paired = true;
      const c = owner.get(id);
      if (c) votes.set(c, (votes.get(c) ?? 0) + changedCount(hunks[id]));
    }
  }
  if (!votes.size) {
    const stem = testStem(f.path);
    for (const lf of logicFiles) {
      if (path.posix.basename(lf.path).replace(/\.\w+$/, '') !== stem) continue;
      paired = true;
      for (const id of lf.hunkIds) {
        const c = owner.get(id);
        if (c && hunks[id]) votes.set(c, (votes.get(c) ?? 0) + changedCount(hunks[id]));
      }
    }
  }
  let best: string | undefined;
  for (const [c, n] of votes) if (!best || n > votes.get(best)!) best = c;
  return { paired, chapterId: best };
}

// Lines too short or too generic to show where code came from.
const TRIVIAL_LINE = /^(\/\/|\*|import\s|export\s*\{|[})\]];?,?$|return;?$|break;$|\}\s*else\s*\{$)/;
const MIN_MOVED_LINES = 8;

// Hunks that mostly re-add lines another file's hunk deletes, mapped to that hunk: half or more
// of their meaningful added lines appear deleted there.
function movedFrom(ids: string[], hunks: Record<string, Hunk>): Map<string, string> {
  const norm = (t: string) => t.trim().replace(/\s+/g, ' ');
  const meaningful = (t: string) => t.length >= 12 && !TRIVIAL_LINE.test(t);
  const deletedIn = new Map<string, Set<string>>();
  for (const id of ids) {
    for (const l of hunks[id].lines) {
      if (l.kind !== 'del') continue;
      const t = norm(l.text);
      if (!meaningful(t)) continue;
      const set = deletedIn.get(t) ?? new Set<string>();
      set.add(id);
      deletedIn.set(t, set);
    }
  }
  const moves = new Map<string, string>();
  for (const id of ids) {
    const added = hunks[id].lines
      .filter((l) => l.kind === 'add')
      .map((l) => norm(l.text))
      .filter(meaningful);
    if (added.length < MIN_MOVED_LINES) continue;
    const votes = new Map<string, number>();
    for (const t of added) for (const from of deletedIn.get(t) ?? []) if (hunks[from].file !== hunks[id].file) votes.set(from, (votes.get(from) ?? 0) + 1);
    let best: string | undefined;
    for (const [from, n] of votes) if (!best || n > votes.get(best)!) best = from;
    if (best && votes.get(best)! * 2 >= added.length) moves.set(id, best);
  }
  return moves;
}

export function buildChapters(files: DiffFile[], hunks: Record<string, Hunk>, index: SymbolIndex): { chapters: Chapter[]; overview: Graph; notes: string[]; flags: Flag[] } {
  const notes: string[] = [];
  const flags: Flag[] = [];
  const chapters: Chapter[] = [];
  let n = 0;
  const nextId = () => `c${++n}`;

  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const logicFiles = sorted.filter((f) => f.kind === 'logic');
  // Migrations, API contracts, dependencies and the like get their own chapters, whatever they call.
  const special = new Map<string, SpecialKind>();
  for (const f of sorted) {
    for (const id of f.hunkIds) {
      const k = hunks[id] && specialKindOf(f, hunks[id]);
      if (k) special.set(id, k);
    }
  }
  const logicHunks = logicFiles.flatMap((f) => f.hunkIds).filter((id) => hunks[id] && !special.has(id));
  const fileOf = new Map<string, DiffFile>();
  for (const f of files) for (const id of f.hunkIds) fileOf.set(id, f);
  const declByQ = new Map<string, Decl>();
  for (const d of index.decls) if (!declByQ.has(d.qualified) || d.side === 'head') declByQ.set(d.qualified, d);

  // Decl -> hunks in line order; caller -> callees in call order.
  const hunksOfDecl = new Map<string, string[]>();
  for (const id of logicHunks) {
    for (const q of index.hunkDecls[id] ?? []) {
      const list = hunksOfDecl.get(q) ?? [];
      list.push(id);
      hunksOfDecl.set(q, list);
    }
  }
  const out = new Map<string, CallEdge[]>();
  for (const e of index.edges) {
    const list = out.get(e.from) ?? [];
    list.push(e);
    out.set(e.from, list);
  }
  for (const [from, list] of out) {
    const calls = declByQ.get(from)?.calls ?? [];
    list.sort((a, b) => calls.indexOf(shortName(a.to).split('.').pop()!) - calls.indexOf(shortName(b.to).split('.').pop()!));
  }

  const reach = (startHunk: string, startDecl: string): { hunks: string[]; decls: string[]; naming: boolean; dist: Map<string, number> } => {
    const decls: string[] = [];
    const ids: string[] = [];
    const seenDecls = new Set<string>();
    const seenIds = new Set<string>();
    let naming = false;
    const pushHunk = (id: string) => {
      if (seenIds.has(id)) return;
      seenIds.add(id);
      ids.push(id);
    };
    pushHunk(startHunk);
    const visit = (q: string) => {
      if (seenDecls.has(q)) return;
      seenDecls.add(q);
      decls.push(q);
      for (const id of hunksOfDecl.get(q) ?? []) pushHunk(id);
      for (const e of out.get(q) ?? []) {
        if (e.source === 'naming') naming = true;
        visit(e.to);
      }
    };
    if (hunksOfDecl.has(startDecl)) visit(startDecl);
    for (const q of index.hunkDecls[startHunk] ?? []) visit(q);
    // Call hops from the entry to each hunk, breadth first; ids keeps depth-first call order.
    const dist = new Map<string, number>([[startHunk, 0]]);
    const depth = new Map<string, number>();
    let frontier = [...new Set([...(hunksOfDecl.has(startDecl) ? [startDecl] : []), ...(index.hunkDecls[startHunk] ?? [])])];
    for (let d = 0; frontier.length; d++) {
      const next: string[] = [];
      for (const q of frontier) {
        if (depth.has(q)) continue;
        depth.set(q, d);
        for (const id of hunksOfDecl.get(q) ?? []) if (!dist.has(id)) dist.set(id, d);
        for (const e of out.get(q) ?? []) if (!depth.has(e.to)) next.push(e.to);
      }
      frontier = next;
    }
    return { hunks: ids, decls, naming, dist };
  };

  // Rank entry points by how much changed code they reach.
  const seenEntry = new Set<string>();
  const logicHunkSet = new Set(logicHunks);
  const ranked = index.entries
    .filter((e) => logicHunkSet.has(e.hunkId))
    .filter((e) => {
      const key = `${e.hunkId}|${e.symbol}`;
      if (seenEntry.has(key)) return false;
      seenEntry.add(key);
      return true;
    })
    .map((e, i) => {
      const r = reach(e.hunkId, e.symbol);
      const weight = r.hunks.reduce((s, id) => s + changedCount(hunks[id]), 0);
      // Explicit entries (routes, commands, handlers) beat plain exported APIs at equal reach.
      const explicit = e.reason === 'exported API' ? 0 : 1;
      return { e, r, weight, explicit, i };
    })
    .sort((a, b) => b.weight - a.weight || b.explicit - a.explicit || a.i - b.i);

  // Each hunk belongs to the entry point that reaches it in the fewest call hops (the higher-ranked
  // entry on a tie), so a root like an App component that reaches everything keeps only what sits
  // close to it, and each part of the change stays with the entry nearest to it.
  const entries = ranked.filter((x, i) => ranked.findIndex((y) => y.e.hunkId === x.e.hunkId) === i);
  const owner = new Map<string, string>(); // hunkId -> chapterId
  const best = new Map<string, { entry: number; dist: number }>();
  entries.forEach(({ r }, entry) => {
    for (const [id, dist] of r.dist) {
      const b = best.get(id);
      if (!b || dist < b.dist) best.set(id, { entry, dist });
    }
  });
  const groups = new Map<number, Set<string>>();
  for (const [id, { entry }] of best) {
    const g = groups.get(entry) ?? new Set<string>();
    g.add(id);
    groups.set(entry, g);
  }
  const size = (g: Set<string>) => [...g].reduce((n, id) => n + changedCount(hunks[id]), 0);
  // Fold a group into the nearest group whose entry reaches its entry point, so a helper reads
  // with its caller instead of as a chapter of its own: any small group, and a mid-sized one its
  // caller calls directly while the result stays readable. Smallest first, until none is left.
  const foldTarget = (entry: number, g: Set<string>): number | undefined => {
    const start = entries[entry].e.hunkId;
    const n = size(g);
    let into: number | undefined;
    let intoDist = Infinity;
    for (const [other, og] of groups) {
      if (other === entry) continue;
      const d = entries[other].r.dist.get(start);
      if (d === undefined) continue;
      if (n >= MIN_FLOW_LINES && (n >= FOLD_FLOW_LINES || d > 1 || size(og) + n > MAX_FOLDED_LINES)) continue;
      if (d < intoDist || (d === intoDist && other < into!)) [into, intoDist] = [other, d];
    }
    return into;
  };
  for (;;) {
    const order = [...groups].sort((a, b) => size(a[1]) - size(b[1]) || b[0] - a[0]);
    const hit = order.map(([entry, g]) => [entry, g, foldTarget(entry, g)] as const).find(([, , into]) => into !== undefined);
    if (!hit) break;
    const [entry, g, into] = hit;
    for (const id of g) groups.get(into!)!.add(id);
    groups.delete(entry);
  }
  // Next to a real flow, a small change no other changed code calls is a helper, not a flow: it goes
  // to supporting changes. A PR of only small changes keeps each as its own flow.
  if ([...groups.values()].some((g) => size(g) >= MIN_FLOW_LINES)) for (const [entry, g] of groups) if (size(g) < MIN_FLOW_LINES) groups.delete(entry);

  const flows: Chapter[] = [];
  const entryHunkOf = new Map<string, string>(); // chapterId -> its entry point's hunk
  for (const [entry, g] of [...groups].sort((a, b) => a[0] - b[0])) {
    const { e, r } = entries[entry];
    const id = nextId();
    const reachOrder = new Map(r.hunks.map((h, i) => [h, i]));
    // Hunks folded in from a helper's group follow the entry's own call order, then line order.
    const own = [...g].sort((a, b) => (reachOrder.get(a) ?? Infinity) - (reachOrder.get(b) ?? Infinity) || logicHunks.indexOf(a) - logicHunks.indexOf(b));
    const ordered = typesBeforeFirstUse(own, hunks, index);
    const orderedSet = new Set(ordered);
    for (const h of ordered) owner.set(h, id);
    // Hunks this flow calls directly that another chapter shows.
    const linked = r.hunks.filter((h) => !g.has(h) && (r.dist.get(h) ?? Infinity) <= 1);
    const ch = newChapter(id, 'flow', titleFor(e.reason, e.symbol), ordered, hunks);
    const name = entryName(e.reason, e.symbol);
    ch.entryPoint = name ? `${e.reason} (${name})` : e.reason;
    entryHunkOf.set(id, e.hunkId);
    ch.linkedHunkIds = linked;
    ch.untestedBranches = untestedBranches(ordered, hunks);
    ch.lowConfidence = r.naming || index.lowConfidence || undefined;
    ch.diagram =
      callDiagram(ch.title, [...ordered, ...linked], index, declByQ) ??
      stateDiagram(ch.title, ordered, hunks, index, declByQ) ??
      entityDiagram(
        ch.title,
        files.filter((f) => f.hunkIds.some((h) => orderedSet.has(h))),
        hunks,
      );
    flows.push(ch);
  }

  // Code moved out of a file reads best next to where it came from: a hunk whose added lines are
  // mostly lines another file's hunk deletes joins that hunk's flow, right after it.
  const flowOf = new Map(flows.map((c) => [c.id, c]));
  for (const [moved, from] of movedFrom(logicHunks, hunks)) {
    const dest = flowOf.get(owner.get(from) ?? '');
    const origin = flowOf.get(owner.get(moved) ?? '');
    if (!dest || dest === origin) continue;
    // A flow whose entry point moved goes along whole: the rest is there because that entry calls it.
    const carried = origin && entryHunkOf.get(origin.id) === moved ? [moved, ...origin.hunkIds.filter((id) => id !== moved)] : [moved];
    if (origin) {
      origin.hunkIds = origin.hunkIds.filter((id) => !carried.includes(id));
      origin.risk = maxRisk(origin.hunkIds, hunks);
    }
    dest.hunkIds.splice(dest.hunkIds.indexOf(from) + 1, 0, ...carried);
    dest.risk = maxRisk(dest.hunkIds, hunks);
    for (const id of carried) owner.set(id, dest.id);
  }
  for (let i = flows.length - 1; i >= 0; i--) if (!flows[i].hunkIds.length) flows.splice(i, 1);

  if (logicHunks.length && !flows.length) {
    notes.push('No entry point found: chapters use file order by kind.');
    flags.push({ kind: 'no-entry-point', message: 'No entry point found; logic is shown in file order.' });
    const ch = newChapter(nextId(), 'flow', 'Hand-written logic (file order)', logicHunks, hunks);
    ch.untestedBranches = untestedBranches(logicHunks, hunks);
    ch.lowConfidence = true;
    ch.diagram = entityDiagram(ch.title, logicFiles, hunks) ?? depsDiagram(ch.title, logicFiles, hunks);
    for (const h of logicHunks) owner.set(h, ch.id);
    flows.push(ch);
  }
  chapters.push(...flows);

  const orphans = logicHunks.filter((id) => !owner.has(id));
  if (orphans.length) {
    const orphanSet = new Set(orphans);
    const ch = newChapter(nextId(), 'supporting', 'Supporting changes', orphans, hunks);
    for (const id of orphans) {
      const decls = (index.hunkDecls[id] ?? []).map((q) => declByQ.get(q)).filter((d): d is Decl => !!d);
      ch.orphanReasons[id] = orphanReason(hunks[id], fileOf.get(id), decls);
    }
    ch.untestedBranches = untestedBranches(orphans, hunks);
    ch.diagram = entityDiagram(
      ch.title,
      files.filter((f) => f.hunkIds.some((h) => orphanSet.has(h))),
      hunks,
    );
    chapters.push(ch);
  }

  // A changed test file's diff joins the flow chapter whose code it tests, after that chapter's
  // code; the tests panel shows only the lines inside linked test cases, so helpers, fixtures and
  // removed cases would otherwise never be seen. Tests of supporting code, and tests whose code did
  // not change, get a chapter of their own.
  const flowById = new Map(flows.map((c) => [c.id, c]));
  const testOnly: string[] = [];
  let pairedLeft = false;
  for (const f of sorted) {
    if (f.kind !== 'test') continue;
    const ids = f.hunkIds.filter((id) => hunks[id] && !special.has(id));
    if (!ids.length) continue;
    const { paired, chapterId } = pairedChapter(f, logicFiles, hunks, owner);
    const flow = chapterId ? flowById.get(chapterId) : undefined;
    if (flow) {
      flow.hunkIds.push(...ids);
      flow.risk = maxRisk(flow.hunkIds, hunks);
    } else {
      testOnly.push(...ids);
      if (paired) pairedLeft = true;
    }
  }
  if (testOnly.length) {
    const ch = newChapter(nextId(), 'tests', pairedLeft ? 'Test changes' : 'Test-only changes', testOnly, hunks);
    ch.summary = pairedLeft
      ? 'Tests of supporting code, and tests changed without changes to the code they cover. Check none were loosened.'
      : 'Tests changed without changes to the code they cover. Check none were loosened.';
    chapters.push(ch);
  }

  for (const sc of SPECIAL_CHAPTERS) {
    const ids = [...special].filter(([, k]) => k === sc.kind).map(([id]) => id);
    if (!ids.length) continue;
    const ch = newChapter(nextId(), sc.kind, sc.title, ids, hunks);
    ch.collapsed = sc.collapsed;
    if (sc.collapsed)
      ch.summary = sorted
        .filter((f) => f.hunkIds.some((id) => special.get(id) === sc.kind))
        .map((f) => `${f.path}${f.summary ? `: ${f.summary}` : ''}`)
        .join('\n');
    chapters.push(ch);
  }

  for (const lp of LOW_PRIORITY) {
    const fs = sorted.filter((f) => f.kind === lp.kind && f.hunkIds.some((id) => !special.has(id)));
    if (!fs.length) continue;
    const ids = fs.flatMap((f) => f.hunkIds).filter((id) => hunks[id] && !special.has(id));
    const ch = newChapter(nextId(), lp.chapter, lp.title, ids, hunks);
    ch.collapsed = lp.collapsed;
    ch.summary = fs.map((f) => `${f.path}${f.summary ? `: ${f.summary}` : ''}`).join('\n');
    if (lp.kind === 'config') ch.diagram = entityDiagram(ch.title, fs, hunks);
    chapters.push(ch);
  }

  return { chapters, overview: overviewGraph(flows, files, hunks, index), notes, flags };
}

function overviewGraph(flows: Chapter[], files: DiffFile[], hunks: Record<string, Hunk>, index: SymbolIndex): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const real = flows.filter((f) => f.entryPoint);
  // Qualified names with at least one function-like declaration.
  const fnDecls = new Set(index.decls.filter((d) => !['type', 'interface', 'enum', 'const', 'class'].includes(d.kind)).map((d) => d.qualified));
  const isFn = (q: string) => fnDecls.has(q);
  for (const f of real) {
    nodes.push({ id: f.id, label: f.title, changed: true, hunkId: f.hunkIds[0] });
    const decls = [...new Set(f.hunkIds.flatMap((id) => index.hunkDecls[id] ?? []))];
    const key = decls.filter((q) => isFn(q) && !f.title.includes(shortName(q)));
    for (const q of key.slice(0, 3)) {
      const nid = `${f.id}:${q}`;
      nodes.push({ id: nid, label: shortName(q), changed: true, hunkId: f.hunkIds.find((h) => index.hunkDecls[h]?.includes(q)) });
      edges.push({ from: f.id, to: nid });
    }
  }
  const hunkSets = new Map(real.map((f) => [f, new Set(f.hunkIds)]));
  for (const f of real) {
    for (const other of real) {
      if (other === f) continue;
      const otherHunks = hunkSets.get(other)!;
      if (f.linkedHunkIds.some((h) => otherHunks.has(h))) edges.push({ from: f.id, to: other.id, label: 'shares' });
    }
  }
  if (!real.length) {
    const deps = depsDiagram('Overview', files, hunks);
    if (deps) return { ...deps, title: 'Overview: import changes' };
    const dirs = new Map<string, { count: number; hunkId?: string }>();
    for (const f of files) {
      const top = f.path.includes('/') ? f.path.split('/')[0] : '.';
      const d = dirs.get(top) ?? { count: 0, hunkId: f.hunkIds[0] };
      d.count += f.additions + f.deletions;
      dirs.set(top, d);
    }
    nodes.push({ id: 'pr', label: 'This PR', changed: false });
    for (const [dir, d] of [...dirs].sort((a, b) => b[1].count - a[1].count).slice(0, 8)) {
      nodes.push({ id: `dir:${dir}`, label: `${dir === '.' ? '(root)' : `${dir}/`} ${d.count} line${d.count === 1 ? '' : 's'}`, changed: true, hunkId: d.hunkId });
      edges.push({ from: 'pr', to: `dir:${dir}` });
    }
  }
  return { kind: 'call', title: 'Overview', nodes, edges };
}

export function fileOrderChapters(files: DiffFile[], hunks: Record<string, Hunk>): Chapter[] {
  const map: Record<FileKind, ChapterKind> = {
    logic: 'flow',
    test: 'tests',
    config: 'config',
    mechanical: 'mechanical',
    generated: 'generated',
    vendored: 'vendored',
  };
  return [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f, i) => {
      const ids = f.hunkIds.filter((id) => hunks[id]);
      const sk = SPECIAL_CHAPTERS.find((c) => ids.some((id) => specialKindOf(f, hunks[id]) === c.kind));
      const ch = newChapter(`f${i + 1}`, sk?.kind ?? map[f.kind], f.path, ids, hunks);
      ch.collapsed = sk ? sk.collapsed : f.kind === 'mechanical' || f.kind === 'generated' || f.kind === 'vendored';
      ch.optional = ids.length > 0 && ids.every((id) => hunks[id].importOnly);
      if (f.summary) ch.summary = f.summary;
      return ch;
    });
}

// Large PRs: one supporting chapter per directory, keyed by the first two path segments (so
// packages/foo and packages/bar split apart), so the tour can be read and delegated a part at a time.
export function splitByDirectory(chapters: Chapter[], hunks: Record<string, Hunk>): Chapter[] {
  return chapters.flatMap((c) => {
    if (c.kind !== 'supporting') return [c];
    const groups = new Map<string, string[]>();
    for (const id of c.hunkIds) {
      const parts = hunks[id]?.file.split('/') ?? [];
      const dir = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length > 1 ? parts[0] : '(root)';
      const group = groups.get(dir);
      if (group) group.push(id);
      else groups.set(dir, [id]);
    }
    if (groups.size < 2) return [c];
    return [...groups.entries()].map(([dir, ids], i) => {
      const own = new Set(ids);
      const files = new Set(ids.map((id) => hunks[id]?.file).filter((f): f is string => !!f));
      return {
        ...c,
        id: `${c.id}-${i + 1}`,
        title: `Supporting changes: ${dir}`,
        hunkIds: ids,
        risk: maxRisk(ids, hunks),
        orphanReasons: Object.fromEntries(Object.entries(c.orphanReasons).filter(([id]) => own.has(id))),
        linkedHunkIds: c.linkedHunkIds.filter((id) => files.has(hunks[id]?.file ?? '')),
        // Branches read `file:line text`.
        untestedBranches: c.untestedBranches.filter((b) => [...files].some((f) => b.startsWith(`${f}:`))),
        // The parent's diagram spans every directory.
        diagram: undefined,
      };
    });
  });
}
