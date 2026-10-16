import type { DeclKind } from '../analysis/symbols.js';
import type { CodeRef } from '../types.js';
import { sha1 } from '../util/hash.js';

// A link to `path` pinned to `sha`, so it shows the code the reviewer saw even after new pushes.
// Each path segment is encoded on its own: a space, '#' or '%' in a name must not end the path.
export function permalink(host: string, repo: string, sha: string, path: string, startLine?: number, endLine?: number): string {
  const file = path.split('/').map(encodeURIComponent).join('/');
  let url = `https://${host}/${repo}/blob/${sha}/${file}`;
  if (startLine !== undefined) url += endLine !== undefined && endLine !== startLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`;
  return url;
}

// Where a ref points: its discussion for a thread, the whole file for a file, else its lines.
export function refUrl(ref: CodeRef, host: string, repo: string): string {
  if (ref.kind === 'thread' && ref.threadUrl) return ref.threadUrl;
  if (ref.kind === 'file') return permalink(host, repo, ref.commitSha, ref.path);
  return permalink(host, repo, ref.commitSha, ref.path, ref.startLine, ref.endLine);
}

// --- labels ---

export type RefLabelInput = Pick<CodeRef, 'kind' | 'path' | 'startLine' | 'endLine' | 'symbol'> & { symbolKind?: DeclKind };

const CALLABLE = new Set<DeclKind>(['function', 'method', 'route', 'command', 'handler']);
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1) || p;
const span = (start?: number, end?: number) => (start === undefined ? '' : end !== undefined && end !== start ? `${start}-${end}` : `${start}`);

// A reference is an inline code span holding exactly a label, so a label can hold neither
// whitespace nor a backtick.
export const sanitizeLabel = (s: string) => s.replace(/[\s`]+/g, '_');
export const validLabel = (s: string) => s.length > 0 && !/[\s`]/.test(s);

// A symbol's own name (`InventoryService.release` → `release`) and whether it is called; a
// symbol without a kind is called when it starts lowercase.
function symbolName(ref: RefLabelInput): { name: string; callable: boolean } | undefined {
  if (ref.kind !== 'symbol' || !ref.symbol) return undefined;
  const name =
    ref.symbol
      .split(/[.#:]+/)
      .filter(Boolean)
      .pop() ?? ref.symbol;
  return { name, callable: ref.symbolKind ? CALLABLE.has(ref.symbolKind) : /^[a-z_$]/.test(name) };
}

// The label with `file` naming the file: `file#Name` for a class, type or other non-callable,
// `file` for a file, `file:84-96` for a range. A callable is `name()`, or `file#name()` to
// tell it from another of the same name.
function labelIn(ref: RefLabelInput, file: string, qualify: boolean): string {
  const sym = symbolName(ref);
  if (sym) return sanitizeLabel(sym.callable && !qualify ? `${sym.name}()` : `${file}#${sym.name}${sym.callable ? '()' : ''}`);
  if (ref.kind === 'thread') return sanitizeLabel(`thread:${file}${ref.startLine !== undefined ? `:${ref.startLine}` : ''}`);
  if (ref.kind === 'range' || ref.kind === 'symbol') {
    const s = span(ref.startLine, ref.endLine);
    return sanitizeLabel(s ? `${file}:${s}` : file);
  }
  return sanitizeLabel(file);
}

// The label a ref would get on its own: `name()` for functions and methods, `stock.ts#RetryPolicy`
// for classes, types and other declarations, the basename for a file, `stock.ts:84-96` for a range.
export function baseRefLabel(ref: RefLabelInput): string {
  return labelIn(ref, basename(ref.path), false);
}

// A label for `ref` that no label in `taken` already uses. Duplicates are told apart by where
// they live: a function gains its file (`stock.ts#releaseInventory()`), then the basename gives
// way to the full path (`src/legacy/stock.ts#releaseInventory()`, `src/legacy/stock.ts:1-2`),
// then a counter (`src/legacy/stock.ts#releaseInventory()~2`).
export function refLabel(ref: RefLabelInput, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const file = basename(ref.path);
  const candidates = [baseRefLabel(ref)];
  if (symbolName(ref)?.callable) candidates.push(labelIn(ref, file, true));
  if (file !== ref.path) candidates.push(labelIn(ref, ref.path, true));
  for (const c of candidates) if (!used.has(c)) return c;
  const last = candidates[candidates.length - 1];
  for (let n = 2; ; n++) if (!used.has(`${last}~${n}`)) return `${last}~${n}`;
}

// Labels for every ref of a draft, in order, each unique within the draft.
export function uniqueLabels(refs: RefLabelInput[]): string[] {
  const out: string[] = [];
  for (const r of refs) out.push(refLabel(r, out));
  return out;
}

// --- hashing ---

const toLines = (text: string) => text.replace(/\r\n?/g, '\n').split('\n');

// Hash of referenced lines; line endings are normalized so a CRLF checkout matches the blob.
export function linesHash(text: string): string {
  return sha1(toLines(text).join('\n'));
}

// --- references in a body ---

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// A backtick run closed by a run of the same length. An unclosed run is literal.
const CODE_SPAN = /(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g;

export interface CodeSpan {
  start: number; // the opening backtick
  end: number; // just after the closing backtick
  text: string;
}

// Single-backtick inline code spans outside fenced blocks, each within one paragraph, at their
// offsets in `body`. A longer run (``a `b` c``) is code that holds backticks, never a reference.
export function codeSpans(body: string): CodeSpan[] {
  const out: CodeSpan[] = [];
  let prose: { start: number; end: number } | undefined;
  const flush = () => {
    if (!prose) return;
    const text = body.slice(prose.start, prose.end);
    for (const m of text.matchAll(CODE_SPAN)) if (m[1].length === 1) out.push({ start: prose.start + m.index, end: prose.start + m.index + m[0].length, text: m[2] });
    prose = undefined;
  };
  let fence: string | undefined;
  let at = 0;
  for (const line of body.split('\n')) {
    const end = at + line.length;
    const m = line.match(FENCE);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = undefined;
    } else if (m) {
      flush();
      fence = m[1];
    } else if (!line.trim()) {
      // A blank line ends the paragraph: GitHub never pairs backticks across one.
      flush();
    } else if (prose) prose.end = end;
    else prose = { start: at, end };
    at = end + 1;
  }
  flush();
  return out;
}

// The code spans that name a ref: their text is exactly its label. One that is already a
// link's text (`` [`x`](url) ``) is left as it is.
export function refSpans<R extends Pick<CodeRef, 'label'>>(body: string, refs: R[]): (CodeSpan & { ref: R })[] {
  if (!refs.length || !body.includes('`')) return [];
  const byLabel = new Map(refs.map((r) => [r.label, r]));
  const out: (CodeSpan & { ref: R })[] = [];
  for (const s of codeSpans(body)) {
    const ref = byLabel.get(s.text);
    if (ref && !(body[s.start - 1] === '[' && body.startsWith('](', s.end))) out.push({ ...s, ref });
  }
  return out;
}

// Each code span that names a ref becomes a link to it, keeping the span as the link text. Any
// other code is ordinary code and stays as typed, so a body naming no ref comes out unchanged.
export function linkRefs(body: string, refs: CodeRef[], host: string, repo: string): string {
  let out = '';
  let at = 0;
  for (const s of refSpans(body, refs)) {
    out += `${body.slice(at, s.start)}[\`${s.text}\`](${refUrl(s.ref, host, repo)})`;
    at = s.end;
  }
  return at ? out + body.slice(at) : body;
}

// The refs a body still mentions, in their order. A ref is only the target of a code span, so
// one whose span was deleted or edited goes with it.
export function referencedRefs(body: string, refs: CodeRef[]): CodeRef[] {
  if (!refs.length) return refs;
  const used = new Set(refSpans(body, refs).map((s) => s.ref.id));
  return refs.filter((r) => used.has(r.id));
}
