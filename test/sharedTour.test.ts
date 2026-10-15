import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));

import { run } from '../src/util/exec.js';
import { decodeSharedTour, encodeSharedTour, fetchSharedTour, matchesDiff, MAX_COMMENT_CHARS, postSharedTour, SharedTourTooLargeError } from '../src/github/sharedTour.js';
import { parseUnifiedDiff } from '../src/diff/parse.js';
import type { Tour } from '../src/types.js';
import { tour as makeTour } from './fixtures/tour.js';

const diff = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 export function a() {
-  return 1;
+  return 2;
 }
`;

function builtTour(extra: Partial<Tour> = {}): Tour {
  const { files, hunks } = parseUnifiedDiff(diff);
  return makeTour(
    hunks.map((h) => ({ ...h, narration: 'Bumps the value.' })),
    [{ title: 'a', risk: 1, hunkIds: hunks.map((h) => h.id), narrated: true }],
    {
      pr: 7,
      title: 'Change a',
      url: 'https://github.com/o/r/pull/7',
      createdAt: '2026-10-09T00:00:00Z',
      mode: 'agent',
      intent: 'Returns 2.',
      files,
      existingThreads: [{ id: 't', path: 'src/a.ts', isResolved: false, isOutdated: false, comments: [] }],
      viewer: 'ci',
      agentSessions: { qa: 'session-1' },
      complete: true,
      ...extra,
    },
  );
}

const expected = { repo: 'o/r', pr: 7, headSha: 'head' };

describe('shared tours', () => {
  it('round-trips a tour through a comment, without per-reader state', () => {
    const body = encodeSharedTour(builtTour());
    expect(body).toMatch(/^<!-- guided-review:tour head=head -->/);
    expect(body).toContain('`gr review 7`');

    const tour = decodeSharedTour(body, expected)!;
    expect(tour.source).toBe('shared');
    expect(tour.intent).toBe('Returns 2.');
    expect(Object.values(tour.hunks)[0].narration).toBe('Bumps the value.');
    expect(tour.existingThreads).toEqual([]);
    expect(tour.viewer).toBeUndefined();
    expect(tour.agentSessions).toBeUndefined();
  });

  it('rejects a tour for another head, PR, or repo, an unfinished tour, and garbage', () => {
    const body = encodeSharedTour(builtTour());
    expect(decodeSharedTour(body, { ...expected, headSha: 'newer' })).toBeUndefined();
    expect(decodeSharedTour(body, { ...expected, pr: 8 })).toBeUndefined();
    expect(decodeSharedTour(body, { ...expected, repo: 'x/y' })).toBeUndefined();
    expect(decodeSharedTour(encodeSharedTour(builtTour({ complete: false })), expected)).toBeUndefined();
    expect(decodeSharedTour('<!-- guided-review:tour -->\n<!-- guided-review:data v1 not-gzip -->', expected)).toBeUndefined();
    expect(decodeSharedTour('LGTM', expected)).toBeUndefined();
  });

  it('refuses a tour over the comment size limit', () => {
    // Random text barely compresses.
    const noise = Array.from({ length: MAX_COMMENT_CHARS }, () => Math.random().toString(36).slice(2)).join('');
    expect(() => encodeSharedTour(builtTour({ intent: noise }))).toThrow(SharedTourTooLargeError);
  });

  it('accepts a tour only when its code matches the diff line for line', () => {
    const noHead = () => undefined;
    const tour = builtTour();
    expect(matchesDiff(tour, diff, noHead)).toBe(true);

    const [id] = Object.keys(tour.hunks);
    const forged = structuredClone(tour);
    forged.hunks[id].lines[2].text = '  return 3;';
    expect(matchesDiff(forged, diff, noHead)).toBe(false);

    // A moved note or a content hash the reader's own diff does not produce.
    const fakeMove = structuredClone(tour);
    fakeMove.hunks[id].lines.find((l) => l.kind === 'add')!.moved = { file: 'src/old.ts', line: 12 };
    expect(matchesDiff(fakeMove, diff, noHead)).toBe(false);
    const fakeHash = structuredClone(tour);
    fakeHash.hunks[id].contentHash = 'other';
    expect(matchesDiff(fakeHash, diff, noHead)).toBe(false);

    expect(matchesDiff(tour, diff.replace('return 2;', 'return 4;'), noHead)).toBe(false);
    expect(matchesDiff(tour, '', noHead)).toBe(false);
  });
});

describe('postSharedTour', () => {
  const runMock = vi.mocked(run);
  const existing = JSON.stringify({ id: 5, body: '<!-- guided-review:tour head=old -->', login: 'github-actions[bot]' }) + '\n';
  // What run() rejects with when gh api gets an HTTP error.
  const ghFailure = (status: number) => Object.assign(new Error(`gh api failed: gh: HTTP ${status}`), { code: 1, stderr: `gh: Something (HTTP ${status})\n` });
  const methods = () => runMock.mock.calls.map(([, args]) => (args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET'));

  beforeEach(() => runMock.mockReset());

  it('edits the earlier tour comment in place', async () => {
    runMock.mockResolvedValueOnce(existing).mockResolvedValueOnce('https://github.com/o/r/pull/7#c5\n');
    expect(await postSharedTour('o/r', 7, 'body')).toBe('https://github.com/o/r/pull/7#c5');
    expect(methods()).toEqual(['GET', 'PATCH']);
  });

  it('posts a new comment when the old one belongs to another account', async () => {
    runMock.mockResolvedValueOnce(existing).mockRejectedValueOnce(ghFailure(403)).mockResolvedValueOnce('https://github.com/o/r/pull/7#c6\n');
    expect(await postSharedTour('o/r', 7, 'body')).toBe('https://github.com/o/r/pull/7#c6');
    expect(methods()).toEqual(['GET', 'PATCH', 'POST']);
  });

  it('fails without posting a duplicate when the edit fails otherwise', async () => {
    runMock.mockResolvedValueOnce(existing).mockRejectedValueOnce(ghFailure(500));
    await expect(postSharedTour('o/r', 7, 'body')).rejects.toThrow('HTTP 500');
    expect(methods()).toEqual(['GET', 'PATCH']);
  });
});

describe('fetchSharedTour', () => {
  it('treats a failed lookup as no tour, but still rejects when aborted', async () => {
    vi.mocked(run).mockRejectedValue(new Error('offline'));
    expect(await fetchSharedTour('o/r', 7, 'head')).toBeUndefined();
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(fetchSharedTour('o/r', 7, 'head', controller.signal)).rejects.toThrow('stop');
  });
});
