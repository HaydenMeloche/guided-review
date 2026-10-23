import type { CommentStatus, Draft, ExistingThread, Hunk, ReReview, Tour } from '../types.js';
import { parseUnifiedDiff } from '../diff/parse.js';
import { hunkKeys } from './hunkState.js';

export interface Span {
  start: number;
  end: number;
}

// Old-side line spans each hunk of the prev→next diff actually touched.
// Pure insertions touch the gap after the preceding old line.
export function changedSpans(hunk: Hunk): Span[] {
  const spans: Span[] = [];
  let lastOld = hunk.oldStart - 1;
  for (const l of hunk.lines) {
    if (l.kind === 'ctx') {
      lastOld = l.oldLine ?? lastOld + 1;
      continue;
    }
    const at = l.kind === 'del' ? (l.oldLine ?? lastOld + 1) : Math.max(lastOld, 1);
    if (l.kind === 'del') lastOld = at;
    const prev = spans[spans.length - 1];
    if (prev && at <= prev.end + 1) prev.end = Math.max(prev.end, at);
    else spans.push({ start: at, end: at });
  }
  return spans;
}

export function overlap(a: Span, b: Span): boolean {
  return a.start <= b.end && b.start <= a.end;
}

function fmtSpan(s: Span): string {
  return s.start === s.end ? `line ${s.start}` : `lines ${s.start}–${s.end}`;
}

// Draft and thread bodies compared as GitHub shows them: posting turns a code span that names a
// ref into a link with the span as its text, so a link around a lone code span reads as that span,
// and whitespace is collapsed.
const unlink = (s: string) => s.replace(/\[(`[^`\n]+`)\]\([^)\s]*\)/g, '$1');
const normalize = (s: string) => unlink(s).replace(/\s+/g, ' ').trim();
// Shorter keys only match a thread's start: "See" must not match any thread mentioning it.
const MIN_INCLUDES_KEY = 20;

// The thread a posted draft started: its comment reads as the draft's whole body after the label
// (a note or suggestion may follow), or, for a long enough body, holds it somewhere.
function findThread(d: Draft, file: string, threads: ExistingThread[], taken: Set<string>): ExistingThread | undefined {
  const key = normalize(d.body);
  if (!key) return undefined;
  const candidates = threads.filter((t) => t.path === file && !taken.has(t.id) && t.comments[0]);
  const text = (t: ExistingThread) => normalize(t.comments[0].body).replace(/^\*\*\[[a-z]+\]\*\* /, '');
  return candidates.find((t) => text(t) === key || text(t).startsWith(`${key} `)) ?? (key.length >= MIN_INCLUDES_KEY ? candidates.find((t) => text(t).includes(key)) : undefined);
}

export function computeReReview(prev: Tour, next: Tour, ctx: { postedDrafts: Draft[]; threads: ExistingThread[]; diffPrevToNext: string; viewer?: string }): ReReview {
  // New when any GitHub hunk it is made of is new: fusing alone never makes a hunk new.
  const prevHashes = new Set(Object.values(prev.hunks).flatMap(hunkKeys));
  const newHunkIds = Object.values(next.hunks)
    .filter((h) => hunkKeys(h).some((k) => !prevHashes.has(k)))
    .map((h) => h.id);

  const delta = parseUnifiedDiff(ctx.diffPrevToNext);
  const deltaHunks = (file: string) => delta.hunks.filter((h) => (h.oldFile ?? h.file) === file || h.file === file);
  const deletedFiles = new Set(delta.files.filter((f) => f.status === 'deleted').map((f) => f.path));
  const renamed = new Map(delta.files.filter((f) => f.status === 'renamed' && f.oldPath).map((f) => [f.oldPath!, f.path]));

  const status = (path: string, span: Span, resolved: boolean): Pick<CommentStatus, 'addressed' | 'reason'> => {
    if (resolved) return { addressed: true, reason: 'thread resolved' };
    if (deletedFiles.has(path)) return { addressed: true, reason: `${path} deleted since comment` };
    for (const h of deltaHunks(path)) {
      const hit = changedSpans(h).find((s) => overlap(s, span));
      if (hit) return { addressed: true, reason: `${fmtSpan(hit)} changed since comment` };
    }
    const to = renamed.get(path);
    return { addressed: false, reason: to ? `file renamed to ${to}; no change at commented line` : 'no change at commented line' };
  };

  const comments: CommentStatus[] = [];
  const matched = new Set<string>();

  for (const d of ctx.postedDrafts) {
    const a = d.anchor;
    if (a.type !== 'line' && a.type !== 'range') {
      comments.push({ body: d.body, addressed: false, reason: 'flow-level comment; check the flow again' });
      continue;
    }
    const thread = findThread(d, a.file, ctx.threads, matched);
    if (thread) matched.add(thread.id);
    if (a.side === 'LEFT') {
      comments.push({
        body: d.body,
        path: a.file,
        line: a.line,
        addressed: thread?.isResolved ?? false,
        reason: thread?.isResolved ? 'thread resolved' : 'comment on removed code; check by hand',
      });
      continue;
    }
    const span = { start: a.type === 'range' ? a.startLine : a.line, end: a.line };
    comments.push({ body: d.body, path: a.file, line: a.line, ...status(a.file, span, thread?.isResolved ?? false) });
  }

  // Threads the reviewer started on GitHub directly (or from another machine).
  if (ctx.viewer) {
    for (const t of ctx.threads) {
      if (matched.has(t.id) || t.comments[0]?.author !== ctx.viewer) continue;
      const line = t.originalLine ?? t.line;
      const body = t.comments[0].body;
      if (line === undefined) {
        comments.push({ body, path: t.path, addressed: t.isResolved, reason: t.isResolved ? 'thread resolved' : 'no line to check' });
        continue;
      }
      comments.push({ body, path: t.path, line, ...status(t.path, { start: line, end: line }, t.isResolved) });
    }
  }

  return { previousHead: prev.headSha, newHunkIds, comments };
}
