import type { CommentLabel, DiffLine, Draft, Hunk, ReadState, Tour } from '../types.js';
import type { ReviewPayload } from '../github/gh.js';
import { stateOf } from './hunkState.js';
import { linkRefs } from './refs.js';

export type Side = 'LEFT' | 'RIGHT';
type ReviewComment = ReviewPayload['comments'][number];

export const LABELS: CommentLabel[] = ['blocking', 'question', 'suggestion', 'nit'];

export function groupByLabel(drafts: Draft[]): Record<CommentLabel, Draft[]> {
  const groups: Record<CommentLabel, Draft[]> = { blocking: [], question: [], suggestion: [], nit: [] };
  for (const d of drafts) groups[d.label].push(d);
  return groups;
}

export interface PayloadOptions {
  host?: string; // web host for reference permalinks; callers pass githubWebHost()
  // Whether a suggestion written against an earlier head still replaces the same lines. By
  // default it applies only when written at the tour's head (or carries no meta).
  suggestionStillApplies?: (d: Draft) => boolean;
}

// Why a suggestion posts as plain code: its range was split, it moved to another line, it is on
// removed code (GitHub cannot apply those), or it was written against an earlier head.
export type DemotedReason = 'range-split' | 'moved' | 'left-side' | 'head-changed';

const defaultStillApplies = (headSha: string) => (d: Draft) => !d.suggestionMeta || d.suggestionMeta.headSha === headSha;

// The prose with each code span that names a ref as a link to it. A draft naming no ref comes out
// as typed, so its comment is byte for byte what it was before references existed.
function proseOf(d: Draft, host: string, repo: string): string {
  return linkRefs(d.body.trim(), d.refs ?? [], host, repo);
}

// `applicable`: the suggestion is offered as one GitHub can apply. It is not when the comment
// landed on fewer lines than the suggestion was written for: applying it would duplicate code.
function formatBody(d: Draft, ctx: { host: string; repo: string }, note?: string, applicable = true): string {
  let body = `**[${d.label}]** ${proseOf(d, ctx.host, ctx.repo)}`;
  if (d.suggestion !== undefined) body += `\n\n\`\`\`${applicable ? 'suggestion' : ''}\n${d.suggestion.replace(/\n$/, '')}\n\`\`\``;
  if (note) body += `\n\n${note}`;
  return body;
}

// The line number of `l` on `side`, when GitHub's diff has it there. Expanded context is not in it.
export const lineOn = (l: DiffLine, side: Side) => (l.expanded ? undefined : side === 'RIGHT' ? (l.kind !== 'del' ? l.newLine : undefined) : l.kind !== 'add' ? l.oldLine : undefined);

// Every line a review comment may attach to in this file, per side.
function diffLines(tour: Tour, file: string, side: Side): number[] {
  const out: number[] = [];
  for (const h of Object.values(tour.hunks)) {
    if (h.file !== file) continue;
    for (const l of h.lines) {
      const n = lineOn(l, side);
      if (n !== undefined) out.push(n);
    }
  }
  return out;
}

// Whether GitHub takes a comment over startLine..line: both ends in one of its hunks. A fused hunk
// is several of GitHub's, joined by expanded context, so the range must not cross that context.
export function sameDiffHunk(tour: Tour, file: string, startLine: number, line: number, side: Side): boolean {
  return Object.values(tour.hunks).some((h) => {
    if (h.file !== file) return false;
    const start = h.lines.findIndex((l) => lineOn(l, side) === startLine);
    const end = h.lines.findIndex((l) => lineOn(l, side) === line);
    return start >= 0 && end >= start && !h.lines.slice(start, end + 1).some((l) => l.expanded);
  });
}

// The line a flow- or node-level comment lands on: first added line, else the
// first context line, else the first deleted line on the old side.
function anchorLineForHunk(h: Hunk): { line: number; side: Side } | undefined {
  const add = h.lines.find((l) => l.kind === 'add');
  if (add?.newLine !== undefined) return { line: add.newLine, side: 'RIGHT' };
  const ctx = h.lines.find((l) => l.kind === 'ctx' && !l.expanded);
  if (ctx?.newLine !== undefined) return { line: ctx.newLine, side: 'RIGHT' };
  const del = h.lines.find((l) => l.kind === 'del');
  if (del?.oldLine !== undefined) return { line: del.oldLine, side: 'LEFT' };
  return undefined;
}

export function buildReviewPayload(
  tour: Tour,
  drafts: Draft[],
  event: ReviewPayload['event'],
  summary: string,
  opts: PayloadOptions = {},
): { payload: ReviewPayload; moved: { draftId: string; note: string }[]; demoted: { draftId: string; reason: DemotedReason }[] } {
  const ctx = { host: opts.host ?? 'github.com', repo: tour.repo };
  const stillApplies = opts.suggestionStillApplies ?? defaultStillApplies(tour.headSha);
  const comments: ReviewComment[] = [];
  const moved: { draftId: string; note: string }[] = [];
  const demoted: { draftId: string; reason: DemotedReason }[] = [];
  // Whether d's suggestion posts as one GitHub can apply; records why not when it has one.
  const applies = (d: Draft, blocked?: DemotedReason): boolean => {
    if (d.suggestion === undefined) return true;
    const side = d.anchor.type === 'line' || d.anchor.type === 'range' ? d.anchor.side : undefined;
    const reason = blocked ?? (side === 'LEFT' ? 'left-side' : !stillApplies(d) ? 'head-changed' : undefined);
    if (reason) demoted.push({ draftId: d.id, reason });
    return !reason;
  };
  const outside: { draft: Draft; where: string }[] = [];
  const flowLevel: { draft: Draft; where: string }[] = [];
  const chapterTitle = (id: string) => tour.chapters.find((c) => c.id === id)?.title ?? id;

  for (const d of drafts) {
    const a = d.anchor;
    if (a.type === 'line' || a.type === 'range') {
      const lines = diffLines(tour, a.file, a.side);
      if (lines.includes(a.line)) {
        // A range must start inside the same hunk to be accepted by GitHub; one that cannot keeps
        // only its last line, and its suggestion becomes plain code.
        const start = a.type === 'range' && a.startLine < a.line ? a.startLine : undefined;
        const keepsRange = start !== undefined && sameDiffHunk(tour, a.file, start, a.line, a.side);
        const note = start !== undefined && !keepsRange ? `_Originally on lines ${start}-${a.line}, which GitHub cannot take as one range._` : undefined;
        const c: ReviewComment = { path: a.file, body: formatBody(d, ctx, note, applies(d, note ? 'range-split' : undefined)), line: a.line, side: a.side };
        if (keepsRange) {
          c.start_line = start;
          c.start_side = a.side;
        }
        if (note)
          moved.push({
            draftId: d.id,
            note: `lines ${start}-${a.line} in ${a.file} span more than one GitHub hunk; posted on line ${a.line}${d.suggestion !== undefined ? ', with the suggestion as plain code' : ''}`,
          });
        comments.push(c);
        continue;
      }
      if (lines.length > 0) {
        const nearest = lines.reduce((best, l) => (Math.abs(l - a.line) < Math.abs(best - a.line) ? l : best));
        const note = `_Originally on line ${a.line}, which is no longer in the diff._`;
        comments.push({ path: a.file, body: formatBody(d, ctx, note, applies(d, 'moved')), line: nearest, side: a.side });
        moved.push({ draftId: d.id, note: `moved from line ${a.line} to nearest diff line ${nearest} in ${a.file}` });
      } else {
        outside.push({ draft: d, where: `${a.file}:${a.line}` });
        moved.push({ draftId: d.id, note: `${a.file} has no lines in the diff; posted in the review body` });
      }
      continue;
    }

    const chapter = tour.chapters.find((c) => c.id === a.chapterId);
    let hunkId: string | undefined;
    let where = `flow "${chapterTitle(a.chapterId)}"`;
    if (a.type === 'node') {
      const graphs = [chapter?.diagram, tour.overview].filter((g) => g !== undefined);
      const node = graphs.flatMap((g) => g.nodes).find((n) => n.id === a.nodeId);
      hunkId = node?.hunkId;
      if (node) where = `"${node.label}" in ${where}`;
    }
    hunkId ??= chapter?.hunkIds[0];
    const hunk = hunkId ? tour.hunks[hunkId] : undefined;
    const target = hunk ? anchorLineForHunk(hunk) : undefined;
    flowLevel.push({ draft: d, where });
    if (hunk && target) {
      comments.push({ path: hunk.file, body: formatBody(d, ctx, `_On flow: ${chapterTitle(a.chapterId)}_`, applies(d)), ...target });
    } else {
      outside.push({ draft: d, where });
      moved.push({ draftId: d.id, note: `no line found for ${where}; posted in the review body` });
    }
  }

  const parts = [summary.trim()].filter(Boolean);
  if (flowLevel.length > 0) {
    const groups = groupByLabel(flowLevel.map((f) => f.draft));
    const lines: string[] = ['### Flow-level comments'];
    for (const label of LABELS) {
      for (const d of groups[label]) {
        const f = flowLevel.find((x) => x.draft === d)!;
        lines.push(`- **[${label}]** ${f.where}: ${proseOf(d, ctx.host, ctx.repo).split('\n')[0]}`);
      }
    }
    parts.push(lines.join('\n'));
  }
  if (outside.length > 0) {
    const lines = ['### Comments on lines outside the diff'];
    for (const o of outside) lines.push(`- \`${o.where}\`\n\n  ${formatBody(o.draft, ctx).replace(/\n/g, '\n  ')}`);
    parts.push(lines.join('\n'));
  }

  return {
    payload: { commit_id: tour.headSha, body: parts.join('\n\n'), event, comments },
    moved,
    demoted,
  };
}

// What posting changes about `d`, from a dry run of buildReviewPayload with the options posting
// uses: "moves to line 91", "suggestion posts as plain code", "posts in the review body". A
// submit-screen hint only; it never blocks posting. Undefined when d posts where it was written.
export function postingNote(tour: Tour, d: Draft, opts: PayloadOptions = {}): string | undefined {
  const { payload, demoted } = buildReviewPayload(tour, [d], 'COMMENT', '', opts);
  const c = payload.comments[0];
  const a = d.anchor;
  const notes: string[] = [];
  if (!c) notes.push('posts in the review body');
  else if ((a.type === 'line' || a.type === 'range') && c.line !== a.line) notes.push(`moves to line ${c.line}`);
  else if (a.type === 'range' && a.startLine < a.line && c.start_line === undefined) notes.push(`posts on line ${c.line} only`);
  if (c && demoted.length) notes.push('suggestion posts as plain code');
  return notes.length ? notes.join(' · ') : undefined;
}

const LOGIC_CHAPTERS = new Set(['flow', 'supporting']);

// A verdict as the screens name it.
export const EVENT_TEXT: Record<ReviewPayload['event'], string> = { APPROVE: 'Approve', REQUEST_CHANGES: 'Request changes', COMMENT: 'Comment' };

export function suggestVerdict(tour: Tour, drafts: Draft[], readStates: Record<string, ReadState>): { event: ReviewPayload['event']; reasons: string[] } {
  const pending = drafts.filter((d) => !d.posted);
  const groups = groupByLabel(pending);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

  if (groups.blocking.length > 0) {
    return { event: 'REQUEST_CHANGES', reasons: [`${plural(groups.blocking.length, 'blocking comment')} to resolve.`] };
  }

  const reasons: string[] = [];
  if (groups.question.length > 0) reasons.push(`${plural(groups.question.length, 'open question')} for the author.`);

  const logicHunks = tour.chapters.filter((c) => LOGIC_CHAPTERS.has(c.kind)).flatMap((c) => c.hunkIds);
  const unread = [...new Set(logicHunks)].filter((id) => {
    const h = tour.hunks[id];
    return h && !h.importOnly && stateOf(readStates, h) !== 'read';
  });
  if (unread.length > 0) reasons.push(`${plural(unread.length, 'hand-written hunk')} not marked read.`);

  const riskyUntested = Object.values(tour.hunks).filter((h) => h.risk === 3 && h.coverage === 'untested');
  if (riskyUntested.length > 0) reasons.push(`${plural(riskyUntested.length, 'high-risk hunk')} without tests.`);

  if (reasons.length > 0) return { event: 'COMMENT', reasons };
  return { event: 'APPROVE', reasons: ['All hand-written hunks read, no blocking comments or open questions.'] };
}
