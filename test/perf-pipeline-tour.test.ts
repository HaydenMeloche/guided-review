import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same fakes as pipeline.test.ts (the vi.mock factories must live in each file; the plain helpers are in
// helpers/pipeline.ts): gh, git and the agent are faked; static analysis runs for real.
vi.mock('../src/github/gh.js', () => ({
  fetchDiff: vi.fn(),
  fetchThreads: vi.fn(async () => []),
  fetchReviews: vi.fn(async () => []),
  viewerLogin: vi.fn(async () => 'me'),
  getMentionUsers: vi.fn(async () => []),
}));
vi.mock('../src/git/worktree.js', () => ({
  listFiles: vi.fn(async () => []),
  diffBetween: vi.fn(async () => ''),
  hasCommit: vi.fn(async () => true),
  mergeBaseOf: vi.fn(async () => undefined),
  prDiff: vi.fn(async () => ''),
}));
vi.mock('../src/git/blobs.js', () => ({
  readBlobs: vi.fn(async (_cwd: string, _rev: string, paths: string[]) => new Map(paths.map((p) => [p, undefined]))),
  primeBaseCache: vi.fn(),
}));
vi.mock('../src/util/exec.js', () => ({
  run: vi.fn(async () => {
    throw new Error('git is not available in this test');
  }),
}));
vi.mock('../src/agent/agent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/agent.js')>()),
  analyzeBriefing: vi.fn(),
  analyzeChapter: vi.fn(),
}));

import { applyChapterResult, reuseLevel, runPipeline } from '../src/pipeline.js';
import { fetchDiff } from '../src/github/gh.js';
import { prDiff, mergeBaseOf } from '../src/git/worktree.js';
import { AgentUnavailableError, analyzeBriefing, analyzeChapter } from '../src/agent/agent.js';
import { briefingPrompt, chapterPrompt, MINOR_SUMMARY_ID, minorHunkIds } from '../src/agent/prompts.js';
import { routingIdentity } from '../src/agent/types.js';
import type { Tour } from '../src/types.js';
import { briefingFor, fakeStore, narrationFor, pr, tempWorktree } from './helpers/pipeline.js';
import { hunk, tour as makeTour } from './fixtures/tour.js';

const briefing = vi.mocked(analyzeBriefing);
const chapter = vi.mocked(analyzeChapter);

beforeEach(() => {
  vi.clearAllMocks();
});
const worktree = tempWorktree('gr-perf-');
const { writeModules, options } = worktree;

describe('local PR diff', () => {
  it('uses the worktree diff from the merge base and skips the GitHub fetch', async () => {
    vi.mocked(mergeBaseOf).mockResolvedValueOnce('mb');
    vi.mocked(prDiff).mockResolvedValueOnce(writeModules(1));
    const tour = await runPipeline(options(fakeStore(), { noAgent: true }));
    expect(prDiff).toHaveBeenCalledWith(worktree.root, 'mb', 'head', undefined);
    expect(fetchDiff).not.toHaveBeenCalled();
    expect(tour.baseSha).toBe('mb');
    expect(Object.keys(tour.hunks)).toHaveLength(1);
  });

  it('falls back to GitHub when the local diff fails', async () => {
    vi.mocked(mergeBaseOf).mockResolvedValueOnce('mb');
    vi.mocked(prDiff).mockRejectedValueOnce(new Error('bad object'));
    vi.mocked(fetchDiff).mockResolvedValueOnce(writeModules(1));
    const tour = await runPipeline(options(fakeStore(), { noAgent: true }));
    expect(fetchDiff).toHaveBeenCalledTimes(1);
    expect(Object.keys(tour.hunks)).toHaveLength(1);
  });
});

describe('structural sharing', () => {
  it('emits new tours per batch while unchanged chapters and hunks keep their identity', async () => {
    vi.mocked(fetchDiff).mockResolvedValue(writeModules(3));
    briefing.mockImplementation(async (t) => briefingFor(t.chapters));
    chapter.mockImplementation(async (_t, c) => narrationFor(c));
    const emitted: Tour[] = [];
    const snapshots: string[] = [];
    const tour = await runPipeline(
      options(fakeStore(), {
        onTour: (t) => {
          emitted.push(t);
          snapshots.push(JSON.stringify(t));
        },
      }),
    );

    // Nothing emitted was mutated afterwards.
    expect(emitted.map((t) => JSON.stringify(t))).toEqual(snapshots);
    expect(new Set(emitted).size).toBe(emitted.length);
    // Between consecutive chapter emissions, only one chapter's hunks change.
    const afterBriefing = emitted.findIndex((t) => t.mode === 'agent');
    const a = emitted[afterBriefing];
    const b = emitted[afterBriefing + 1];
    const changed = Object.keys(a.hunks).filter((id) => a.hunks[id] !== b.hunks[id]);
    expect(changed).toHaveLength(1);
    expect(b.chapters.filter((c, i) => c !== a.chapters[i])).toHaveLength(1);
    expect(tour.complete).toBe(true);
    expect(tour.chapters.filter((c) => c.kind === 'flow').every((c) => c.narrated)).toBe(true);
  });

  it('applyChapterResult copies only the changed path', () => {
    const [a, b] = ['h_00000000aa', 'h_00000000bb'];
    const t = makeTour([hunk(a, 'a.ts', [{ kind: 'add', text: 'x', newLine: 1 }]), hunk(b, 'b.ts', [{ kind: 'add', text: 'y', newLine: 1 }])], [{ hunkIds: [a] }, { hunkIds: [b] }]);
    const next = applyChapterResult(t, 'c0', { hunks: [{ id: a, narration: `see ${b}`, citesCode: true }] });
    expect(next).not.toBe(t);
    expect(next.hunks[b]).toBe(t.hunks[b]);
    expect(next.chapters[1]).toBe(t.chapters[1]);
    expect(next.hunks[a].narration).toBe('see b.ts:1'); // hunk ids humanized
    expect(t.hunks[a].narration).toBeUndefined();
  });
});

describe('resuming an incomplete tour', () => {
  it('reuses the briefing and narrated chapters, and narrates only the missing ones', async () => {
    vi.mocked(fetchDiff).mockResolvedValue(writeModules(4));
    briefing.mockImplementation(async (t) => briefingFor(t.chapters));
    chapter.mockImplementation(async (_t, c) => {
      if (chapter.mock.calls.length === 4) {
        await new Promise((r) => setTimeout(r, 20)); // the other chapters finish first
        throw new AgentUnavailableError('rate limited');
      }
      return narrationFor(c);
    });
    const first = await runPipeline(options(fakeStore()));
    expect(first.complete).toBe(false);
    const narratedFirst = first.chapters.filter((c) => c.narrated).map((c) => c.id);
    expect(narratedFirst.length).toBeGreaterThan(0);
    expect(narratedFirst.length).toBeLessThan(4);

    vi.clearAllMocks();
    chapter.mockImplementation(async (_t, c) => narrationFor(c));
    const store = fakeStore(JSON.parse(JSON.stringify(first)) as Tour);
    const opts = options(store);
    const second = await runPipeline(opts);

    expect(fetchDiff).not.toHaveBeenCalled();
    expect(briefing).not.toHaveBeenCalled();
    expect(chapter.mock.calls.map((c) => c[1].id).sort()).toEqual(
      first.chapters
        .filter((c) => c.kind === 'flow' && !c.narrated)
        .map((c) => c.id)
        .sort(),
    );
    expect(second.complete).toBe(true);
    expect(second.notes.some((n) => n.startsWith('Narration stopped early'))).toBe(false);
    expect(vi.mocked(opts.onTour).mock.calls[0][0].mode).toBe('agent'); // the briefing shows at once
  });

  it('reuses by role: Q&A changes keep everything, narration changes keep the briefing', () => {
    const base = { mode: 'agent', complete: true, agentIdentity: routingIdentity({}) } as Tour;
    expect(reuseLevel(base, routingIdentity({ roles: { qa: { model: 'other' } } }))).toBe('complete');
    expect(reuseLevel(base, routingIdentity({ roles: { narration: { model: 'other' } } }))).toBe('briefing');
    expect(reuseLevel(base, routingIdentity({ roles: { briefing: { model: 'other' } } }))).toBe('none');
    expect(reuseLevel({ ...base, complete: false }, routingIdentity({}))).toBe('resume');
    expect(reuseLevel({ ...base, mode: 'plain', complete: false }, routingIdentity({}))).toBe('none');
  });
});

describe('briefing prompt cap', () => {
  it('lists at most 15 hunks per chapter and rolls up files past 200', () => {
    const hunks = Array.from({ length: 300 }, (_, i) => hunk(`h_${String(i).padStart(10, '0')}`, `src/d${i % 3}/f${i}.ts`, [{ kind: 'add', text: 'x', newLine: 1 }]));
    const t = makeTour(hunks, [{ kind: 'supporting', hunkIds: hunks.map((h) => h.id) }], {
      files: hunks.map((h) => ({ path: h.file, status: 'modified', binary: false, kind: 'test', kindReason: '', additions: 1, deletions: 0, hunkIds: [h.id] })),
    });
    const p = briefingPrompt(t, pr);
    const chapterSection = p.slice(p.indexOf('## Static analysis'), p.indexOf('## Flags'));
    expect(chapterSection.match(/^ {4}- h_/gm)).toHaveLength(15);
    expect(chapterSection).toContain('…and 285 more in src/d');
    const filesSection = p.slice(p.indexOf('## Files'), p.indexOf('## Static analysis'));
    expect(filesSection.match(/^- \[test\]/gm)).toHaveLength(200);
    expect(filesSection).toMatch(/- src\/d\d\/: \d+ more file\(s\)/);
  });
});

describe('minor hunks', () => {
  const small = (id: string, extra = {}) => hunk(id, `${id}.ts`, [{ kind: 'add', text: 'x', newLine: 1 }], extra);
  const big = (id: string) =>
    hunk(
      id,
      `${id}.ts`,
      Array.from({ length: 5 }, (_, i) => ({ kind: 'add' as const, text: `l${i}`, newLine: i + 1 })),
    );

  it('picks small, low-risk hunks and never medium or high risk', () => {
    const t = makeTour(
      [small('h_000000000a'), small('h_000000000b'), small('h_000000000c', { risk: 2 }), big('h_000000000d')],
      [{ hunkIds: ['h_000000000a', 'h_000000000b', 'h_000000000c', 'h_000000000d'] }],
    );
    expect(minorHunkIds(t, t.chapters[0])).toEqual(['h_000000000a', 'h_000000000b']);
    const p = chapterPrompt(t, t.chapters[0]);
    expect(p).toContain('## Minor hunks (2)');
    expect(p).toContain(`id "${MINOR_SUMMARY_ID}"`);
  });

  it('treats every low-risk hunk of a very large supporting chapter as minor', () => {
    const hs = Array.from({ length: 41 }, (_, i) => big(`h_${String(i).padStart(10, '0')}`));
    const t = makeTour(hs, [{ kind: 'supporting', hunkIds: hs.map((h) => h.id) }]);
    expect(minorHunkIds(t, { ...t.chapters[0], hunkIds: hs.slice(0, 5).map((h) => h.id) })).toHaveLength(5);
  });

  it('gives minor hunks the shared summary unless narrated on their own', () => {
    const t = makeTour([small('h_000000000a'), small('h_000000000b'), big('h_000000000d')], [{ hunkIds: ['h_000000000a', 'h_000000000b', 'h_000000000d'] }]);
    const next = applyChapterResult(
      t,
      'c0',
      {
        hunks: [
          { id: 'h_000000000d', narration: 'main change', citesCode: true },
          { id: 'h_000000000b', narration: 'own note', citesCode: true },
          { id: MINOR_SUMMARY_ID, narration: 'Import and constant tweaks.', citesCode: true },
        ],
      },
      { minorIds: ['h_000000000a', 'h_000000000b'] },
    );
    expect(next.hunks.h_000000000a).toMatchObject({ narration: 'Import and constant tweaks.', narrationShared: true });
    expect(next.hunks.h_000000000b.narration).toBe('own note');
    expect(next.hunks.h_000000000b.narrationShared).toBeUndefined();
    expect(next.hunks.h_000000000d.narration).toBe('main change');
  });
});
