import { createRequire } from 'node:module';
import type TS from 'typescript';
import type { DiffFile, Hunk } from '../types.js';
import { familyOf, languageOf } from '../util/language.js';
import { GO_ROUTE, PY_DECORATOR_ROUTE } from './patterns.js';
import { parseWithTreeSitter, supportsTreeSitter } from './treesitter.js';

export type DeclKind = 'function' | 'method' | 'class' | 'type' | 'interface' | 'enum' | 'const' | 'route' | 'command' | 'handler' | 'component';

export interface Decl {
  name: string;
  qualified: string; // file#Name or file#Class.method
  file: string;
  kind: DeclKind;
  startLine: number;
  endLine: number;
  exported: boolean;
  calls: string[];
  side: 'head' | 'base';
}

export interface CallEdge {
  from: string;
  to: string;
  source: 'name-match' | 'naming';
}

interface EntryCandidate {
  hunkId: string;
  symbol: string; // qualified name
  reason: string;
}

export interface SymbolIndex {
  decls: Decl[];
  hunkDecls: Record<string, string[]>;
  edges: CallEdge[];
  entries: EntryCandidate[];
  typeDecls: Set<string>;
  lowConfidence: boolean;
}

export interface EntryHint {
  line: number;
  reason: string;
  handler?: string; // name of the referenced handler, when the entry passes one
}

export interface FileSymbols {
  decls: Decl[];
  entries: EntryHint[];
}

// The compiler takes ~120 ms to load, so it is loaded on the first TS/JS parse rather than at
// startup; commands that never parse (like the PR picker) skip it. Parsing is synchronous, so
// this uses require rather than a dynamic import.
let ts: typeof TS;
function loadTs(): typeof TS {
  ts ??= createRequire(import.meta.url)('typescript') as typeof TS;
  return ts;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const NEXT_HANDLERS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function scriptKind(path: string): TS.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function hasExport(node: TS.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function containsJsx(node: TS.Node): boolean {
  let found = false;
  const visit = (n: TS.Node) => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function calleeName(expr: TS.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isElementAccessExpression(expr) && ts.isStringLiteral(expr.argumentExpression)) {
    return expr.argumentExpression.text;
  }
  return undefined;
}

function collectCalls(node: TS.Node): string[] {
  const out = new Set<string>();
  const visit = (n: TS.Node) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n.expression);
      if (name) out.add(name);
      // Function references passed as arguments count as calls (callbacks, handlers).
      for (const a of n.arguments) if (ts.isIdentifier(a)) out.add(a.text);
    } else if (ts.isNewExpression(n)) {
      const name = calleeName(n.expression);
      if (name) out.add(name);
    } else if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText();
      if (/^[A-Z]/.test(tag)) out.add(tag.split('.').pop()!);
    } else if (ts.isTypeReferenceNode(n)) {
      // Type uses are tracked as references so type changes link to their users.
      const tn = n.typeName;
      out.add(ts.isIdentifier(tn) ? tn.text : tn.right.text);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return [...out];
}

function stringArg(call: TS.CallExpression, i: number): string | undefined {
  const a = call.arguments[i];
  if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) return a.text;
  return undefined;
}

function lastIdentifierArg(call: TS.CallExpression): string | undefined {
  for (let i = call.arguments.length - 1; i >= 0; i--) {
    const a = call.arguments[i];
    if (ts.isIdentifier(a)) return a.text;
    if (ts.isPropertyAccessExpression(a)) return a.name.text;
  }
  return undefined;
}

// Recognizes route registrations, CLI commands, event handlers and cron jobs.
function entryFromCall(call: TS.CallExpression): { reason: string; handler?: string } | undefined {
  const expr = call.expression;
  if (ts.isPropertyAccessExpression(expr)) {
    const method = expr.name.text;
    const target = expr.expression.getText();
    const first = stringArg(call, 0);
    if (HTTP_METHODS.has(method) && first?.startsWith('/') && call.arguments.length >= 2) {
      return { reason: `route ${method.toUpperCase()} ${first}`, handler: lastIdentifierArg(call) };
    }
    if (method === 'route' && first?.startsWith('/')) return { reason: `route ${first}` };
    if (method === 'command' && first !== undefined) {
      return { reason: `CLI command ${first.split(' ')[0]}`, handler: lastIdentifierArg(call) };
    }
    if ((method === 'on' || method === 'once' || method === 'addEventListener' || method === 'subscribe') && first) {
      return { reason: `event handler '${first}'`, handler: lastIdentifierArg(call) };
    }
    if (method === 'schedule' && /cron/i.test(target)) {
      return { reason: `cron job ${first ?? ''}`.trim(), handler: lastIdentifierArg(call) };
    }
    if (method === 'action' && /command/.test(target)) {
      return { reason: 'CLI command', handler: lastIdentifierArg(call) };
    }
  }
  return undefined;
}

function decoratorEntry(node: TS.Node): string | undefined {
  const decs = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  for (const d of decs ?? []) {
    const text = d.expression.getText();
    if (/^Cron\b/.test(text)) return 'cron job';
    const m = /^(Get|Post|Put|Patch|Delete)\(\s*['"`]?([^'"`)]*)/.exec(text);
    if (m) return `route ${m[1].toUpperCase()} ${m[2] || '/'}`;
    if (/^(OnEvent|EventPattern|MessagePattern|Subscribe)\b/.test(text)) return 'event handler';
    if (/^Command\b/.test(text)) return 'CLI command';
  }
  return undefined;
}

export function parseTsSymbols(path: string, text: string, side: 'head' | 'base'): FileSymbols {
  loadTs();
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const decls: Decl[] = [];
  const entries: EntryHint[] = [];
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const add = (name: string, node: TS.Node, kind: DeclKind, exported: boolean, owner?: string) => {
    const startLine = lineOf(node.getStart(sf));
    const endLine = lineOf(node.getEnd());
    const qualified = `${path}#${owner ? `${owner}.` : ''}${name}`;
    const calls = kind === 'type' || kind === 'interface' || kind === 'enum' ? [] : collectCalls(node);
    decls.push({ name, qualified, file: path, kind, startLine, endLine, exported, calls, side });
    return startLine;
  };

  const fnKind = (name: string, body: TS.Node): DeclKind => {
    if (/^[A-Z]/.test(name) && containsJsx(body)) return 'component';
    return 'function';
  };

  const visitTop = (node: TS.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.text;
      const exported = hasExport(node);
      const kind = NEXT_HANDLERS.has(name) && exported ? 'route' : fnKind(name, node);
      const line = add(name, node, kind, exported);
      if (kind === 'route') entries.push({ line, reason: `route ${name} (${path})` });
    } else if (ts.isClassDeclaration(node) && node.name) {
      const cls = node.name.text;
      const exported = hasExport(node);
      add(cls, node, 'class', exported);
      for (const m of node.members) {
        if ((ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)) && m.name) {
          const mname = m.name.getText(sf);
          const line = add(mname, m, 'method', exported, cls);
          const reason = decoratorEntry(m);
          if (reason) entries.push({ line, reason });
        } else if (ts.isPropertyDeclaration(m) && m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer))) {
          add(m.name.getText(sf), m, 'method', exported, cls);
        } else if (ts.isConstructorDeclaration(m)) {
          add('constructor', m, 'method', exported, cls);
        }
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      add(node.name.text, node, 'interface', hasExport(node));
    } else if (ts.isTypeAliasDeclaration(node)) {
      add(node.name.text, node, 'type', hasExport(node));
    } else if (ts.isEnumDeclaration(node)) {
      add(node.name.text, node, 'enum', hasExport(node));
    } else if (ts.isVariableStatement(node)) {
      const exported = hasExport(node);
      for (const d of node.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const name = d.name.text;
        const init = d.initializer;
        const target = node.declarationList.declarations.length === 1 ? node : d;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          const kind = NEXT_HANDLERS.has(name) && exported ? 'route' : fnKind(name, init);
          const line = add(name, target, kind, exported);
          if (kind === 'route') entries.push({ line, reason: `route ${name} (${path})` });
        } else {
          add(name, target, 'const', exported);
        }
      }
    }
  };
  sf.statements.forEach(visitTop);

  // Registrations anywhere in the file (app.get('/x', handler), program.command('sync'), ...).
  const visitAll = (n: TS.Node) => {
    if (ts.isCallExpression(n)) {
      const e = entryFromCall(n);
      if (e) entries.push({ line: lineOf(n.getStart(sf)), reason: e.reason, handler: e.handler });
    }
    ts.forEachChild(n, visitAll);
  };
  visitAll(sf);
  return { decls, entries };
}

// Regex fallback for languages without a parser here. Declarations end where the
// next one at the same or lower indent begins.
const JVM_LIKE = ['java', 'kotlin', 'csharp', 'scala'];
const FALLBACK_DECL: { langs: string[]; re: RegExp; kind: DeclKind }[] = [
  { langs: ['python'], re: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, kind: 'function' },
  { langs: ['python'], re: /^(\s*)class\s+([A-Za-z_]\w*)/, kind: 'class' },
  { langs: ['go'], re: /^()func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[([]/, kind: 'function' },
  { langs: ['go'], re: /^()type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, kind: 'type' },
  { langs: ['rust'], re: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function' },
  { langs: ['rust'], re: /^(\s*)(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/, kind: 'type' },
  { langs: ['ruby'], re: /^(\s*)def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/, kind: 'function' },
  { langs: ['ruby'], re: /^(\s*)(?:class|module)\s+([A-Z]\w*)/, kind: 'class' },
  {
    langs: JVM_LIKE,
    re: /^(\s*)(?:(?:public|private|protected|static|final|override|suspend|internal|async|virtual)\s+)*(?:fun\s+)?[\w<>[\],.? ]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:[:\w<>?, ]*)?\{?\s*$/,
    kind: 'method',
  },
  { langs: JVM_LIKE, re: /^(\s*)(?:(?:public|private|protected|abstract|final|data|sealed)\s+)*(?:class|interface|enum|object)\s+([A-Za-z_]\w*)/, kind: 'class' },
  { langs: ['c', 'cpp'], re: /^()[\w*\s]+?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/, kind: 'function' },
];

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'catch', 'func', 'def', 'fn', 'new', 'else', 'sizeof', 'print', 'super']);

export function parseFallbackSymbols(path: string, text: string, side: 'head' | 'base'): FileSymbols {
  const lang = languageOf(path)?.id ?? '';
  const rules = FALLBACK_DECL.filter((r) => r.langs.includes(lang));
  const decls: Decl[] = [];
  const entries: EntryHint[] = [];
  if (!rules.length) return { decls, entries };
  const lines = text.split('\n');
  const starts: { line: number; indent: number; name: string; kind: DeclKind }[] = [];
  lines.forEach((l, i) => {
    for (const r of rules) {
      const m = r.re.exec(l);
      if (m && !KEYWORDS.has(m[2])) {
        starts.push({ line: i + 1, indent: m[1].length, name: m[2], kind: r.kind });
        break;
      }
    }
    if (PY_DECORATOR_ROUTE.test(l)) {
      const m = /\(\s*['"]([^'"]+)/.exec(l);
      entries.push({ line: i + 2, reason: `route ${m?.[1] ?? ''}`.trim() });
    }
    if (GO_ROUTE.test(l)) {
      const m = /"([^"]+)"/.exec(l);
      const handler = /,\s*([A-Za-z_][\w.]*)\s*\)/.exec(l)?.[1]?.split('.').pop();
      entries.push({ line: i + 1, reason: `route ${m?.[1] ?? ''}`.trim(), handler });
    }
    if (/@click\.command|@(celery|app)\.task|@cron|cobra\.Command/.test(l)) {
      entries.push({ line: i + 2, reason: /command|cobra/i.test(l) ? 'CLI command' : 'job' });
    }
  });
  starts.forEach((s, i) => {
    let end = lines.length;
    for (let j = i + 1; j < starts.length; j++) {
      if (starts[j].indent <= s.indent) {
        end = starts[j].line - 1;
        break;
      }
    }
    const owner = s.kind === 'function' || s.kind === 'method' ? [...starts.slice(0, i)].reverse().find((p) => p.indent < s.indent && p.kind === 'class')?.name : undefined;
    const body = lines.slice(s.line, end).join('\n');
    const calls = new Set<string>();
    for (const m of body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) if (!KEYWORDS.has(m[1])) calls.add(m[1]);
    const exported =
      lang === 'go' ? /^[A-Z]/.test(s.name) : lang === 'python' ? !s.name.startsWith('_') : lang === 'rust' ? /^\s*pub\b/.test(lines[s.line - 1]) : !/\bprivate\b/.test(lines[s.line - 1]);
    decls.push({
      name: s.name,
      qualified: `${path}#${owner ? `${owner}.` : ''}${s.name}`,
      file: path,
      kind: owner ? 'method' : s.kind,
      startLine: s.line,
      endLine: Math.max(s.line, end),
      exported,
      calls: [...calls],
      side,
    });
  });
  return { decls, entries };
}

function changedLinesOf(h: Hunk): { head: number[]; base: number[] } {
  const head: number[] = [];
  const base: number[] = [];
  for (const l of h.lines) {
    if (l.kind === 'add' && l.newLine) head.push(l.newLine);
    if (l.kind === 'del' && l.oldLine) base.push(l.oldLine);
  }
  return { head, base };
}

function innermost(decls: Decl[], line: number): Decl | undefined {
  let best: Decl | undefined;
  for (const d of decls) {
    if (line >= d.startLine && line <= d.endLine) {
      if (!best || d.endLine - d.startLine < best.endLine - best.startLine) best = d;
    }
  }
  return best;
}

export function buildSymbolIndex(files: DiffFile[], hunks: Record<string, Hunk>, ctx: { readHead: (p: string) => string | undefined; readBase: (p: string) => string | undefined }): SymbolIndex {
  const decls: Decl[] = [];
  const hunkDecls: Record<string, string[]> = {};
  const entries: EntryCandidate[] = [];
  const typeDecls = new Set<string>();
  let lowConfidence = false;
  const changed = new Map<string, Decl>(); // qualified -> decl touched by a hunk
  const entrySymbols = new Set<string>();
  const addEntry = (e: EntryCandidate) => {
    entries.push(e);
    entrySymbols.add(e.symbol);
  };
  const changedVia = new Map<string, 'name-match' | 'naming'>();

  for (const f of files) {
    if (f.kind !== 'logic' && f.kind !== 'test') continue;
    if (f.binary) continue;
    const family = familyOf(f.path);
    const isTs = family === 'js';
    const tree = !isTs && supportsTreeSitter(f.path);
    const parsed = isTs || tree;
    // Code read only by the regex fallback; data and markup (no family) don't lower confidence.
    if (f.kind === 'logic' && !parsed && family) lowConfidence = true;
    const parse = (path: string, text: string | undefined, side: 'head' | 'base'): FileSymbols => {
      if (text === undefined) return { decls: [], entries: [] };
      try {
        if (isTs) return parseTsSymbols(path, text, side);
        if (tree) return parseWithTreeSitter(path, text, side) ?? parseFallbackSymbols(path, text, side);
        return parseFallbackSymbols(path, text, side);
      } catch {
        lowConfidence = true;
        return { decls: [], entries: [] };
      }
    };
    const head = f.status === 'deleted' ? { decls: [], entries: [] } : parse(f.path, ctx.readHead(f.path), 'head');
    const base = f.status === 'added' ? { decls: [], entries: [] } : parse(f.path, ctx.readBase(f.oldPath ?? f.path), 'base');
    // Base decls keep the head path in their qualified name so renamed files line up.
    for (const d of base.decls) {
      d.file = f.path;
      d.qualified = d.qualified.replace(`${f.oldPath ?? f.path}#`, `${f.path}#`);
    }
    decls.push(...head.decls);
    const headNames = new Set(head.decls.map((d) => d.qualified));
    for (const d of base.decls) if (!headNames.has(d.qualified)) decls.push(d);
    const firstByQualified = (ds: Decl[]) => {
      const m = new Map<string, Decl>();
      for (const d of ds) if (!m.has(d.qualified)) m.set(d.qualified, d);
      return m;
    };
    const headByQ = firstByQualified(head.decls);
    const baseByQ = firstByQualified(base.decls);

    for (const hid of f.hunkIds) {
      const h = hunks[hid];
      if (!h) continue;
      const { head: hl, base: bl } = changedLinesOf(h);
      const names = new Set<string>();
      for (const line of hl) {
        const d = innermost(head.decls, line);
        if (d) names.add(d.qualified);
      }
      for (const line of bl) {
        const d = innermost(base.decls, line);
        if (d) names.add(d.qualified);
      }
      // A hunk that only adds/removes whole declarations at top level still maps to them.
      if (!names.size) {
        const d = innermost(head.decls, h.newStart + Math.floor(h.newLines / 2));
        if (d) names.add(d.qualified);
      }
      const list = [...names];
      hunkDecls[hid] = list;
      h.symbols = list.map((q) => q.split('#')[1]);
      for (const q of list) {
        const d = headByQ.get(q) ?? baseByQ.get(q)!;
        changed.set(q, d);
        changedVia.set(q, parsed ? 'name-match' : 'naming');
        if (d.kind === 'type' || d.kind === 'interface' || d.kind === 'enum') typeDecls.add(q);
      }
    }

    if (f.kind !== 'logic') continue;
    const fileHunkIds = f.hunkIds.filter((id) => hunks[id]);
    const firstHunkOfDecl = new Map<string, string>();
    for (const id of fileHunkIds) for (const q of hunkDecls[id] ?? []) if (!firstHunkOfDecl.has(q)) firstHunkOfDecl.set(q, id);
    const hunkForDecl = (q: string) => firstHunkOfDecl.get(q);
    const hunkForLine = (line: number) =>
      fileHunkIds.find((id) => {
        const h = hunks[id];
        return line >= h.newStart - 1 && line <= h.newStart + Math.max(h.newLines, 1);
      });
    for (const e of head.entries) {
      // Prefer the handler's hunk; else the registration line's hunk; else the enclosing decl's.
      const handlerDecl = e.handler ? head.decls.find((d) => d.name === e.handler) : undefined;
      const enclosing = innermost(head.decls, e.line);
      const q = handlerDecl?.qualified ?? enclosing?.qualified;
      const hid = (q && hunkForDecl(q)) ?? hunkForLine(e.line);
      if (!hid) continue;
      const symbol = q && hunkDecls[hid]?.includes(q) ? q : (hunkDecls[hid]?.[0] ?? `${f.path}#${e.reason}`);
      addEntry({ hunkId: hid, symbol, reason: e.reason });
    }
    for (const d of head.decls) {
      if (!changed.has(d.qualified)) continue;
      const hid = hunkForDecl(d.qualified);
      if (!hid || entrySymbols.has(d.qualified)) continue;
      if (d.kind === 'component') addEntry({ hunkId: hid, symbol: d.qualified, reason: 'React component' });
      else if (d.exported && (d.kind === 'function' || d.kind === 'class' || d.kind === 'route')) addEntry({ hunkId: hid, symbol: d.qualified, reason: 'exported API' });
    }
  }

  // Calls are syntactically extracted, but their targets are only name matched.
  const byName = new Map<string, Decl[]>();
  for (const d of changed.values()) {
    const list = byName.get(d.name) ?? [];
    list.push(d);
    byName.set(d.name, list);
  }
  // `changed` holds one decl per qualified name, so each target list has no duplicates.
  const edges: CallEdge[] = [];
  const seen = new Set<string>();
  for (const d of changed.values()) {
    for (const c of d.calls) {
      const targets = byName.get(c);
      // Multiple changed declarations with the same name are ambiguous. Do not
      // turn one call into several convincing but potentially false flow edges.
      if (targets?.length !== 1) continue;
      const t = targets[0];
      if (t.qualified === d.qualified) continue;
      const key = `${d.qualified}->${t.qualified}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const source = changedVia.get(d.qualified) === 'naming' || changedVia.get(t.qualified) === 'naming' ? 'naming' : 'name-match';
      edges.push({ from: d.qualified, to: t.qualified, source });
    }
  }

  return { decls, hunkDecls, edges, entries, typeDecls, lowConfidence };
}
