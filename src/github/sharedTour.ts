import { gunzipSync, gzipSync } from 'node:zlib';
import type { Tour } from '../types.js';
import { parseTourDiff } from '../diff/fuse.js';
import { githubAuth } from './auth.js';
import { restJson, restPages } from './api.js';
import { gh, ghHttpStatus } from './gh.js';

// A tour built in CI and posted to the PR as a comment, so reviewers open it without
// rebuilding it. The tour travels gzipped and base64-encoded inside an HTML comment; base64
// never contains "--", so it cannot close the comment early.

const MARKER = '<!-- guided-review:tour';
const DATA_PREFIX = '<!-- guided-review:data v1 ';
// GitHub rejects comment bodies over 65,536 characters.
export const MAX_COMMENT_CHARS = 65_536;

// Only comments by these accounts are imported. github-actions[bot] posts with a workflow's
// GITHUB_TOKEN, which only the repository's own workflows hold.
export const TRUSTED_AUTHORS = ['github-actions[bot]'];

export class SharedTourTooLargeError extends Error {}

// Drops what belongs to one reader rather than to the PR: live threads and reviews (refetched
// on open), the viewer, re-review deltas (computed against the reader's own history) and model
// sessions (unusable on another machine).
export function shareableTour(tour: Tour): Tour {
  const out: Tour = { ...tour, existingThreads: [] };
  for (const key of ['existingReviews', 'viewer', 'mentionUsers', 'rereview', 'agentSessions', 'source'] as const) delete out[key];
  return out;
}

export function encodeSharedTour(tour: Tour, opts: { command?: string } = {}): string {
  const data = gzipSync(JSON.stringify(shareableTour(tour)), { level: 9 }).toString('base64');
  const command = opts.command ?? `gr review ${tour.pr}`;
  const body = [
    `${MARKER} head=${tour.headSha} -->`,
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
export function decodeSharedTour(body: string, expect: { repo: string; pr: number; headSha: string }): Tour | undefined {
  if (!isSharedTourComment(body)) return undefined;
  const start = body.indexOf(DATA_PREFIX);
  if (start < 0) return undefined;
  const end = body.indexOf(' -->', start + DATA_PREFIX.length);
  if (end < 0) return undefined;
  let tour: Tour;
  try {
    tour = JSON.parse(gunzipSync(Buffer.from(body.slice(start + DATA_PREFIX.length, end), 'base64'), { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')) as Tour;
  } catch {
    return undefined;
  }
  if (!tour || typeof tour !== 'object' || tour.version !== 1) return undefined;
  if (tour.repo !== expect.repo || tour.pr !== expect.pr || tour.headSha !== expect.headSha || !tour.complete) return undefined;
  if (!Array.isArray(tour.chapters) || !Array.isArray(tour.files) || !tour.hunks || typeof tour.hunks !== 'object' || Array.isArray(tour.hunks)) return undefined;
  return { ...shareableTour(tour), source: 'shared' };
}

// The comment is written by CI, not by the reader, so the code it shows must be the PR's code:
// every file and hunk must match the diff the reader fetched, line for line, including the
// context fused hunks read from the reader's own checkout.
export function matchesDiff(tour: Tour, diff: string, readHead: (path: string) => string | undefined): boolean {
  const { files, hunks } = parseTourDiff(diff, readHead);
  if (files.length !== tour.files.length || hunks.length !== Object.keys(tour.hunks).length) return false;
  const sharedFiles = new Map(tour.files.map((f) => [f.path, f]));
  for (const f of files) {
    const s = sharedFiles.get(f.path);
    if (!s || s.oldPath !== f.oldPath || s.status !== f.status || s.binary !== f.binary || s.hunkIds.join() !== f.hunkIds.join()) return false;
  }
  for (const h of hunks) {
    const s = tour.hunks[h.id];
    // The content hash keys read state, and a moved note tells the reader a block is old code:
    // neither may be the CI's word alone.
    if (!s || s.file !== h.file || s.header !== h.header || s.contentHash !== h.contentHash || s.lines.length !== h.lines.length) return false;
    for (let i = 0; i < h.lines.length; i++) {
      const a = h.lines[i];
      const b = s.lines[i];
      if (a.kind !== b.kind || a.text !== b.text || a.oldLine !== b.oldLine || a.newLine !== b.newLine || !a.expanded !== !b.expanded) return false;
      if (a.moved?.file !== b.moved?.file || a.moved?.line !== b.moved?.line) return false;
    }
  }
  return true;
}

interface CommentRow {
  id: number;
  body: string;
  login: string;
}

async function tourComments(repo: string, pr: number, signal?: AbortSignal): Promise<CommentRow[]> {
  const auth = githubAuth();
  if (auth) {
    const pages = await restPages<{ id: number; body: string | null; user: { login: string } | null }>(auth, `repos/${repo}/issues/${pr}/comments?per_page=100`, { signal });
    return pages
      .flat()
      .filter((c) => c.body?.startsWith(MARKER))
      .map((c) => ({ id: c.id, body: c.body!, login: c.user?.login ?? '' }));
  }
  const out = await gh(['api', '--paginate', `repos/${repo}/issues/${pr}/comments`, '--jq', `.[] | select(.body | startswith("${MARKER}")) | {id, body, login: .user.login} | tojson`], {
    signal,
    maxBuffer: 256 * 1024 * 1024,
  });
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CommentRow);
}

// The newest valid shared tour for this head, or undefined. Lookup failures are not errors:
// the caller builds the tour itself.
export async function fetchSharedTour(repo: string, pr: number, headSha: string, signal?: AbortSignal): Promise<Tour | undefined> {
  const comments = await tourComments(repo, pr, signal).catch(() => {
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
