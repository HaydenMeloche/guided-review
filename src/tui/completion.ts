// Inline completion for TextInput. A completer's trigger is matched against the text
// before the cursor. The query is the last capture group. With two or more groups, group 1
// is a left boundary (start of text, space, `(`) that stays in the text; everything after
// it up to the cursor is replaced by the picked item's `insert`.
export interface CompletionItem {
  key: string;
  label: string; // list row, plain text (sanitized again before display)
  detail?: string;
  insert: string; // replaces trigger + query
  onPick?: () => void;
  preview?: CompletionPreview; // code to show beside the list while this row is highlighted
  group?: string; // a dim, unselectable header above the first row of each group
  keepOpen?: boolean; // inserting it leaves the list open on the new query (a filter, say)
}

// A place in a worktree file: the whole file, or startLine..endLine marked within it. With
// `text`, that text is shown instead of the file (a review thread), and has no lines to pick.
export interface CompletionPreview {
  path: string;
  startLine?: number;
  endLine?: number;
  text?: string;
}

// The two dim lines under the list: the keys that work now, then what narrows the list or
// what the active filter shows. `accent` parts are drawn cyan.
export interface CompletionHint {
  actions: string;
  help?: HintPart[];
}
export interface HintPart {
  text: string;
  accent?: boolean;
}

export const ACTIONS_HINT = 'tab insert · ↑↓ choose · esc close';

export interface Completer {
  trigger: RegExp;
  items: (query: string) => CompletionItem[] | Promise<CompletionItem[]>;
  // Rows that answer at once, listed above `items` and shown while those are still loading,
  // so a slow search never holds them up.
  instant?: (query: string) => CompletionItem[];
  pendingGroup?: string; // the group `items` fills, headed above "searching…"
  // Under the list, for the highlighted row and the query; a string is the actions line alone.
  hint?: string | CompletionHint | ((item: CompletionItem | undefined, query: string) => string | CompletionHint);
  // Choosing lines in a row's preview (→ from the list): how many lines its file has, and what
  // inserting start..end of it does. Without these a preview is only shown.
  lineCount?: (path: string) => number | undefined;
  pickLines?: (item: CompletionItem, start: number, end: number) => Pick<CompletionItem, 'insert' | 'onPick'> | undefined;
}

// GitHub username mentions. Requires a boundary before `@`, so `a@b` (an email) never matches,
// nor does `@@` (a pasted diff header).
export const mentionTrigger = /(^|[\s(])@([\w-]*)$/;

// `@` for people and code together, with the same boundary. A code query also takes the
// characters of paths, ranges and filters (`@src/a.ts:4-5`, `@f:`); a GitHub username holds
// none of `./:#$~`, so those never read as a person.
// A query never ends in `.`, so `@alice.` at the end of a sentence closes the list (and Enter
// saves); typing on past the dot, as in `@stock.ts`, opens it again.
export const referenceTrigger = /(^|[\s(])@((?:[\w./:#$~-]*[\w/:#$~-])?)$/;

// People whose username starts with `query`, as `@name` rows.
export function mentionItems(names: string[], query: string, limit = 50): CompletionItem[] {
  return [...new Set(names)]
    .filter((name) => name.toLowerCase().startsWith(query.toLowerCase()))
    .slice(0, limit)
    .map((name) => ({ key: `@${name}`, label: `@${name}`, insert: `@${name} ` }));
}

export function mentionCompleter(names: string[]): Completer {
  return { trigger: mentionTrigger, items: (query) => mentionItems(names, query) };
}

export interface CompletionMatch {
  index: number; // which completer
  start: number; // where the replaced span begins
  query: string;
}

export function findCompletion(completers: Completer[], before: string): CompletionMatch | undefined {
  for (const [index, completer] of completers.entries()) {
    const m = completer.trigger.exec(before);
    if (!m) continue;
    const query = m[m.length - 1] ?? '';
    const start = m.index + (m.length > 2 ? (m[1] ?? '').length : 0);
    return { index, start, query };
  }
  return undefined;
}

function tokenRanges(text: string, pattern: RegExp): [number, number][] {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  const out: [number, number][] = [];
  for (const m of text.matchAll(re)) if (m[0]) out.push([m.index, m.index + m[0].length]);
  return out;
}

// What a highlighted run is: a code span naming a reference (cyan) or a known @mention (blue).
export type TokenKind = 'ref' | 'mention';

export interface TokenRule {
  kind: TokenKind;
  pattern: RegExp;
  outsideCode?: boolean; // never inside an inline code span on the row
}

// A backtick run closed by one of the same length, as in refs.ts's code spans.
const ROW_CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `@name` for each known name (users, or `org/team`), case-insensitive, with the mention
// trigger's boundary before `@`, so `foo@bar` is not one. An unknown `@word` stays plain.
export function mentionHighlight(names: string[] | undefined): TokenRule | undefined {
  const known = [...new Set((names ?? []).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!known.length) return undefined;
  return { kind: 'mention', outsideCode: true, pattern: new RegExp(`(?<![^\\s(])@(?:${known.map(escapeRe).join('|')})(?![\\w/-])`, 'gi') };
}

export interface RowSegment {
  start: number;
  text: string;
  cursor: boolean;
  token?: TokenKind;
}

// Cuts one wrapped TextInput row (which may hold the \u0000 cursor marker) into runs for
// display. The marker comes out before tokens are matched, so a token keeps its colour with
// the cursor inside it. A token that wrap splits across two rows is matched on neither. Where
// rules overlap, the earlier one wins.
export function rowSegments(row: string, rules: TokenRule[] = []): RowSegment[] {
  const at = row.indexOf('\u0000');
  const text = at < 0 ? row : row.slice(0, at) + row.slice(at + 1);
  const shown = at === text.length ? text + ' ' : text; // cursor after the last character
  const code = rules.some((r) => r.outsideCode) ? tokenRanges(text, ROW_CODE_SPAN) : [];
  const ranges: [number, number, TokenKind][] = [];
  for (const rule of rules) {
    for (const [s, e] of tokenRanges(text, rule.pattern)) {
      if (rule.outsideCode && code.some(([cs, ce]) => s < ce && cs < e)) continue;
      if (ranges.some(([rs, re]) => s < re && rs < e)) continue;
      ranges.push([s, e, rule.kind]);
    }
  }
  const cuts = new Set([0, shown.length]);
  for (const [s, e] of ranges) cuts.add(s).add(e);
  if (at >= 0) cuts.add(at).add(at + 1);
  const edges = [...cuts].sort((a, b) => a - b);
  const out: RowSegment[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const [s, e] = [edges[i], edges[i + 1]];
    const token = ranges.find(([ts, te]) => s >= ts && e <= te)?.[2];
    out.push({ start: s, text: shown.slice(s, e), cursor: s === at, ...(token ? { token } : {}) });
  }
  return out;
}

// Which wrapped rows are a ``` fence or inside one: a code span there is never linked, so it is
// not highlighted either. The cursor marker may sit anywhere in a row.
export function fencedRows(rows: string[]): boolean[] {
  let inside = false;
  return rows.map((r) => {
    const fence = /^\s*```/.test(r.replace('\u0000', ''));
    if (fence) inside = !inside;
    return fence || inside;
  });
}

// A field's wrapped rows cut into runs. Rows of a ``` fenced block get no tokens: a code span or
// mention there is code.
export function fieldSegments(rows: string[], rules?: TokenRule[]): RowSegment[][] {
  const fenced = fencedRows(rows);
  return rows.map((r, i) => rowSegments(r, fenced[i] ? undefined : rules));
}
