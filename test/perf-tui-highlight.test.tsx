import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Hunk } from '../src/types.js';
import { hunk, tour } from './fixtures/tour.js';
import { waitFor } from './helpers/waitFor.js';

vi.mock('../src/tui/highlightCache.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/tui/highlightCache.js')>();
  return { ...real, highlightHunkCached: vi.fn(real.highlightHunkCached) };
});

const cache = await import('../src/tui/highlightCache.js');
const { ChapterScreen } = await import('../src/tui/ChapterScreen.js');
const { HIGHLIGHT_THEME } = await import('../src/tui/highlight.js');
const { LRU, clearHighlightCache, fileHighlightKey, highlightCacheKeys, highlightHunkCached, hunkHighlightKey, peekHunkHighlights } = cache;

const tsHunk = (id: string, newLine: number, text: string, extra: Partial<Hunk> = {}) => hunk(id, 'src/app.ts', [{ kind: 'add', text, newLine }], { newStart: newLine, newLines: 1, ...extra });

beforeEach(() => {
  clearHighlightCache();
  vi.mocked(highlightHunkCached).mockClear();
});

describe('LRU', () => {
  it('evicts the least recently used entry and refreshes on read', () => {
    const lru = new LRU<string, number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1); // a is now the newest
    lru.set('c', 3);
    expect(lru.has('b')).toBe(false);
    expect(lru.keys()).toEqual(['a', 'c']);
    expect(lru.size).toBe(2);
  });
});

describe('highlight cache keying', () => {
  it('keys on hunk id, file and shas, not on the hunk object', () => {
    const h = tsHunk('h1', 1, 'const a = 1;');
    const copy = structuredClone(h);
    const req = { hunk: h, headSha: 'head1', baseSha: 'base1' };
    expect(hunkHighlightKey({ ...req, hunk: copy })).toBe(hunkHighlightKey(req));
    expect(hunkHighlightKey({ ...req, headSha: 'head2' })).not.toBe(hunkHighlightKey(req));
    expect(hunkHighlightKey({ ...req, baseSha: 'base2' })).not.toBe(hunkHighlightKey(req));
    expect(hunkHighlightKey({ ...req, hunk: tsHunk('h2', 1, 'const a = 1;') })).not.toBe(hunkHighlightKey(req));
    expect(fileHighlightKey('a.ts', 'sha')).toContain(HIGHLIGHT_THEME);
  });

  it('returns a cached result for a new hunk object with the same id and shas', async () => {
    const h = tsHunk('h1', 1, 'const a = 1;');
    const first = await highlightHunkCached({ hunk: h, headSha: 'x', baseSha: 'y' });
    expect(first?.[0].length).toBeGreaterThan(0);
    const peeked = peekHunkHighlights({ hunk: structuredClone(h), headSha: 'x', baseSha: 'y' });
    expect(peeked?.value).toBe(first);
  });
});

describe('whole-file highlights from the worktree', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-hl-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
    git('init', '-q');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/app.ts'), '/* base\n*/\nconst a = 1;\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    fs.writeFileSync(path.join(root, 'src/app.ts'), '/* head\nstill a comment */\nconst a = 2;\nconst b = 3;\n');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('tokenizes each file once per (path, sha) across hunks and uses full-file context', async () => {
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    const h1 = tsHunk('h1', 2, 'still a comment */');
    const h2 = tsHunk('h2', 4, 'const b = 3;');
    const r1 = await highlightHunkCached({ hunk: h1, root, headSha: 'head', baseSha });
    await highlightHunkCached({ hunk: h2, root, headSha: 'head', baseSha });
    const text = 'still a comment */';
    // Full-file context: the line is inside a block comment opened on line 1.
    expect(r1![0].map((s) => text.slice(s.start, s.end)).join('')).toBe(text);
    const files = highlightCacheKeys().files;
    expect(files).toEqual([fileHighlightKey('src/app.ts', 'head'), fileHighlightKey('src/app.ts', baseSha)]);
    expect(highlightCacheKeys().hunks).toHaveLength(2);
  });

  it('highlights from the hunk when the file on disk no longer matches it', async () => {
    // A preview whose checkout changed after the diff was taken: line 3 is now 'const a = 2;'.
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    const h = tsHunk('h3', 3, 'const answer = 42;');
    const result = await highlightHunkCached({ hunk: h, root, headSha: 'head', baseSha });
    const { highlightHunk } = await import('../src/tui/highlight.js');
    expect(result).toEqual(await highlightHunk(h));
  });
});

describe('SourcePane highlighting', () => {
  it('does not re-highlight when a tour update replaces the hunk object', async () => {
    const h = tsHunk('h1', 1, 'const answer = 42;');
    const t = tour([h], [{ hunkIds: ['h1'] }]);
    const props = {
      states: {},
      drafts: [],
      ci: 0,
      hi: 0,
      order: 'flow' as const,
      deltaOnly: false,
      width: 120,
      height: 30,
      setPos: () => {},
      setState: () => {},
      saveDraft: () => {},
      deleteDraft: () => {},
      moveHunk: () => {},
      toggleOrder: () => {},
      toggleDelta: () => {},
      openSubmit: () => {},
      openBriefing: () => {},
      openInClaude: () => {},
      quit: () => {},
    };
    const ui = render(<ChapterScreen {...props} tour={t} chapters={t.chapters} />);
    await waitFor(() => expect(peekHunkHighlights({ hunk: h, headSha: t.headSha, baseSha: t.baseSha })).toBeDefined());
    expect(highlightHunkCached).toHaveBeenCalledTimes(1);

    // A pipeline update: every object is new, but the hunk's id and shas are the same.
    for (let i = 0; i < 3; i++) {
      const next = structuredClone(t);
      next.notes = [`update ${i}`];
      ui.rerender(<ChapterScreen {...props} tour={next} chapters={next.chapters} />);
      await waitFor(() => expect(ui.lastFrame()).toContain('answer'));
    }
    expect(highlightHunkCached).toHaveBeenCalledTimes(1);

    // A new head is a new highlight.
    const moved = { ...structuredClone(t), headSha: 'head2' };
    ui.rerender(<ChapterScreen {...props} tour={moved} chapters={moved.chapters} />);
    await waitFor(() => expect(highlightHunkCached).toHaveBeenCalledTimes(2));
    ui.unmount();
  });
});

describe('highlighting a very large file', () => {
  it('highlights the hunk from its own lines instead of tokenizing the whole file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-big-'));
    try {
      fs.mkdirSync(path.join(root, 'src'));
      const lines = Array.from({ length: 30_000 }, (_, i) => `export const value${i} = ${i}; // padding padding`);
      fs.writeFileSync(path.join(root, 'src/app.ts'), lines.join('\n') + '\n'); // about 1.4 MB
      const h = tsHunk('big', 2, lines[1]);
      const started = performance.now();
      const result = await highlightHunkCached({ hunk: h, root, headSha: 'head-big', baseSha: 'base-big' });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(result?.[0].length).toBeGreaterThan(0);
      expect(highlightCacheKeys().files.some((k) => k.endsWith('src/app.ts'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
