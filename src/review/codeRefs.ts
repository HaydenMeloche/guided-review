import type { RepoIndex, SymbolHit } from '../analysis/repoIndex.js';
import { isSourcePath } from '../analysis/repoIndex.js';
import type { FileLink } from './fileLinks.js';

// Code a review comment names without linking to it: "We have a PaymentsUtils that we use as a
// repository layer", "see `retryPolicy`", "like refunds.kt does". Names are looked up in the
// PR's checkout and shown beside the thread like a linked file. Only exact matches count, so a
// word that merely looks like code finds nothing rather than something wrong.

const MAX_TERMS = 8;
const MAX_REFS = 4;
const MAX_SPAN = 15; // lines a function or constant shows marked; a class shows its declaration line

export interface CodeTerm {
  text: string; // as the comment wrote it, the label shown
  kind: 'symbol' | 'file';
  owner?: string; // Owner.member: the owner's name
  name?: string; // the name to look up
}

// Prose to search: no URLs (link previews cover them), code blocks (a suggestion block names
// everything in it), HTML comments, or images such as review bots' badges.
function prose(text: string): { plain: string; inline: string[] } {
  const inline: string[] = [];
  const plain = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/`([^`\n]+)`/g, (_, code: string) => {
      inline.push(code.trim());
      return ' ';
    });
  return { plain, inline };
}

const FILE = /(?:[\w.-]+\/)*[\w-]+\.[A-Za-z]{1,5}\b/g;
const OWNER_MEMBER = /\b([A-Z][A-Za-z0-9]*)\.([a-z_][A-Za-z0-9_]*)\b/g;
// PaymentsUtils, DSLContext: capitalised, with a lower-case letter and a second capital, so
// "Payments" or "THIS" read as words.
const CAPITALISED = /\b[A-Z][A-Za-z0-9]+\b/g;
const isPascal = (w: string) => /[a-z]/.test(w) && /[A-Z]/.test(w.slice(1));
const CAMEL = /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g;
const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

// The words in a comment that look like code, in the order written, at most MAX_TERMS.
export function codeTerms(text: string): CodeTerm[] {
  const { plain, inline } = prose(text);
  const out: CodeTerm[] = [];
  const seen = new Set<string>();
  const add = (t: CodeTerm) => {
    const key = `${t.kind}:${t.text}`;
    if (seen.has(key) || out.length >= MAX_TERMS) return;
    seen.add(key);
    out.push(t);
  };
  const scan = (text: string, all: boolean) => {
    // Each match is blanked out once found, so a later pattern can't read part of it again
    // ("FacilitiesService" in FacilitiesService.kt) while the same word elsewhere still counts.
    let s = text;
    const blank = (m: RegExpMatchArray) => (s = s.slice(0, m.index) + ' '.repeat(m[0].length) + s.slice(m.index! + m[0].length));
    for (const m of [...s.matchAll(FILE)])
      if (isSourcePath(m[0])) {
        add({ text: m[0], kind: 'file' });
        blank(m);
      }
    for (const m of [...s.matchAll(OWNER_MEMBER)]) {
      add({ text: m[0], kind: 'symbol', owner: m[1], name: m[2] });
      blank(m);
    }
    for (const re of [CAPITALISED, CAMEL, SNAKE]) for (const m of s.matchAll(re)) if (re !== CAPITALISED || isPascal(m[0])) add({ text: m[0], kind: 'symbol', name: m[0] });
    // Inline code is code: a plain word there counts too, as `retry` or `Payments` would.
    if (all && !out.some((t) => t.text === text)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*$/.exec(text);
      if (word) add({ text, kind: 'symbol', name: text });
    }
  };
  for (const code of inline) scan(code.replace(/\(\)/g, ''), true);
  // Paths inside a word ("PaymentsService.kt:4260") are found by FILE; the rest is prose.
  scan(plain, false);
  return out;
}

export interface CodeRef extends FileLink {
  label: string; // the comment's word that found it
}

// Where the thread itself sits, so a name found on its own lines isn't shown again.
export interface Here {
  path: string;
  line?: number;
}

const near = (here: Here | undefined, path: string, line?: number) => !!here && here.path === path && (line === undefined || here.line === undefined || Math.abs(here.line - line) <= 10);

// The definition each term names, at the PR head: exact matches only, the first per term, at
// most MAX_REFS in all. Terms with no exact match are dropped.
export async function resolveCodeRefs(index: Pick<RepoIndex, 'symbols' | 'files'>, terms: CodeTerm[], headSha: string, opts: { here?: Here; signal?: AbortSignal } = {}): Promise<CodeRef[]> {
  const out: CodeRef[] = [];
  const at = new Set<string>();
  const push = (label: string, path: string, startLine?: number, endLine?: number) => {
    const key = `${path}:${startLine ?? ''}`;
    if (at.has(key) || near(opts.here, path, startLine) || out.length >= MAX_REFS) return;
    at.add(key);
    const url = `ref:${label}@${path}${startLine ? `#L${startLine}` : ''}`;
    out.push({ url, ref: headSha, path, label, ...(startLine ? { startLine } : {}), ...(startLine && endLine && endLine > startLine ? { endLine } : {}) });
  };
  for (const t of terms) {
    if (out.length >= MAX_REFS) break;
    opts.signal?.throwIfAborted();
    if (t.kind === 'file') {
      const hits = await index.files(t.text, { limit: 10 });
      const exact = hits.find((h) => h.path === t.text || h.path.endsWith(`/${t.text}`));
      if (exact) push(t.text, exact.path);
      continue;
    }
    const query = t.owner ? `${t.owner}.${t.name}` : t.name!;
    const hits = await index.symbols(query, { limit: 20, signal: opts.signal });
    const match = hits.find((h) => h.name === t.name && (!t.owner || ownerName(h) === t.owner));
    if (!match) continue;
    push(t.text, match.file, match.startLine, spanEnd(match));
  }
  return out;
}

function ownerName(h: SymbolHit): string | undefined {
  return h.owner ?? h.qualified.split('.').slice(-2, -1)[0];
}

// A class marks its declaration line; a function or constant its body, up to MAX_SPAN lines.
function spanEnd(h: SymbolHit): number | undefined {
  if (h.kind === 'class' || h.kind === 'interface' || h.kind === 'type' || h.kind === 'enum' || h.kind === 'component') return undefined;
  return Math.min(h.endLine, h.startLine + MAX_SPAN - 1);
}
