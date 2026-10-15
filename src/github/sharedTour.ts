import { gunzipSync, gzipSync } from 'node:zlib';
import type { Hunk, TestLink, Tour } from '../types.js';
import { parseTourDiff } from '../diff/fuse.js';
import { markMovedLines, unmovedFiles } from '../diff/moves.js';
import { githubAuth } from './auth.js';
import { restJson, restPages } from './api.js';
import { gh, ghHttpStatus } from './gh.js';

// A tour built in CI and posted to the PR as a comment, so reviewers open it without
// rebuilding it. The tour travels gzipped and base64-encoded inside an HTML comment; base64
// never contains "--", so it cannot close the comment early.

const MARKER = '<!-- guided-review:tour';
const DATA_PREFIX = '<!-- guided-review:data v2 ';
// GitHub rejects comment bodies over 65,536 characters.
export const MAX_COMMENT_CHARS = 65_536;

// Only comments by these accounts are imported. github-actions[bot] posts with a workflow's
// GITHUB_TOKEN, which only the repository's own workflows hold.
export const TRUSTED_AUTHORS = ['github-actions[bot]'];

export class SharedTourTooLargeError extends Error {}

// The tour as the comment carries it: without the code, which is most of a tour's size. The
// reader fills hunk lines in from its own diff, and test and covered-code snippets from its own
// checkout of the head, so the code it shows is never the CI's word.
type SharedTestLink = Omit<TestLink, 'lines' | 'diffHunks' | 'testFileStatus' | 'testChange'> & { lineCount: number };
type SharedCovers = Omit<NonNullable<Hunk['covers']>, 'lines'> & { lineCount: number };
type SharedHunk = Omit<Hunk, 'lines' | 'tests' | 'covers'> & { tests: SharedTestLink[]; covers?: SharedCovers };
export type SharedTour = Omit<Tour, 'hunks'> & { hunks: Record<string, SharedHunk> };

// Drops what belongs to one reader rather than to the PR: live threads and reviews (refetched
// on open), the viewer, re-review deltas (computed against the reader's own history) and model
// sessions (unusable on another machine).
export function shareableTour<T extends Tour | SharedTour>(tour: T): T {
  const out: T = { ...tour, existingThreads: [] };
  for (const key of ['existingReviews', 'viewer', 'mentionUsers', 'rereview', 'agentSessions', 'source'] as const) delete out[key];
  return out;
}

export function compactTour(tour: Tour): SharedTour {
  const hunks: Record<string, SharedHunk> = {};
  for (const [id, h] of Object.entries(tour.hunks)) {
    const hunk: SharedHunk & Partial<Pick<Hunk, 'lines'>> = {
      ...h,
      covers: undefined,
      tests: h.tests.map((link) => {
        const out: SharedTestLink & Partial<TestLink> = { ...link, lineCount: link.lines.length };
        // diffHunks and the fields beside it are derived from the diff: the reader attaches them again.
        for (const key of ['lines', 'diffHunks', 'testFileStatus', 'testChange'] as const) delete out[key];
        return out;
      }),
    };
    delete hunk.lines;
    if (h.covers) {
      const covers: SharedCovers & Partial<Pick<NonNullable<Hunk['covers']>, 'lines'>> = { ...h.covers, lineCount: h.covers.lines.length };
      delete covers.lines;
      hunk.covers = covers;
    } else delete hunk.covers;
    hunks[id] = hunk;
  }
  return { ...shareableTour(tour), hunks };
}

export function encodeSharedTour(tour: Tour, opts: { command?: string } = {}): string {
  const data = gzipSync(JSON.stringify(compactTour(tour)), { level: 9 }).toString('base64');
  const command = opts.command ?? `gr review ${tour.pr}`;
  const body = [
    headerFor(tour.headSha),
    `**Guided Review tour** for \`${tour.headSha.slice(0, 8)}\` is ready. Run \`${command}\` to open it without rebuilding.`,
    '',
    `<sub>${tour.chapters.length} chapters · ${Object.keys(tour.hunks).length} hunks · built ${tour.createdAt}</sub>`,
    '',
    `${DATA_PREFIX}${data} -->`,
  ].join('\n');
  if (body.length > MAX_COMMENT_CHARS) {
    throw new SharedTourTooLargeError(`the tour is ${body.length} characters encoded, over GitHub's ${MAX_COMMENT_CHARS}-character comment limit`);
  }
  return body;
}

export function isSharedTourComment(body: string): boolean {
  return body.startsWith(MARKER);
}

// Returns the tour only when it is complete and for exactly this PR head.
export function decodeSharedTour(body: string, expect: { repo: string; pr: number; headSha: string }): SharedTour | undefined {
  if (!isSharedTourComment(body)) return undefined;
  const start = body.indexOf(DATA_PREFIX);
  if (start < 0) return undefined;
  const end = body.indexOf(' -->', start + DATA_PREFIX.length);
  if (end < 0) return undefined;
  let tour: SharedTour;
  try {
    tour = JSON.parse(gunzipSync(Buffer.from(body.slice(start + DATA_PREFIX.length, end), 'base64'), { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')) as SharedTour;
  } catch {
    return undefined;
  }
  if (!tour || typeof tour !== 'object' || tour.version !== 1) return undefined;
  if (tour.repo !== expect.repo || tour.pr !== expect.pr || tour.headSha !== expect.headSha || !tour.complete) return undefined;
  if (!Array.isArray(tour.chapters) || !Array.isArray(tour.files) || !tour.hunks || typeof tour.hunks !== 'object' || Array.isArray(tour.hunks)) return undefined;
  if (!Object.values(tour.hunks).every((h) => h && Array.isArray(h.tests))) return undefined;
  // Stripped again on the way in: per-reader fields come from the reader, never the comment.
  return { ...shareableTour(tour), source: 'shared' };
}

// The comment is written by CI, not by the reader, so it must describe the PR's code: every file
// and hunk must match the diff the reader fetched, including the context fused hunks read from
// the reader's own checkout. The code itself then comes from the reader's diff and checkout.
// Returns undefined when anything does not match.
export function restoreSharedTour(shared: SharedTour, diff: string, readHead: (path: string) => string | undefined): Tour | undefined {
  const { files, hunks } = parseTourDiff(diff, readHead);
  if (files.length !== shared.files.length || hunks.length !== Object.keys(shared.hunks).length) return undefined;
  const sharedFiles = new Map(shared.files.map((f) => [f.path, f]));
  for (const f of files) {
    const s = sharedFiles.get(f.path);
    if (!s || s.oldPath !== f.oldPath || s.status !== f.status || s.binary !== f.binary || s.hunkIds.join() !== f.hunkIds.join()) return undefined;
  }
  // A snippet of the head: exactly `count` lines from 1-based `start`, or undefined. Many links
  // can point into one test file, so each file is split once.
  const split = new Map<string, string[] | undefined>();
  const headLines = (file: unknown, start: unknown, count: unknown): string[] | undefined => {
    if (typeof file !== 'string' || !Number.isInteger(start) || (start as number) < 1 || !Number.isInteger(count) || (count as number) < 0) return undefined;
    if (count === 0) return [];
    if (!split.has(file)) split.set(file, readHead(file)?.split('\n'));
    const lines = split.get(file)?.slice((start as number) - 1, (start as number) - 1 + (count as number));
    return lines?.length === count ? lines : undefined;
  };
  const out: Record<string, Hunk> = {};
  for (const h of hunks) {
    const s = shared.hunks[h.id];
    if (!s || s.file !== h.file || s.oldFile !== h.oldFile || s.header !== h.header || s.contentHash !== h.contentHash || s.parts?.join() !== h.parts?.join()) return undefined;
    if (s.oldStart !== h.oldStart || s.oldLines !== h.oldLines || s.newStart !== h.newStart || s.newLines !== h.newLines) return undefined;
    const { tests: sharedTests, covers: sharedCovers, ...rest } = s;
    const hunk: Hunk = { ...rest, lines: h.lines, tests: [] };
    for (const { lineCount, ...link } of sharedTests) {
      const lines = headLines(link.testFile, link.startLine, lineCount);
      if (!lines) return undefined;
      hunk.tests.push({ ...link, lines });
    }
    if (sharedCovers) {
      const { lineCount, ...c } = sharedCovers;
      const lines = headLines(c.file, c.startLine, lineCount);
      if (!lines) return undefined;
      hunk.covers = { ...c, lines };
    }
    out[h.id] = hunk;
  }
  // Moves are marked on the reader's lines, leaving out what the tour classified as generated.
  markMovedLines(hunks, readHead, unmovedFiles(shared.files));
  return { ...shared, hunks: out };
}

interface CommentRow {
  id: number;
  body: string;
  login: string;
}

// The first line of a tour comment, which names the head it was built for.
const headerFor = (headSha: string) => `${MARKER} head=${headSha} -->`;

// Comments whose body starts with `prefix`: any tour comment by default, or one for a given head.
async function tourComments(repo: string, pr: number, signal?: AbortSignal, prefix = MARKER): Promise<CommentRow[]> {
  const auth = githubAuth();
  if (auth) {
    const pages = await restPages<{ id: number; body: string | null; user: { login: string } | null }>(auth, `repos/${repo}/issues/${pr}/comments?per_page=100`, { signal });
    return pages
      .flat()
      .filter((c) => c.body?.startsWith(prefix))
      .map((c) => ({ id: c.id, body: c.body!, login: c.user?.login ?? '' }));
  }
  const out = await gh(
    ['api', '--paginate', `repos/${repo}/issues/${pr}/comments`, '--jq', `.[] | select(.body // "" | startswith(${JSON.stringify(prefix)})) | {id, body, login: .user.login} | tojson`],
    {
      signal,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CommentRow);
}

// The newest valid shared tour for this head, or undefined. Comments built for another head are
// skipped by their first line, before their data is decoded (or, through gh, even read). Lookup
// failures are not errors: the caller builds the tour itself.
export async function fetchSharedTour(repo: string, pr: number, headSha: string, signal?: AbortSignal): Promise<SharedTour | undefined> {
  const comments = await tourComments(repo, pr, signal, headerFor(headSha)).catch(() => {
    signal?.throwIfAborted();
    return [];
  });
  for (const c of comments.reverse()) {
    if (!TRUSTED_AUTHORS.includes(c.login)) continue;
    const tour = decodeSharedTour(c.body, { repo, pr, headSha });
    if (tour) return tour;
  }
  return undefined;
}

// Posts the tour, replacing an earlier tour comment by the same CI account so the PR keeps one.
export async function postSharedTour(repo: string, pr: number, body: string): Promise<string> {
  const existing = (await tourComments(repo, pr)).filter((c) => TRUSTED_AUTHORS.includes(c.login)).pop();
  const input = JSON.stringify({ body });
  const auth = githubAuth();
  const send = async (method: 'PATCH' | 'POST', path: string) =>
    auth
      ? (await restJson<{ html_url: string }>(auth, path, { method, body: { body } })).html_url
      : (await gh(['api', '--method', method, path, '--input', '-', '--jq', '.html_url'], { input })).trim();
  if (existing) {
    try {
      return await send('PATCH', `repos/${repo}/issues/comments/${existing.id}`);
    } catch (e) {
      // 403/404: written by another account than this token's, or deleted meanwhile: post a new
      // one. Any other failure may have edited it anyway, and a POST would duplicate it.
      const status = ghHttpStatus(e);
      if (status !== 403 && status !== 404) throw e;
    }
  }
  return send('POST', `repos/${repo}/issues/${pr}/comments`);
}
