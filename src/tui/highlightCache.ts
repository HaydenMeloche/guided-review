import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiffLine, Hunk } from '../types.js';
import { readBase } from '../git/blobs.js';
import { HIGHLIGHT_THEME, highlightDiffFromFiles, highlightFileLines, highlightHunk, highlightLanguage, type HunkHighlights, type SyntaxSpan } from './highlight.js';

// A small least-recently-used map: reads refresh an entry, writes past `max` drop the oldest.
export class LRU<K, V> {
  private map = new Map<K, V>();
  constructor(readonly max: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  keys(): K[] {
    return [...this.map.keys()];
  }
}

interface Entry<V> {
  promise: Promise<V>;
  done: boolean;
  value?: V;
}

// Caches a computation by key. Settled values can be read synchronously, so a view can
// render a cached highlight on its first frame. A rejected computation is not cached.
class AsyncLRU<V> {
  readonly lru: LRU<string, Entry<V>>;
  constructor(max: number) {
    this.lru = new LRU(max);
  }

  get(key: string, compute: () => Promise<V>): Promise<V> {
    const hit = this.lru.get(key);
    if (hit) return hit.promise;
    const entry: Entry<V> = { promise: compute(), done: false };
    entry.promise.then(
      (value) => {
        entry.done = true;
        entry.value = value;
      },
      () => {
        if (this.lru.get(key) === entry) this.lru.delete(key);
      },
    );
    this.lru.set(key, entry);
    return entry.promise;
  }

  peek(key: string): { value: V } | undefined {
    const hit = this.lru.get(key);
    return hit?.done ? { value: hit.value as V } : undefined;
  }
}

export const HIGHLIGHT_CACHE_SIZE = 30;

// Whole-file token spans keyed on (path, sha, theme), so moving between hunks of one file
// tokenizes it once. Hunk-level results are cached too, keyed on what determines them.
const fileSpans = new AsyncLRU<FileTokens | undefined>(HIGHLIGHT_CACHE_SIZE);

// A tokenized file: its lines, to check a hunk against, and their spans.
interface FileTokens {
  lines: string[];
  spans: SyntaxSpan[][];
}
const hunkResults = new AsyncLRU<HunkHighlights | undefined>(HIGHLIGHT_CACHE_SIZE * 4);

export interface HighlightRequest {
  hunk: Hunk;
  root?: string; // the worktree at the PR head; without it, each hunk highlights on its own
  headSha: string;
  baseSha: string;
}

export const fileHighlightKey = (file: string, sha: string, theme = HIGHLIGHT_THEME) => `${theme}\0${sha}\0${file}`;

// Everything a hunk's highlight depends on. A new tour object with the same hunk keeps this key.
export function hunkHighlightKey(req: HighlightRequest): string {
  const { hunk } = req;
  return [HIGHLIGHT_THEME, req.root ?? '', hunk.id, hunk.file, hunk.oldFile ?? '', req.headSha, req.baseSha].join('\0');
}

function spansFor(file: string, sha: string, read: () => Promise<string | undefined>): Promise<FileTokens | undefined> {
  return fileSpans.get(fileHighlightKey(file, sha), async () => {
    const source = await read();
    const spans = source === undefined ? undefined : await highlightFileLines(file, source);
    return spans && { lines: source!.split('\n'), spans };
  });
}

// The file's spans when every line of this side of the hunk is the file's line at that number.
// A file can differ from the diff: a preview reads the live checkout, which may have changed
// since the diff was taken. Its spans would color the wrong characters, so that side then
// highlights from the hunk's own lines instead.
function spansIfMatching(tokens: FileTokens | undefined, lines: DiffLine[], side: 'head' | 'base'): SyntaxSpan[][] | undefined {
  if (!tokens) return undefined;
  for (const l of lines) {
    if (l.kind === (side === 'head' ? 'del' : 'add')) continue;
    const n = side === 'head' ? l.newLine : l.oldLine;
    if (n === undefined || tokens.lines[n - 1] !== l.text) return undefined;
  }
  return tokens.spans;
}

async function compute(req: HighlightRequest): Promise<HunkHighlights | undefined> {
  const { hunk, root } = req;
  const language = highlightLanguage(hunk.file);
  if (!language) return undefined;
  // YAML highlights per hunk; so does a tour with no worktree to read the files from.
  if (language === 'yaml' || !root) return highlightHunk(hunk);
  const basePath = hunk.oldFile ?? hunk.file;
  const [head, base] = await Promise.all([
    spansFor(hunk.file, req.headSha, () => fs.readFile(path.join(root, hunk.file), 'utf8').catch(() => undefined)).catch(() => undefined),
    spansFor(basePath, req.baseSha, () => readBase(root, req.baseSha, basePath)).catch(() => undefined), // readBase is cached and batched in src/git/blobs
  ]);
  return highlightDiffFromFiles(hunk.file, hunk.lines, { head: spansIfMatching(head, hunk.lines, 'head'), base: spansIfMatching(base, hunk.lines, 'base') });
}

export function highlightHunkCached(req: HighlightRequest): Promise<HunkHighlights | undefined> {
  return hunkResults.get(hunkHighlightKey(req), () => compute(req));
}

// The cached highlight for this hunk if it has already been computed.
export function peekHunkHighlights(req: HighlightRequest): { value: HunkHighlights | undefined } | undefined {
  return hunkResults.peek(hunkHighlightKey(req));
}

export function clearHighlightCache(): void {
  fileSpans.lru.clear();
  hunkResults.lru.clear();
}

export function highlightCacheKeys(): { files: string[]; hunks: string[] } {
  return { files: fileSpans.lru.keys(), hunks: hunkResults.lru.keys() };
}
