import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));

import { run } from '../src/util/exec.js';
import { compactTour, decodeSharedTour, encodeSharedTour, fetchSharedTour, MAX_COMMENT_CHARS, postSharedTour, restoreSharedTour, SharedTourTooLargeError } from '../src/github/sharedTour.js';
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
    expect(decodeSharedTour('<!-- guided-review:tour -->\n<!-- guided-review:data v2 not-gzip -->', expected)).toBeUndefined();
    expect(decodeSharedTour('LGTM', expected)).toBeUndefined();
  });

  it('refuses a tour over the comment size limit', () => {
    // Random text barely compresses.
    const noise = Array.from({ length: MAX_COMMENT_CHARS }, () => Math.random().toString(36).slice(2)).join('');
    expect(() => encodeSharedTour(builtTour({ intent: noise }))).toThrow(SharedTourTooLargeError);
  });

  it("leaves the code out of the comment and restores it from the reader's diff and checkout", () => {
    const tour = builtTour();
    const [id] = Object.keys(tour.hunks);
    tour.hunks[id].tests = [
      { testFile: 'test/a.test.ts', testName: 'returns 2', startLine: 2, lines: ['it("returns 2", () => {', '  expect(a()).toBe(2);', '});'], source: 'name-match', confidence: 0.65 },
      { testFile: 'coverage', testName: 'all added lines executed in coverage run', startLine: 1, lines: [], source: 'coverage', confidence: 0.95 },
    ];
    tour.hunks[id].covers = { file: 'src/b.ts', startLine: 1, lines: ['export const b = 1;'] };
    const head: Record<string, string> = {
      'test/a.test.ts': 'import { a } from "../src/a";\nit("returns 2", () => {\n  expect(a()).toBe(2);\n});\n',
      'src/b.ts': 'export const b = 1;\n',
    };

    const body = encodeSharedTour(tour);
    const shared = decodeSharedTour(body, expected)!;
    expect(JSON.stringify(shared)).not.toContain('return 2;');
    expect(JSON.stringify(shared)).not.toContain('toBe(2)');

    const restored = restoreSharedTour(shared, diff, (p) => head[p])!;
    expect(restored.hunks[id].lines).toEqual(tour.hunks[id].lines);
    expect(restored.hunks[id].tests.map((t) => t.lines)).toEqual(tour.hunks[id].tests.map((t) => t.lines));
    expect(restored.hunks[id].covers).toEqual(tour.hunks[id].covers);
    expect(restored.hunks[id].narration).toBe('Bumps the value.');

    // A snippet the reader's checkout cannot supply means the tour is not for this code.
    expect(restoreSharedTour(shared, diff, (p) => (p === 'src/b.ts' ? head[p] : undefined))).toBeUndefined();
    expect(restoreSharedTour(shared, diff, (p) => (p === 'src/b.ts' ? undefined : head[p]))).toBeUndefined();

    // Snippet fields that do not describe a run of head lines.
    for (const bad of [{ lineCount: undefined }, { lineCount: -1 }, { lineCount: 1.5 }, { startLine: 0 }, { testFile: 7 }]) {
      const forged = structuredClone(shared);
      Object.assign(forged.hunks[id].tests[0], bad);
      expect(restoreSharedTour(forged, diff, (p) => head[p])).toBeUndefined();
    }
  });

  it('marks moved code on the restored lines, leaving out files the tour classified as generated', () => {
    const steps = ['charge(order.card, order.total);', 'sendReceipt(order.customer);', 'markPaid(order.id);', "notify(order.customer, 'paid');", "audit.log('order', order.id);", 'return order;'];
    // The six lines leave src/a.ts and arrive in src/b.ts.
    const file = (p: string, header: string, sign: string) =>
      `diff --git a/${p} b/${p}\nindex 1111111..2222222 100644\n--- a/${p}\n+++ b/${p}\n${header}\n ok();\n${steps.map((l) => `${sign}${l}\n`).join('')}`;
    const moveDiff = file('src/a.ts', '@@ -1,7 +1,1 @@', '-') + file('src/b.ts', '@@ -1,1 +1,7 @@', '+');
    for (const [kind, marked] of [
      ['logic', true],
      ['generated', false],
    ] as const) {
      const { files, hunks } = parseUnifiedDiff(moveDiff);
      files.find((f) => f.path === 'src/b.ts')!.kind = kind;
      const t = makeTour(hunks, [{ hunkIds: hunks.map((h) => h.id) }], { pr: 7, files, complete: true });
      const restored = restoreSharedTour(decodeSharedTour(encodeSharedTour(t), expected)!, moveDiff, () => undefined)!;
      expect(Object.values(restored.hunks).some((h) => h.lines.some((l) => l.moved))).toBe(marked);
    }
  });

  it('accepts a tour only when it matches the diff hunk for hunk', () => {
    const noHead = () => undefined;
    const shared = compactTour(builtTour());
    expect(restoreSharedTour(shared, diff, noHead)).toBeDefined();

    const [id] = Object.keys(shared.hunks);
    const fakeHash = structuredClone(shared);
    fakeHash.hunks[id].contentHash = 'other';
    expect(restoreSharedTour(fakeHash, diff, noHead)).toBeUndefined();
    const fakeRange = structuredClone(shared);
    fakeRange.hunks[id].newLines = 9;
    expect(restoreSharedTour(fakeRange, diff, noHead)).toBeUndefined();

    expect(restoreSharedTour(shared, diff.replace('return 2;', 'return 4;'), noHead)).toBeUndefined();
    expect(restoreSharedTour(shared, '', noHead)).toBeUndefined();
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
  it('asks gh only for comments built for this head', async () => {
    const comment = (body: string) => JSON.stringify({ id: 1, body, login: 'github-actions[bot]' }) + '\n';
    vi.mocked(run)
      .mockReset()
      .mockResolvedValueOnce(comment(encodeSharedTour(builtTour())));
    expect((await fetchSharedTour('o/r', 7, 'head'))?.intent).toBe('Returns 2.');
    const args = vi.mocked(run).mock.calls[0][1];
    expect(args[args.indexOf('--jq') + 1]).toContain('startswith("<!-- guided-review:tour head=head -->")');
  });

  it('treats a failed lookup as no tour, but still rejects when aborted', async () => {
    vi.mocked(run).mockRejectedValue(new Error('offline'));
    expect(await fetchSharedTour('o/r', 7, 'head')).toBeUndefined();
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(fetchSharedTour('o/r', 7, 'head', controller.signal)).rejects.toThrow('stop');
  });
});
