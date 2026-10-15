import { beforeEach, describe, expect, it, vi } from 'vitest';

// runPipeline's outside world is the gh CLI, git, and the agent. All three are faked; the
// static analysis in between runs for real on files written to a temp worktree.
vi.mock('../src/github/gh.js', () => ({
  fetchDiff: vi.fn(),
  fetchThreads: vi.fn(async () => [{ id: 'thread-1' }]),
  fetchReviews: vi.fn(async () => []),
  viewerLogin: vi.fn(async () => 'me'),
  getMentionUsers: vi.fn(async () => []),
}));
vi.mock('../src/git/worktree.js', () => ({
  listFiles: vi.fn(async () => []),
  diffBetween: vi.fn(async () => ''),
  hasCommit: vi.fn(async () => true),
  mergeBaseOf: vi.fn(async () => undefined), // no local merge base: the diff comes from GitHub
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
vi.mock('../src/github/sharedTour.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/github/sharedTour.js')>()),
  fetchSharedTour: vi.fn(async () => undefined),
}));
vi.mock('../src/agent/agent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/agent/agent.js')>()),
  analyzeBriefing: vi.fn(),
  analyzeChapter: vi.fn(),
}));

import { CHAPTER_CONCURRENCY, reuseLevel, runPipeline, sanitizeGraph } from '../src/pipeline.js';
import { fetchDiff, fetchThreads } from '../src/github/gh.js';
import { decodeSharedTour, encodeSharedTour, fetchSharedTour } from '../src/github/sharedTour.js';
import { parseUnifiedDiff } from '../src/diff/parse.js';
import { AgentUnavailableError, analyzeBriefing, analyzeChapter } from '../src/agent/agent.js';
import { routingIdentity } from '../src/agent/types.js';
import type { Tour } from '../src/types.js';
import { briefingFor, fakeStore, narrationFor, pr, tempWorktree } from './helpers/pipeline.js';
import { tour as makeTour } from './fixtures/tour.js';

const briefing = vi.mocked(analyzeBriefing);
const chapter = vi.mocked(analyzeChapter);

beforeEach(() => {
  vi.clearAllMocks();
});
const worktree = tempWorktree('gr-pipeline-');
const { writeModules, options } = worktree;

// Resolves when the signal aborts, the way an in-flight model call ends.
const untilAborted = (signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener('abort', () => resolve(), { once: true });
  });

describe('runPipeline', () => {
  it('returns a complete cached tour without fetching the diff or calling the agent', async () => {
    const cached = { repo: pr.repo, pr: pr.number, headSha: pr.headSha, complete: true, agentIdentity: routingIdentity(undefined), files: [], hunks: {}, existingThreads: [] } as unknown as Tour;
    const store = fakeStore(cached);
    const opts = options(store);

    const tour = await runPipeline(opts);

    expect(tour.existingThreads).toEqual([{ id: 'thread-1' }]); // live threads replace the cached ones
    expect(tour.viewer).toBe('me');
    expect(store.loadTour).toHaveBeenCalledWith('o/r', 7, 'head');
    expect(fetchDiff).not.toHaveBeenCalled();
    expect(briefing).not.toHaveBeenCalled();
    expect(chapter).not.toHaveBeenCalled();
    expect(store.saveTour).not.toHaveBeenCalled();
    // The cached tour is shown at once, then again with live threads.
    expect(opts.onTour).toHaveBeenCalledTimes(2);
    expect(vi.mocked(opts.onTour).mock.calls[0][0]).toBe(cached);
    expect(vi.mocked(opts.onTour).mock.calls[1][0]).toBe(tour);
    expect(cached.existingThreads).toEqual([]); // the first emission is never mutated
  });

  it('rebuilds a cached tour made with a different agent setup', async () => {
    const cached = { complete: true, agentIdentity: 'plain', files: [], hunks: {} } as unknown as Tour;
    const store = fakeStore(cached);
    vi.mocked(fetchDiff).mockResolvedValue(writeModules(1));
    briefing.mockImplementation(async (t) => briefingFor(t.chapters));
    chapter.mockImplementation(async (_t, c) => narrationFor(c));

    const tour = await runPipeline(options(store));

    expect(tour).not.toBe(cached);
    expect(fetchDiff).toHaveBeenCalledTimes(1);
    expect(briefing).toHaveBeenCalledTimes(1);
    expect(tour.complete).toBe(true);
    expect(Object.values(tour.hunks).every((h) => h.narration?.startsWith('narrated'))).toBe(true);
  });

  it('stops calling the agent once it becomes unavailable mid-narration', async () => {
    vi.mocked(fetchDiff).mockResolvedValue(writeModules(9));
    briefing.mockImplementation(async (t) => briefingFor(t.chapters));
    let failed = false;
    chapter.mockImplementation(async (_t, c, _cwd, _config, signal) => {
      if (chapter.mock.calls.length === 1) {
        failed = true;
        throw new AgentUnavailableError('model API 401');
      }
      // The other in-flight chapters finish only after the failure; their results must be dropped.
      await untilAborted(signal);
      return narrationFor(c);
    });
    const toursAfterFailure: Tour[] = [];
    const store = fakeStore();
    const opts = options(store, { onTour: (t) => void (failed && toursAfterFailure.push(t)) });

    const tour = await runPipeline(opts);

    // Six workers were already in flight (CHAPTER_CONCURRENCY); no further chapter started.
    expect(tour.chapters.filter((c) => c.kind === 'flow')).toHaveLength(9);
    expect(chapter).toHaveBeenCalledTimes(CHAPTER_CONCURRENCY);
    // Only the pipeline's own final update follows the failure; in-flight workers stay silent.
    expect(toursAfterFailure).toHaveLength(1);
    expect(toursAfterFailure[0].notes).toContain('Narration stopped early: model API 401');
    expect(Object.values(tour.hunks).some((h) => h.narration)).toBe(false);
    expect(tour.mode).toBe('agent');
    expect(tour.complete).toBe(false); // resumed on the next open
    expect(store.saveTour).toHaveBeenLastCalledWith(expect.objectContaining({ complete: false }));
  });

  it('falls back to plain mode when the briefing fails', async () => {
    vi.mocked(fetchDiff).mockResolvedValue(writeModules(2));
    briefing.mockRejectedValue(new AgentUnavailableError('no login'));
    const store = fakeStore();

    const tour = await runPipeline(options(store));

    expect(chapter).not.toHaveBeenCalled();
    expect(tour.mode).toBe('plain');
    expect(tour.flags[0]).toMatchObject({ kind: 'model-unavailable' });
    expect(tour.complete).toBe(false);
  });

  it('stops the run when the caller aborts during narration', async () => {
    vi.mocked(fetchDiff).mockResolvedValue(writeModules(6));
    briefing.mockImplementation(async (t) => briefingFor(t.chapters));
    const controller = new AbortController();
    let aborted = false;
    chapter.mockImplementation(async (_t, c, _cwd, _config, signal) => {
      if (chapter.mock.calls.length === 2) {
        aborted = true;
        controller.abort(new Error('user quit'));
      }
      await untilAborted(signal);
      throw new Error('aborted');
    });
    const toursAfterAbort: Tour[] = [];
    const store = fakeStore();

    await expect(runPipeline(options(store, { signal: controller.signal, onTour: (t) => void (aborted && toursAfterAbort.push(t)) }))).rejects.toThrow('user quit');

    expect(chapter.mock.calls.length).toBeLessThanOrEqual(3);
    expect(toursAfterAbort).toEqual([]);
    expect(store.saveTour).not.toHaveBeenCalledWith(expect.objectContaining({ complete: true }));
    expect(store.saveTour).toHaveBeenCalledTimes(1); // the briefing save only
  });

  it('does nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const store = fakeStore();
    const opts = options(store, { signal: controller.signal });

    await expect(runPipeline(opts)).rejects.toThrow('cancelled');

    expect(store.loadTour).not.toHaveBeenCalled();
    expect(fetchThreads).not.toHaveBeenCalled();
    expect(briefing).not.toHaveBeenCalled();
    expect(opts.onTour).not.toHaveBeenCalled();
  });
});

describe('sanitizeGraph', () => {
  const tour = { hunks: { h_a7722cb814: { file: 'src/types/offer.ts', newStart: 12, oldStart: 12 } } } as unknown as Tour;
  const node = (id: string, hunkId?: string) => ({ id, label: id, hunkId });

  it('drops graphs with fewer than three nodes', () => {
    const g = { kind: 'before-after' as const, title: 't', nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b' }] };
    expect(sanitizeGraph(g, tour)).toBeUndefined();
  });

  it('drops a before/after graph with a single node on one side', () => {
    const g = {
      kind: 'before-after' as const,
      title: 't',
      nodes: [
        { ...node('a'), group: 'before' },
        { ...node('b'), group: 'after' },
        { ...node('c'), group: 'after' },
      ],
      edges: [{ from: 'b', to: 'c' }],
    };
    expect(sanitizeGraph(g, tour)).toBeUndefined();
  });

  it('humanizes hunk ids and drops dangling hunk ids and edges', () => {
    const g = {
      kind: 'call' as const,
      title: 'Field replacement [h_a7722cb814]',
      nodes: [{ id: 'a', label: 'see h_a7722cb814', hunkId: 'h_a7722cb814' }, node('b', 'h_0000000000'), node('c')],
      edges: [
        { from: 'a', to: 'b', label: 'replaced in h_a7722cb814' },
        { from: 'b', to: 'missing' },
      ],
    };
    const out = sanitizeGraph(g, tour)!;
    expect(out.title).toBe('Field replacement [offer.ts:12]');
    expect(out.nodes.map((n) => [n.label, n.hunkId])).toEqual([
      ['see offer.ts:12', 'h_a7722cb814'],
      ['b', undefined],
      ['c', undefined],
    ]);
    expect(out.edges).toEqual([{ from: 'a', to: 'b', label: 'replaced in offer.ts:12' }]);
  });
});

describe('runPipeline with a tour shared on the PR', () => {
  function sharedTourFor(diff: string, extra: Partial<Tour> = {}): Tour {
    const { files, hunks } = parseUnifiedDiff(diff);
    return makeTour(hunks, [], {
      repo: pr.repo,
      pr: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author,
      headSha: pr.headSha,
      createdAt: '2026-10-09T00:00:00Z',
      mode: 'agent',
      intent: 'Built in CI.',
      files,
      agentIdentity: 'ci-models',
      complete: true,
      source: 'shared',
      ...extra,
    });
  }

  // The tour as the reader gets it from the comment.
  const posted = (tour: Tour) => decodeSharedTour(encodeSharedTour(tour), { repo: pr.repo, pr: pr.number, headSha: pr.headSha });

  it('opens the shared tour instead of building one, with live threads', async () => {
    const diff = writeModules(1);
    vi.mocked(fetchDiff).mockResolvedValue(diff);
    vi.mocked(fetchSharedTour).mockResolvedValueOnce(posted(sharedTourFor(diff)));
    const store = fakeStore();

    const tour = await runPipeline(options(store));

    expect(fetchSharedTour).toHaveBeenCalledWith('o/r', 7, 'head', undefined);
    expect(tour.intent).toBe('Built in CI.');
    expect(tour.source).toBe('shared');
    expect(tour.existingThreads).toEqual([{ id: 'thread-1' }]);
    expect(tour.viewer).toBe('me');
    expect(briefing).not.toHaveBeenCalled();
    expect(chapter).not.toHaveBeenCalled();
    expect(store.saveTour).toHaveBeenCalledWith(tour);
  });

  it('builds its own tour when the shared one does not match the diff', async () => {
    const diff = writeModules(1);
    vi.mocked(fetchDiff).mockResolvedValue(diff);
    vi.mocked(fetchSharedTour).mockResolvedValueOnce(posted(sharedTourFor(diff.replace('return 0;', 'return 9;'))));
    briefing.mockImplementation(async (t) => briefingFor(t.chapters));
    chapter.mockImplementation(async (_t, c) => narrationFor(c));

    const tour = await runPipeline(options(fakeStore()));

    expect(tour.intent).not.toBe('Built in CI.');
    expect(briefing).toHaveBeenCalled();
  });

  it('does not look for a shared tour with --fresh or in preview', async () => {
    vi.mocked(fetchDiff).mockResolvedValue(writeModules(1));
    await runPipeline(options(fakeStore(), { fresh: true, noAgent: true }));
    await runPipeline(options(fakeStore(), { diffOverride: writeModules(1), noAgent: true }));
    expect(fetchSharedTour).not.toHaveBeenCalled();
  });

  it('reuses a saved shared tour whatever models this reader has configured', () => {
    const saved = { complete: true, source: 'shared', mode: 'agent', agentIdentity: 'ci-models' } as Tour;
    expect(reuseLevel(saved, routingIdentity(undefined))).toBe('complete');
    expect(reuseLevel(saved, 'plain')).toBe('complete');
    expect(reuseLevel({ ...saved, complete: false }, 'plain')).toBe('none');
  });
});
