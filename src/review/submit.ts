import type { CommentLabel, Draft, Hunk, ReadState, Tour } from '../types.js';
import type { ReviewPayload } from '../github/gh.js';

type Side = 'LEFT' | 'RIGHT';
type ReviewComment = ReviewPayload['comments'][number];

export const LABELS: CommentLabel[] = ['blocking', 'question', 'suggestion', 'nit'];

export function groupByLabel(drafts: Draft[]): Record<CommentLabel, Draft[]> {
  const groups: Record<CommentLabel, Draft[]> = { blocking: [], question: [], suggestion: [], nit: [] };
  for (const d of drafts) groups[d.label].push(d);
  return groups;
}

function formatBody(d: Draft, note?: string): string {
  let body = `**[${d.label}]** ${d.body.trim()}`;
  if (d.suggestion !== undefined) body += `\n\n\`\`\`suggestion\n${d.suggestion.replace(/\n$/, '')}\n\`\`\``;
  if (note) body += `\n\n${note}`;
  return body;
}

// Every line a review comment may attach to in this file, per side.
function diffLines(tour: Tour, file: string, side: Side): number[] {
  const out: number[] = [];
  for (const h of Object.values(tour.hunks)) {
    if (h.file !== file) continue;
    for (const l of h.lines) {
      if (side === 'RIGHT' && l.kind !== 'del' && l.newLine !== undefined) out.push(l.newLine);
      if (side === 'LEFT' && l.kind !== 'add' && l.oldLine !== undefined) out.push(l.oldLine);
    }
  }
  return out;
}

function hunkOf(tour: Tour, file: string, line: number, side: Side): Hunk | undefined {
  return Object.values(tour.hunks).find((h) => h.file === file && h.lines.some((l) => (side === 'RIGHT' ? l.kind !== 'del' && l.newLine === line : l.kind !== 'add' && l.oldLine === line)));
}

// The line a flow- or node-level comment lands on: first added line, else the
// first context line, else the first deleted line on the old side.
function anchorLineForHunk(h: Hunk): { line: number; side: Side } | undefined {
  const add = h.lines.find((l) => l.kind === 'add');
  if (add?.newLine !== undefined) return { line: add.newLine, side: 'RIGHT' };
  const ctx = h.lines.find((l) => l.kind === 'ctx');
  if (ctx?.newLine !== undefined) return { line: ctx.newLine, side: 'RIGHT' };
  const del = h.lines.find((l) => l.kind === 'del');
  if (del?.oldLine !== undefined) return { line: del.oldLine, side: 'LEFT' };
  return undefined;
}

export function buildReviewPayload(tour: Tour, drafts: Draft[], event: ReviewPayload['event'], summary: string): { payload: ReviewPayload; moved: { draftId: string; note: string }[] } {
  const comments: ReviewComment[] = [];
  const moved: { draftId: string; note: string }[] = [];
  const outside: { draft: Draft; where: string }[] = [];
  const flowLevel: { draft: Draft; where: string }[] = [];
  const chapterTitle = (id: string) => tour.chapters.find((c) => c.id === id)?.title ?? id;

  for (const d of drafts) {
    const a = d.anchor;
    if (a.type === 'line' || a.type === 'range') {
      const lines = diffLines(tour, a.file, a.side);
      if (lines.includes(a.line)) {
        const c: ReviewComment = { path: a.file, body: formatBody(d), line: a.line, side: a.side };
        // A range must start inside the same hunk to be accepted by GitHub.
        if (a.type === 'range' && a.startLine < a.line) {
          const h = hunkOf(tour, a.file, a.line, a.side);
          if (h && hunkOf(tour, a.file, a.startLine, a.side) === h) {
            c.start_line = a.startLine;
            c.start_side = a.side;
          }
        }
        comments.push(c);
        continue;
      }
      if (lines.length > 0) {
        const nearest = lines.reduce((best, l) => (Math.abs(l - a.line) < Math.abs(best - a.line) ? l : best));
        const note = `_Originally on line ${a.line}, which is no longer in the diff._`;
        comments.push({ path: a.file, body: formatBody(d, note), line: nearest, side: a.side });
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
      comments.push({ path: hunk.file, body: formatBody(d, `_On flow: ${chapterTitle(a.chapterId)}_`), ...target });
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
        lines.push(`- **[${label}]** ${f.where}: ${d.body.trim().split('\n')[0]}`);
      }
    }
    parts.push(lines.join('\n'));
  }
  if (outside.length > 0) {
    const lines = ['### Comments on lines outside the diff'];
    for (const o of outside) lines.push(`- \`${o.where}\`\n\n  ${formatBody(o.draft).replace(/\n/g, '\n  ')}`);
    parts.push(lines.join('\n'));
  }

  return {
    payload: { commit_id: tour.headSha, body: parts.join('\n\n'), event, comments },
    moved,
  };
}

const LOGIC_CHAPTERS = new Set(['flow', 'supporting']);

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
    return h && !h.importOnly && (readStates[h.contentHash] ?? 'unread') !== 'read';
  });
  if (unread.length > 0) reasons.push(`${plural(unread.length, 'hand-written hunk')} not marked read.`);

  const riskyUntested = Object.values(tour.hunks).filter((h) => h.risk === 3 && h.coverage === 'untested');
  if (riskyUntested.length > 0) reasons.push(`${plural(riskyUntested.length, 'high-risk hunk')} without tests.`);

  if (reasons.length > 0) return { event: 'COMMENT', reasons };
  return { event: 'APPROVE', reasons: ['All hand-written hunks read, no blocking comments or open questions.'] };
}
