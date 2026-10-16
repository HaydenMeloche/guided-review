import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { escapeRe } from '../util/regex.js';
import { isImportLine } from './imports.js';
import { MIGRATION_PATH, sqlTableRefs } from './patterns.js';
import type { BlastItem, CallerRef, Hunk } from '../types.js';
import type { Decl, SymbolIndex } from './symbols.js';

const MAX_CALLERS = 20;
const MAX_SYMBOLS = 30;
const MAX_STRING_REFS = 10;
// Data and docs mention names without calling them.
const NOT_CODE = [':!*.json', ':!*.md', ':!*.mdx', ':!*.lock', ':!*.yaml', ':!*.yml', ':!*.snap', ':!*.txt', ':!*.svg'];

interface GrepLine {
  ref: CallerRef;
  raw: string; // the full matched line, before trimming and truncation
}

// Streams `git grep -n -I <args>` and hands each match to `onLine` in git's (file, line) order.
// `onLine` returns false once it needs no more lines, which stops the grep early.
// Resolves false when git fails (other than "no matches"), so callers can drop partial results.
function streamGitGrep(root: string, args: string[], onLine: (line: GrepLine) => boolean, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let stopped = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['grep', '-n', '-I', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], signal });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(stopped));
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (stopped || !line) return;
      const m = /^([^:]+):(\d+):(.*)$/.exec(line);
      if (!m) return;
      if (!onLine({ ref: { file: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 200) }, raw: m[3] })) {
        stopped = true;
        rl.close();
        child.kill();
      }
    });
    // git grep exits 1 when nothing matches.
    child.on('close', (code) => resolve(stopped || code === 0 || code === 1));
  });
}

// git grep -w counts only ASCII letters, digits and underscore as word characters.
const GIT_WORD = /[A-Za-z0-9_]+/g;
const PLAIN_WORD = /^[A-Za-z0-9_]+$/;

// Returns a function that lists which `names` occur in a line as whole words, with git grep -w's
// word boundaries. This splits one combined `git grep -w -e a -e b` back into per-name results.
// With `ignoreCase`, plain names are matched and reported lowercased.
export function wordMatcher(names: Iterable<string>, ignoreCase = false): (text: string) => Set<string> {
  const norm = (s: string) => (ignoreCase ? s.toLowerCase() : s);
  const plain = new Set<string>();
  const other: [string, RegExp][] = [];
  for (const n of names) {
    if (PLAIN_WORD.test(n)) plain.add(norm(n));
    else other.push([n, new RegExp(`(?<![A-Za-z0-9_])${escapeRe(n)}(?![A-Za-z0-9_])`, ignoreCase ? 'i' : '')]);
  }
  return (text) => {
    const hits = new Set<string>();
    if (plain.size) {
      for (const tok of text.match(GIT_WORD) ?? []) {
        const t = norm(tok);
        if (plain.has(t)) hits.add(t);
      }
    }
    for (const [n, re] of other) if (re.test(text)) hits.add(n);
    return hits;
  };
}

// A hunk that touches the declaration's first line (or its parameter list) changes the signature.
function changesSignature(h: Hunk, d: Decl): boolean {
  const near = (n?: number) => n !== undefined && n >= d.startLine && n <= d.startLine + 1;
  return h.lines.some((l) => (l.kind === 'add' && near(l.newLine)) || (l.kind === 'del' && near(l.oldLine)));
}

export function isDefinition(text: string, name: string): boolean {
  const n = name.replace(/[$]/g, '\\$');
  return new RegExp(`\\b(function|class|interface|type|enum|def|func|fn)\\s+${n}\\b|\\b(const|let|var)\\s+${n}\\s*=`).test(text);
}

interface Target {
  symbol: string;
  hunkId: string;
  key: string; // the bucket a grep line must fall in
  accept: (ref: CallerRef) => boolean;
  callers: CallerRef[];
}

// Runs one grep for all targets and fills each target's callers, capped and in git's order,
// exactly as one grep per target would. A failed grep leaves every target empty.
async function grepTargets(root: string, args: string[], targets: Target[], keysIn: (raw: string) => Set<string>, signal?: AbortSignal): Promise<void> {
  if (!targets.length) return;
  let open = targets.length;
  const ok = await streamGitGrep(
    root,
    args,
    ({ ref, raw }) => {
      const keys = keysIn(raw);
      if (!keys.size) return true;
      for (const t of targets) {
        if (t.callers.length >= MAX_CALLERS || !keys.has(t.key) || !t.accept(ref)) continue;
        t.callers.push(ref);
        if (t.callers.length >= MAX_CALLERS) open--;
      }
      return open > 0;
    },
    signal,
  );
  if (!ok) for (const t of targets) t.callers.length = 0;
}

export async function findBlastRadius(root: string, hunks: Record<string, Hunk>, index: SymbolIndex, changedFiles: string[], signal?: AbortSignal): Promise<BlastItem[]> {
  const changed = new Set(changedFiles);
  const declByQ = new Map<string, Decl>();
  for (const d of index.decls) if (!declByQ.has(d.qualified) || d.side === 'head') declByQ.set(d.qualified, d);

  const candidates: { d: Decl; hunkId: string; sig: boolean }[] = [];
  const seen = new Set<string>();
  for (const [hunkId, qs] of Object.entries(index.hunkDecls)) {
    for (const q of qs) {
      const d = declByQ.get(q);
      if (!d || !d.exported) continue;
      if (seen.has(q)) continue;
      seen.add(q);
      const h = hunks[hunkId];
      candidates.push({ d, hunkId, sig: !!h && changesSignature(h, d) });
    }
  }
  candidates.sort((a, b) => Number(b.sig) - Number(a.sig));

  const symbols: Target[] = candidates
    .slice(0, MAX_SYMBOLS)
    .filter(({ d }) => d.name !== 'constructor' && d.name.length >= 3)
    .map(({ d, hunkId }) => ({
      symbol: d.qualified.split('#')[1] ?? d.name,
      hunkId,
      key: d.name,
      // An import line names the symbol but is not a use; the use elsewhere in the file is listed instead.
      accept: (r) => !changed.has(r.file) && r.file !== d.file && !isDefinition(r.text, d.name) && !isImportLine(r.text),
      callers: [],
    }));
  const names = [...new Set(symbols.map((s) => s.key))];

  // Changed tables and emitted events reach code by string, not by symbol.
  const tableIds = new Map<string, string>();
  const eventIds = new Map<string, string>();
  for (const h of Object.values(hunks)) {
    for (const l of h.lines) {
      if (l.kind === 'ctx') continue;
      for (const t of sqlTableRefs(l.text)) tableIds.set(t.table, h.id);
      for (const m of l.text.matchAll(/\b(?:emit|publish|dispatch)\(\s*['"]([\w:.-]+)['"]/g)) eventIds.set(m[1], h.id);
    }
  }
  const tableNames = [...tableIds.keys()].slice(0, MAX_STRING_REFS);
  const tables: Target[] = tableNames.map((table) => ({
    symbol: `table ${table}`,
    hunkId: tableIds.get(table)!,
    key: table.toLowerCase(), // -i: the matcher reports names lowercased
    accept: (r) => !changed.has(r.file) && !MIGRATION_PATH.test(r.file),
    callers: [],
  }));
  const eventNames = [...eventIds.keys()].slice(0, MAX_STRING_REFS);
  const events: Target[] = eventNames.map((event) => ({
    symbol: `event ${event}`,
    hunkId: eventIds.get(event)!,
    key: event,
    accept: (r) => !changed.has(r.file) && /\.(on|once|subscribe|addEventListener|addListener)\(|@OnEvent/.test(r.text),
    callers: [],
  }));

  await Promise.all([
    grepTargets(root, ['-w', ...names.flatMap((n) => ['-e', n]), '--', '.', ...NOT_CODE], symbols, wordMatcher(names), signal),
    grepTargets(root, ['-i', '-w', ...tableNames.flatMap((t) => ['-e', t]), '--'], tables, wordMatcher(tableNames, true), signal),
    grepTargets(
      root,
      ['-F', ...eventNames.flatMap((e) => ['-e', `'${e}'`, '-e', `"${e}"`]), '--'],
      events,
      (raw) => new Set(eventNames.filter((e) => raw.includes(`'${e}'`) || raw.includes(`"${e}"`))),
      signal,
    ),
  ]);

  return [...symbols, ...tables, ...events].filter((t) => t.callers.length).map(({ symbol, hunkId, callers }) => ({ symbol, hunkId, callers }));
}
