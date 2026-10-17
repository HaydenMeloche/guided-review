import fs from 'node:fs/promises';
import path from 'node:path';
import type { DiffLine, Hunk } from '../types.js';
import { readBase } from '../git/blobs.js';
import { DEFAULT_HIGHLIGHT_THEME, highlightDiffFromFiles, highlightFileLines, highlightHunk, highlightLanguage, type HunkHighlights, type SyntaxSpan } from './highlight.js';

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

// A tokenized file: its lines, to check a hunk against, and their spans.
interface FileTokens {
  lines: string[];
  spans: SyntaxSpan[][];
}

// Whole-file token spans keyed on (path, sha, theme), so moving between hunks of one file
// tokenizes it once. Hunk-level results are cached too, keyed on what determines them.
interface Caches {
  files: AsyncLRU<FileTokens | undefined>;
  hunks: AsyncLRU<HunkHighlights | undefined>;
}
const main: Caches = { files: new AsyncLRU(HIGHLIGHT_CACHE_SIZE), hunks: new AsyncLRU(HIGHLIGHT_CACHE_SIZE * 4) };
// Themes being previewed in the picker get their own small cache, so browsing them never
// evicts the highlights of the theme in use.
const previews: Caches = { files: new AsyncLRU(4), hunks: new AsyncLRU(16) };

export interface HighlightRequest {
  hunk: Hunk;
  root?: string; // the worktree at the PR head; without it, each hunk highlights on its own
  headSha: string;
  baseSha: string;
}

export const fileHighlightKey = (file: string, sha: string, theme = DEFAULT_HIGHLIGHT_THEME) => `${theme}\0${sha}\0${file}`;

// Everything a hunk's highlight depends on. A new tour object with the same hunk keeps this key.
export function hunkHighlightKey(req: HighlightRequest, theme = DEFAULT_HIGHLIGHT_THEME): string {
  const { hunk } = req;
  // The first line and the count tell a hunk with expanded context from the hunk itself.
  const span = `${hunk.lines[0]?.newLine ?? hunk.lines[0]?.oldLine ?? ''}+${hunk.lines.length}`;
  return [theme, req.root ?? '', hunk.id, span, hunk.file, hunk.oldFile ?? '', req.headSha, req.baseSha].join('\0');
}

// Whole-file highlighting gives tokens that span lines (a comment opened above the hunk) their
// context, but tokenizing a very large file, usually a generated one, takes seconds and stalls
// the screen. Past this size a hunk is highlighted from its own lines.
export const MAX_HIGHLIGHT_FILE_BYTES = 512 * 1024;

async function readCapped(file: string): Promise<string | undefined> {
  const stat = await fs.stat(file).catch(() => undefined);
  if (!stat?.isFile() || stat.size > MAX_HIGHLIGHT_FILE_BYTES) return undefined;
  return fs.readFile(file, 'utf8').catch(() => undefined);
}

function spansFor(caches: Caches, file: string, sha: string, theme: string, read: () => Promise<string | undefined>): Promise<FileTokens | undefined> {
  return caches.files.get(fileHighlightKey(file, sha, theme), async () => {
    const text = await read();
    const source = text !== undefined && Buffer.byteLength(text) <= MAX_HIGHLIGHT_FILE_BYTES ? text : undefined;
    const spans = source === undefined ? undefined : await highlightFileLines(file, source, undefined, theme);
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

async function compute(req: HighlightRequest, theme: string, caches: Caches): Promise<HunkHighlights | undefined> {
  const { hunk, root } = req;
  const language = highlightLanguage(hunk.file);
  if (!language) return undefined;
  // YAML highlights per hunk; so does a tour with no worktree to read the files from.
  if (language === 'yaml' || !root) return highlightHunk(hunk, undefined, theme);
  const basePath = hunk.oldFile ?? hunk.file;
  const [head, base] = await Promise.all([
    spansFor(caches, hunk.file, req.headSha, theme, () => readCapped(path.join(root, hunk.file))).catch(() => undefined),
    spansFor(caches, basePath, req.baseSha, theme, () => readBase(root, req.baseSha, basePath)).catch(() => undefined), // readBase is cached and batched in src/git/blobs
  ]);
  return highlightDiffFromFiles(hunk.file, hunk.lines, { head: spansIfMatching(head, hunk.lines, 'head'), base: spansIfMatching(base, hunk.lines, 'base') }, theme);
}

// `preview`: the theme is only being previewed, so the result goes in the preview cache.
export function highlightHunkCached(req: HighlightRequest, theme = DEFAULT_HIGHLIGHT_THEME, preview = false): Promise<HunkHighlights | undefined> {
  const caches = preview ? previews : main;
  return caches.hunks.get(hunkHighlightKey(req, theme), () => compute(req, theme, caches));
}

// The cached highlight for this hunk if it has already been computed.
export function peekHunkHighlights(req: HighlightRequest, theme = DEFAULT_HIGHLIGHT_THEME, preview = false): { value: HunkHighlights | undefined } | undefined {
  return (preview ? previews : main).hunks.peek(hunkHighlightKey(req, theme));
}

export function clearHighlightCache(): void {
  for (const c of [main, previews]) {
    c.files.lru.clear();
    c.hunks.lru.clear();
  }
}

export function highlightCacheKeys(): { files: string[]; hunks: string[] } {
  return { files: main.files.lru.keys(), hunks: main.hunks.lru.keys() };
}
