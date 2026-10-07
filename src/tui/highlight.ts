import type { BundledLanguage } from 'shiki';
import type { DiffLine, Hunk } from '../types.js';
import { languageOf } from '../util/language.js';
import { sanitizeTerminal } from '../util/sanitize.js';

export interface SyntaxSpan {
  start: number;
  end: number;
  color: string;
}
export type HunkHighlights = SyntaxSpan[][];
const normalize = (text: string) => sanitizeTerminal(text.replace(/\t/g, '  '));

let shiki: Promise<typeof import('shiki')> | undefined;

// The shiki theme every highlight uses; part of the highlight cache key.
export const HIGHLIGHT_THEME = 'rose-pine-moon';

export function highlightLanguage(path: string): string | undefined {
  return languageOf(path)?.shiki;
}

function languageFor(path: string, source: string): string | undefined {
  return languageOf(path, source)?.shiki;
}

async function syntaxLines(source: string, language: string): Promise<SyntaxSpan[][]> {
  shiki ??= import('shiki').catch((error: unknown) => {
    shiki = undefined;
    throw error;
  });
  const { codeToTokens } = await shiki;
  const normalized = normalize(source);
  const result = await codeToTokens(normalized, { lang: language as BundledLanguage, theme: HIGHLIGHT_THEME });
  const defaultColor = result.fg?.slice(0, 7).toLowerCase();
  let lineStart = 0;
  const sourceLines = normalized.split('\n');
  return result.tokens.map((line, row) => {
    const spans = line.flatMap((token) => {
      const color = token.color?.slice(0, 7);
      if (!color || color.toLowerCase() === defaultColor) return [];
      const start = token.offset - lineStart;
      return [{ start, end: start + token.content.length, color }];
    });
    lineStart += (sourceLines[row]?.length ?? 0) + 1;
    return spans;
  });
}

// Tokenizes a whole source file, one span list per line. Undefined when the language is
// unknown; throws when shiki fails, so callers can decide whether to cache the result.
export async function highlightFileLines(file: string, source: string, language = languageFor(file, source)): Promise<SyntaxSpan[][] | undefined> {
  if (!language) return undefined;
  return syntaxLines(source, language);
}

export async function highlightSourceLines(file: string, lines: string[]): Promise<HunkHighlights | undefined> {
  const source = lines.join('\n');
  const language = languageFor(file, source);
  if (!language) return undefined;
  try {
    return await syntaxLines(source, language);
  } catch {
    return undefined;
  }
}

const sideText = (lines: DiffLine[], skip: DiffLine['kind']) =>
  lines
    .filter((l) => l.kind !== skip)
    .map((l) => l.text)
    .join('\n');

// Maps per-file (or per-side) spans onto the lines of a diff. A side given as `full` is
// indexed by line number; otherwise its spans follow the hunk's own lines of that side.
export function mapDiffHighlights(lines: DiffLine[], head: { spans: SyntaxSpan[][]; full: boolean }, base: { spans: SyntaxSpan[][]; full: boolean }): HunkHighlights {
  let headRow = 0;
  let baseRow = 0;
  return lines.map((line) => {
    const row = line.kind === 'del' ? base.spans[base.full ? (line.oldLine ?? 1) - 1 : baseRow++] : head.spans[head.full ? (line.newLine ?? 1) - 1 : headRow++];
    return row ?? [];
  });
}

// Highlights a diff from already tokenized full files. A side without full spans is
// tokenized from the hunk's own lines of that side.
export async function highlightDiffFromFiles(file: string, lines: DiffLine[], fullSpans: { head?: SyntaxSpan[][]; base?: SyntaxSpan[][] }): Promise<HunkHighlights | undefined> {
  const language = highlightLanguage(file);
  if (!language) return undefined;
  try {
    const [head, base] = await Promise.all([fullSpans.head ?? highlightFileLines(file, sideText(lines, 'del')), fullSpans.base ?? highlightFileLines(file, sideText(lines, 'add'))]);
    if (!head || !base) return undefined;
    return mapDiffHighlights(lines, { spans: head, full: !!fullSpans.head }, { spans: base, full: !!fullSpans.base });
  } catch {
    return undefined;
  }
}

// Full file contents preserve multiline tokens across diff hunks. When unavailable,
// highlight each side of this hunk so the viewer still works on cached tours.
export async function highlightDiffLines(file: string, lines: DiffLine[], full?: { head?: string; base?: string }): Promise<HunkHighlights | undefined> {
  const sourceHint = full?.head ?? full?.base ?? lines.map((line) => line.text).join('\n');
  const language = languageFor(file, sourceHint);
  if (!language) return undefined;
  const head = full?.head ?? sideText(lines, 'del');
  const base = full?.base ?? sideText(lines, 'add');
  let headSpans: SyntaxSpan[][];
  let baseSpans: SyntaxSpan[][];
  try {
    [headSpans, baseSpans] = await Promise.all([syntaxLines(head, language), syntaxLines(base, language)]);
  } catch {
    return undefined;
  }
  return mapDiffHighlights(lines, { spans: headSpans, full: full?.head !== undefined }, { spans: baseSpans, full: full?.base !== undefined });
}

export function highlightHunk(hunk: Hunk, full?: { head?: string; base?: string }): Promise<HunkHighlights | undefined> {
  return highlightDiffLines(hunk.file, hunk.lines, full);
}
