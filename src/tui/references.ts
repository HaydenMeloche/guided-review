import { spawnSync } from 'node:child_process';
import type { DeclKind } from '../analysis/symbols.js';
import type { RepoIndex, SymbolHit } from '../analysis/repoIndex.js';
import { safeReadFile } from '../analysis/safeRead.js';
import { linesHash, refLabel, refSpans } from '../review/refs.js';
import type { BlastItem, CallerRef, CodeRef, ExistingThread, Hunk, TestLink, Tour } from '../types.js';
import { languageOf } from '../util/language.js';
import { ACTIONS_HINT, mentionItems, referenceTrigger, type Completer, type CompletionItem, type HintPart, type TokenRule } from './completion.js';

// Building the CodeRefs behind code references in the comment composer (an inline code span
// holding a ref's label): from symbols, files, ranges, tests, callers and threads, plus the
// session's recent locations and the `@` completer for people, code and its filters. Every read of
// repository text goes through safeReadFile, so nothing outside the worktree is touched.

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Drawn cyan in the composer: code spans that name one of `refs`; other code stays as typed.
// Matched per wrapped row, so unlike refSpans it does not know about fenced blocks.
export function refHighlight(refs: Pick<CodeRef, 'label'>[]): TokenRule | undefined {
  if (!refs.length) return undefined;
  return { kind: 'ref', pattern: new RegExp(`(?<!\`)\`(?:${refs.map((r) => escapeRe(r.label)).join('|')})\`(?!\`)`, 'g') };
}

// A code span for each label, space-separated: what the composer inserts for references.
export const spansOf = (labels: string[]) => labels.map((l) => `\`${l}\``).join(' ');

// ---------- recent locations ----------

export interface RecentLocation {
  path: string;
  line?: number;
  endLine?: number;
  why: 'dwell' | 'comment' | 'ask' | 'preview' | 'test';
  at: number;
}

export const MAX_RECENT = 50;

// Newest first; revisiting a place moves it to the front instead of repeating it.
export function pushRecent(list: RecentLocation[], loc: Omit<RecentLocation, 'at'>, at = Date.now()): RecentLocation[] {
  const same = (r: RecentLocation) => r.path === loc.path && r.line === loc.line;
  return [{ ...loc, at }, ...list.filter((r) => !same(r))].slice(0, MAX_RECENT);
}

export const recentPaths = (list: RecentLocation[] = []) => [...new Set(list.map((r) => r.path))];

// ---------- reading ----------

// A file's lines in the worktree; a trailing newline adds no empty last line.
export function readLines(root: string | undefined, path: string): string[] | undefined {
  if (!root) return undefined;
  const text = safeReadFile(root, path);
  if (text === undefined) return undefined;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// `path` as committed at `sha`, read through git and bounded like a worktree read. Undefined when
// git cannot read it (not a repository, no such commit or file, too large).
const MAX_BLOB_BYTES = 1024 * 1024;
export function committedLines(root: string | undefined, sha: string, path: string): string[] | undefined {
  if (!root || !path || path.includes('\0')) return undefined;
  const r = spawnSync('git', ['cat-file', 'blob', `${sha}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: MAX_BLOB_BYTES, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.error || r.status !== 0) return undefined;
  const lines = r.stdout.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// A ref's linesHash: the referenced lines, or the whole file.
export function hashOf(lines: string[], start?: number, end?: number): string | undefined {
  if (start === undefined) return linesHash(lines.join('\n'));
  const e = end ?? start;
  if (start < 1 || e < start || e > lines.length) return undefined;
  return linesHash(lines.slice(start - 1, e).join('\n'));
}

// ---------- refs ----------

export type RefInput = Omit<CodeRef, 'id' | 'label' | 'linesHash'> & { symbolKind?: DeclKind };

let seq = 0;
export const newRefId = () => `r_${Date.now().toString(36)}_${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// Same place, same pin: two references to it share one ref and one label.
export const refKey = (r: Pick<CodeRef, 'kind' | 'path' | 'startLine' | 'endLine' | 'commitSha' | 'threadUrl'>) =>
  `${r.kind}:${r.path}:${r.startLine ?? ''}:${r.endLine ?? ''}:${r.commitSha}:${r.threadUrl ?? ''}`;

// A ref labelled against `taken`. When it is pinned to the head its lines are hashed as committed
// there, which is what its permalink shows: in preview mode the worktree may hold uncommitted
// edits. The worktree is the fallback when git cannot read the commit. A base-side ref (deleted
// code) carries no hash.
// `label` keeps one chosen earlier (a completion row shows it before it is picked).
export function makeRef(input: RefInput, ctx: { root?: string; headSha: string; taken: Iterable<string>; label?: string }): CodeRef {
  const { symbolKind, ...rest } = input;
  const ref: CodeRef = { ...rest, id: newRefId(), label: ctx.label ?? refLabel({ ...input, symbolKind }, ctx.taken) };
  if (input.kind !== 'thread' && input.commitSha === ctx.headSha) {
    const lines = committedLines(ctx.root, input.commitSha, input.path) ?? readLines(ctx.root, input.path);
    const hash = lines && (input.kind === 'file' ? hashOf(lines) : hashOf(lines, input.startLine, input.endLine));
    if (hash) ref.linesHash = hash;
  }
  return ref;
}

// Adds `incoming` to `refs` for insertion as code spans. A place the draft already references keeps
// its ref and label; a new one is relabelled so every label stays unique within the draft.
// `labels[i]` is the label to insert for `incoming[i]`.
export function mergeRefs(refs: CodeRef[], incoming: CodeRef[]): { refs: CodeRef[]; labels: string[] } {
  const byKey = new Map(refs.map((r) => [refKey(r), r]));
  const taken = refs.map((r) => r.label);
  const out = [...refs];
  const labels: string[] = [];
  for (const r of incoming) {
    const have = byKey.get(refKey(r));
    if (have) {
      labels.push(have.label);
      continue;
    }
    const label = taken.includes(r.label) ? refLabel(r, taken) : r.label;
    const ref = { ...r, label };
    taken.push(label);
    byKey.set(refKey(ref), ref);
    out.push(ref);
    labels.push(label);
  }
  return { refs: out, labels };
}

const localName = (qualified: string) => qualified.slice(qualified.indexOf('#') + 1);

export const symbolInput = (s: SymbolHit, commitSha: string): RefInput => ({
  kind: 'symbol',
  path: s.file,
  commitSha,
  startLine: s.startLine,
  endLine: s.endLine,
  symbol: localName(s.qualified),
  symbolKind: s.kind,
});

export const fileInput = (path: string, commitSha: string): RefInput => ({ kind: 'file', path, commitSha });

export const rangeInput = (path: string, commitSha: string, startLine: number, endLine = startLine): RefInput => ({
  kind: 'range',
  path,
  commitSha,
  startLine,
  ...(endLine !== startLine ? { endLine } : {}),
});

export const testInput = (t: TestLink, commitSha: string): RefInput => rangeInput(t.testFile, commitSha, t.startLine, t.startLine + Math.max(0, t.lines.length - 1));

export const coversInput = (c: NonNullable<Hunk['covers']>, commitSha: string): RefInput => rangeInput(c.file, commitSha, c.startLine, c.startLine + Math.max(0, c.lines.length - 1));

export const callerInput = (c: CallerRef, commitSha: string): RefInput => rangeInput(c.file, commitSha, c.line);

// A review discussion. GitHub links a thread by its first comment's database id.
export function threadInput(t: ExistingThread, tour: Pick<Tour, 'url' | 'headSha'>): RefInput {
  const first = t.comments[0];
  const line = t.line ?? t.originalLine;
  return {
    kind: 'thread',
    path: t.path,
    commitSha: tour.headSha,
    ...(line !== undefined ? { startLine: line } : {}),
    ...(first?.id && /^\d+$/.test(first.id) ? { threadUrl: `${tour.url}#discussion_r${first.id}` } : {}),
  };
}

export const where = (r: Pick<CodeRef, 'kind' | 'path' | 'startLine' | 'endLine'>) =>
  r.kind === 'file' || r.startLine === undefined ? r.path : `${r.path}:${r.startLine}${r.endLine !== undefined && r.endLine !== r.startLine ? `-${r.endLine}` : ''}`;

// ---------- the reference at the cursor ----------

// Where the reference the cursor is in, or just after, points: `src/x.ts:84-96 @a1b2c3d` or a
// discussion. Undefined when the cursor is on no code span that names a ref.
export function refTarget(body: string, cursor: number, refs: CodeRef[]): string | undefined {
  const at = refSpans(body, refs).find((s) => cursor > s.start && cursor <= s.end);
  if (!at) return undefined;
  if (at.ref.kind === 'thread') return `discussion on ${where(at.ref)}`;
  return `${where(at.ref)} @${at.ref.commitSha.slice(0, 7)}`;
}

// ---------- rows for places to reference ----------

// A place in the `@` list: its row text and what picking it references. `body` is a thread's
// comments, previewed instead of code.
export interface RefRow {
  key: string;
  label: string;
  detail: string;
  input: RefInput;
  body?: string;
}

const matches = (q: string, ...texts: string[]) => !q || texts.some((t) => t.toLowerCase().includes(q.toLowerCase()));
const isIdentifier = (s: string) => /^[\w$]+$/.test(s);

// The tests linked to a hunk, name guesses last, then the code a test hunk covers.
export function testRows(hunk: Hunk | undefined, sha: string): RefRow[] {
  if (!hunk) return [];
  const tests = [...hunk.tests].sort((a, b) => Number(a.source === 'naming') - Number(b.source === 'naming'));
  const rows: RefRow[] = tests.map((t) => ({
    key: `t:${t.testFile}:${t.startLine}`,
    label: `✓ ${t.testName}`,
    detail: `${t.testFile}:${t.startLine}${t.source === 'naming' ? ' · name guess' : ''}`,
    input: testInput(t, sha),
  }));
  if (hunk.covers)
    rows.push({
      key: `cov:${hunk.covers.file}`,
      label: `ƒ ${hunk.covers.symbol ?? 'code it covers'}`,
      detail: `${hunk.covers.file}:${hunk.covers.startLine} · covered`,
      input: coversInput(hunk.covers, sha),
    });
  return rows;
}

export const threadRows = (tour: Pick<Tour, 'url' | 'headSha' | 'existingThreads'>): RefRow[] =>
  tour.existingThreads.map((t) => ({
    key: `th:${t.id}`,
    label: `¶ @${t.comments[0]?.author ?? '?'}: ${(t.comments[0]?.body ?? '').replace(/\s+/g, ' ')}`,
    detail: `${t.path}${(t.line ?? t.originalLine) !== undefined ? `:${t.line ?? t.originalLine}` : ''}${t.isResolved ? ' · resolved' : ''}`,
    input: threadInput(t, tour),
    body: t.comments.map((c) => `@${c.author}: ${c.body}`).join('\n\n'),
  }));

export const recentRows = (list: RecentLocation[], sha: string): RefRow[] =>
  list.map((r) => {
    const input = r.line !== undefined ? rangeInput(r.path, sha, r.line, r.endLine ?? r.line) : fileInput(r.path, sha);
    return { key: `rc:${r.path}:${r.line ?? ''}`, label: `◷ ${where(input)}`, detail: `recent · ${r.why}`, input };
  });

// Call sites found by name, never resolved: always "possible".
export const callerRows = (callers: CallerRef[], of: string, sha: string): RefRow[] =>
  callers.map((c) => ({ key: `c:${c.file}:${c.line}`, label: `↳ ${c.text.trim()}`, detail: `${c.file}:${c.line} · possible caller of ${of}`, input: callerInput(c, sha) }));

// The blast radius's callers of a hunk's symbols that mention `q`.
export const blastRows = (blast: BlastItem[], hunk: Hunk | undefined, sha: string, q = ''): RefRow[] =>
  hunk
    ? blast
        .filter((b) => b.hunkId === hunk.id)
        .flatMap((b) =>
          callerRows(
            b.callers.filter((c) => matches(q, c.file, c.text, b.symbol)),
            b.symbol,
            sha,
          ),
        )
    : [];

// ---------- @ completion ----------

const CALLABLE = new Set<DeclKind>(['function', 'method', 'route', 'command', 'handler']);
const EMPTY_SYMBOLS = 12;
const EMPTY_PEOPLE = 3; // with nothing typed, a few people before the code
const PEOPLE = 5;

// `@<filter>:` narrows the list to one kind of place. A colon is never in a username, so a
// filter lists no people. `files:` and `symbols:` are the long forms of `f:` and `s:`.
type Filter = 'files' | 'symbols' | 'callers' | 'tests' | 'threads' | 'recent';
const FILTER_WORDS: Filter[] = ['files', 'symbols', 'callers', 'tests', 'threads', 'recent'];
const FILTER_OF: Record<string, Filter> = { f: 'files', s: 'symbols', ...Object.fromEntries(FILTER_WORDS.map((w) => [w, w])) };
const FILTER_ROW: Record<Filter, string> = {
  files: 'files in the checkout',
  symbols: 'declarations by name',
  callers: 'possible callers of this code',
  tests: 'tests linked to this change',
  threads: 'existing review threads',
  recent: 'recent places in this review',
};

export function parseFilter(raw: string): { filter?: Filter; query: string } {
  const m = /^([a-z]+):/.exec(raw);
  const filter = m ? FILTER_OF[m[1]] : undefined;
  return m && filter ? { filter, query: raw.slice(m[0].length) } : { query: raw };
}

// The hint's second line while no filter is on: the filters, keywords in cyan.
const NARROW: HintPart[] = [
  { text: 'narrow with  ' },
  { text: 'f:', accent: true },
  { text: ' files  ' },
  { text: 's:', accent: true },
  { text: ' symbols  ' },
  { text: 'callers:', accent: true },
  { text: '  ' },
  { text: 'tests:', accent: true },
  { text: '  ' },
  { text: 'threads:', accent: true },
  { text: '  ' },
  { text: 'recent:', accent: true },
];

export interface RefCompleterEnv {
  index?: RepoIndex;
  root?: string;
  headSha: string;
  mentions?: string[]; // people to offer above the code
  changedFiles?: string[]; // an empty query lists their declarations
  refs: () => CodeRef[]; // the draft's refs at the time of the query
  recent?: () => RecentLocation[];
  attach: (ref: CodeRef) => void;
  // For callers:, tests: and threads:. The anchor is read per query, from the composer's state.
  tour?: Pick<Tour, 'url' | 'blastRadius' | 'existingThreads'>;
  anchor?: () => { hunk?: Hunk; file?: string; line?: number };
}

const preview = (r: RefInput) => ({ path: r.path, ...(r.kind !== 'file' && r.startLine !== undefined ? { startLine: r.startLine, endLine: r.endLine ?? r.startLine } : {}) });

// `@query` lists People (usernames starting with it, at once) then Code: symbols then files,
// searched as typing pauses. With no query, a few people, then recent places, then the changed
// files' declarations. A query that starts a filter's name (`@thr`) offers the filter above
// them. `@f:` lists files, `@s:` symbols, `@callers:` possible callers of the commented code
// (or of a name typed after it), `@tests:` the tests linked to it, `@threads:` the PR's review
// threads and `@recent:` recent places; `@path:84-96` is a range of a file that exists. None of
// these can be a username, so they list no people. Picking a person inserts `@name`; picking
// code adds the ref and inserts its label as a code span. → in the list chooses lines of the
// highlighted code row in its preview instead.
// A query that names a file rather than a symbol: it has a directory, a line range, or ends in a
// known file extension (`stock.ts`). `Other.save` still searches symbols, as `save` is no
// extension. Searching symbols for a path would grep for its extension and parse every hit.
export const pathLike = (query: string) => query.includes('/') || /:\d+(?:-\d+)?$/.test(query) || (/\.[A-Za-z0-9]+$/.test(query) && languageOf(query) !== undefined);

export function referenceCompleter(env: RefCompleterEnv): Completer {
  let running: AbortController | undefined;
  // The declaration `@callers:` last searched callers of, for the hint: known only once found.
  let enclosing: { file?: string; line?: number; name?: string } = {};
  const toItem = (input: RefInput) => {
    const refs = env.refs();
    const existing = refs.find((r) => refKey(r) === refKey(input));
    if (existing) return { insert: `${spansOf([existing.label])} ` };
    // Only the label now; the lines are read and hashed when the row is picked.
    const label = refLabel(
      input,
      refs.map((r) => r.label),
    );
    return { insert: `${spansOf([label])} `, onPick: () => env.attach(makeRef(input, { root: env.root, headSha: env.headSha, taken: [], label })) };
  };
  const item = (input: RefInput, row: { key: string; label: string; detail?: string }): CompletionItem => ({ ...row, ...toItem(input), preview: preview(input), group: 'Code' });
  // A thread previews its comments; it has no lines to pick.
  const rowItem = (r: RefRow): CompletionItem => {
    const it = item(r.input, { key: r.key, label: r.label, detail: r.detail });
    return r.body !== undefined ? { ...it, preview: { path: r.detail, text: r.body } } : it;
  };
  // A filter with nothing to list says why, on a row that leaves the query as it is.
  const none = (raw: string, why: string): CompletionItem => ({ key: '~none', label: `… ${why}`, insert: `@${raw}`, keepOpen: true, group: 'Code' });

  const callerNames = (query: string): string[] => {
    if (isIdentifier(query)) return [query];
    const a = env.anchor?.() ?? {};
    const blast = (env.tour?.blastRadius ?? []).filter((b) => b.hunkId === a.hunk?.id).map((b) => b.symbol);
    if (blast.length) return [...new Set(blast)];
    if (enclosing.name && enclosing.file === a.file && enclosing.line === a.line) return [enclosing.name];
    return a.hunk?.symbols ?? [];
  };
  const describe = (filter: Filter, query: string): string => {
    if (filter === 'callers') {
      const names = callerNames(query);
      return `possible callers of ${names.length ? names.map((n) => `${n}()`).join(', ') : 'this code'} · matched by name`;
    }
    if (filter === 'tests') return 'tests linked to this change';
    if (filter === 'threads') return 'review threads on this PR';
    if (filter === 'recent') return 'recent places in this review';
    return filter;
  };

  // Rows for callers:, tests:, threads: and recent:.
  const filtered = async (filter: Filter, query: string, raw: string, signal: AbortSignal): Promise<CompletionItem[]> => {
    const a = env.anchor?.() ?? {};
    if (filter === 'tests') {
      const rows = testRows(a.hunk, env.headSha).filter((r) => matches(query, r.label, r.detail));
      return rows.length ? rows.map(rowItem) : [none(raw, !a.hunk ? 'tests are listed for line comments' : query ? 'no linked test matches' : 'no tests linked to this code')];
    }
    if (filter === 'threads') {
      const all = env.tour ? threadRows({ ...env.tour, headSha: env.headSha }) : [];
      const rows = all.filter((r) => matches(query, r.label, r.detail, r.body ?? ''));
      return rows.length ? rows.map(rowItem) : [none(raw, all.length ? 'no thread matches' : 'no review threads on this PR')];
    }
    if (filter === 'recent') {
      const all = recentRows(env.recent?.() ?? [], env.headSha);
      const rows = all.filter((r) => matches(query, r.label));
      return rows.length ? rows.map(rowItem) : [none(raw, all.length ? 'no recent place matches' : 'nothing visited yet this session')];
    }
    // callers: the blast radius's callers of the hunk's symbols, then call sites of a typed
    // name, or of the declaration around the anchor when the blast radius knows none.
    const known = blastRows(env.tour?.blastRadius ?? [], a.hunk, env.headSha, query);
    const index = env.index;
    let name = isIdentifier(query) ? query : undefined;
    if (!query && !known.length && index && a.file && a.line !== undefined) {
      const decl = await index.enclosingDecl(a.file, a.line).catch(() => undefined);
      name = decl?.name.split('.').pop();
      enclosing = { file: a.file, line: a.line, name };
    }
    const rows = [...known];
    if (name && index) {
      const seen = new Set(known.map((k) => k.key));
      const hits = await index.possibleCallers(name, { signal, limit: 40 });
      rows.push(...callerRows(hits, name, env.headSha).filter((r) => !seen.has(r.key)));
    }
    return rows.length ? rows.map(rowItem) : [none(raw, query ? 'no possible callers of that name' : 'no possible callers known: type a function name')];
  };

  return {
    trigger: referenceTrigger,
    hint: (it, raw) => {
      // → only does something on a code row.
      const actions = it?.preview && it.preview.text === undefined ? ACTIONS_HINT.replace(' · esc', ' · → pick lines · esc') : ACTIONS_HINT;
      const { filter, query } = parseFilter(raw);
      if (!filter) return { actions, help: NARROW };
      return { actions, help: [{ text: `${describe(filter, query)}${query ? '' : ' · backspace to clear filter'}` }] };
    },
    pendingGroup: 'Code',
    instant: (query) => {
      // A query that starts a filter's name offers the filter; picking it keeps the list open.
      const filters: CompletionItem[] = /^[a-z]{2,}$/i.test(query)
        ? FILTER_WORDS.filter((w) => w.startsWith(query.toLowerCase())).map((w) => ({
            key: `filter:${w}`,
            label: `${w}:`,
            detail: FILTER_ROW[w],
            insert: `@${w}:`,
            keepOpen: true,
            group: 'Filters',
          }))
        : [];
      const people = env.mentions?.length && /^[\w-]*$/.test(query) ? mentionItems(env.mentions, query, query ? PEOPLE : EMPTY_PEOPLE).map((p) => ({ ...p, group: 'People' })) : [];
      return [...filters, ...people];
    },
    lineCount: (path) => readLines(env.root, path)?.length,
    pickLines: (it, start, end) => (it.preview && it.preview.text === undefined ? toItem(rangeInput(it.preview.path, env.headSha, start, end)) : undefined),
    items: async (raw) => {
      running?.abort();
      const abort = new AbortController();
      running = abort;
      const index = env.index;
      const { filter, query } = parseFilter(raw);
      const recentList = env.recent?.() ?? [];
      const recent = recentPaths(recentList);
      const out: CompletionItem[] = [];
      try {
        if (filter && filter !== 'files' && filter !== 'symbols') return await filtered(filter, query, raw, abort.signal);
        if (!raw) out.push(...recentRows(recentList.slice(0, 6), env.headSha).map(rowItem));
        const range = /^(.+):(\d+)(?:-(\d+))?$/.exec(query);
        if (range && !filter) {
          const [, path, s, e] = range;
          const start = Number(s);
          const end = e ? Number(e) : start;
          const lines = readLines(env.root, path);
          if (lines && start >= 1 && end >= start && end <= lines.length)
            out.push(item(rangeInput(path, env.headSha, start, end), { key: `r:${query}`, label: `▭ ${path}:${start}${end !== start ? `-${end}` : ''}`, detail: 'range' }));
        }
        if (!index) return out;
        const symbolRow = (s: SymbolHit) =>
          item(symbolInput(s, env.headSha), {
            key: `s:${s.file}:${s.startLine}:${s.name}`,
            label: `${CALLABLE.has(s.kind) ? 'ƒ' : '◆'} ${s.name}`,
            detail: [s.kind, s.owner ?? '', `${s.file}:${s.startLine}-${s.endLine}`].filter(Boolean).join('  '),
          });
        if (!raw) {
          const changed = new Set(env.changedFiles ?? []);
          const symbols = await index.symbols('', { signal: abort.signal, limit: 200, recent });
          for (const s of symbols.filter((s) => changed.has(s.file)).slice(0, EMPTY_SYMBOLS)) out.push(symbolRow(s));
          return out;
        }
        if (query && (filter === 'symbols' || (!filter && !pathLike(query)))) {
          const symbols = await index.symbols(query, { signal: abort.signal, limit: 20, recent });
          for (const s of symbols) out.push(symbolRow(s));
          if (symbols.truncated) out.push({ key: '~more', label: '… more matches may exist: refine your search', insert: `@${raw}`, group: 'Code' });
        }
        if (filter !== 'symbols') {
          const files = await index.files(query, { limit: filter === 'files' ? 30 : 8, recent });
          for (const f of files) out.push(item(fileInput(f.path, env.headSha), { key: `f:${f.path}`, label: `▤ ${f.path}`, detail: f.changed ? 'file · changed' : 'file' }));
        }
      } catch {
        // A newer query aborted this one; its reply is dropped anyway.
      }
      return out;
    },
  };
}
