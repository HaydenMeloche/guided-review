import type { Chapter, DiffFile, Hunk, Tour } from '../../types.js';
import { line, renderMarkdown, restyle, type MdLine } from '../markdown.js';
import { isSpecialKind } from '../../analysis/special.js';
import { truncate, wrap } from '../nav.js';
import { safe } from './text.js';

export type GuideLine = MdLine;

// The guide's text: narration (inferred narration is quieter),
// then notes on the chapter or hunk. All of it is Markdown: the agent writes `code`.
export function guideLines(narration: string | undefined, inferred: boolean, notes: string[], width: number, mode: Tour['mode'], hasHunk: boolean): GuideLine[] {
  const out: GuideLine[] = [];
  // Narration and notes are model output; renderMarkdown strips terminal controls.
  if (narration) {
    const md = renderMarkdown(narration, width);
    out.push(...(inferred ? restyle(md, { dim: true, italic: true }) : md));
    if (inferred) out.push(line('(the agent’s inference: not tied to visible code)', { dim: true, italic: true }));
  } else if (hasHunk) {
    out.push(line(mode === 'plain' ? 'Plain mode: no narration.' : 'Narration is still being written…', { dim: true }));
  }
  if (notes.length) {
    out.push([]);
    for (const n of notes) out.push(...restyle(renderMarkdown(n, width), { color: 'yellow' }));
  }
  return out;
}

export function noTestHint(hunk: Hunk, nameGuess?: string): string | undefined {
  if (hunk.coverage === 'n/a') return undefined;
  return `No linked test case found for this code.${nameGuess ? ` Nearest test file by name: ${nameGuess}` : ''}`;
}

// The explanation above the code, `width` wide: narration, notes on the chapter or hunk, and
// possible test gaps (U expands them). A filename-only test guess becomes a one-line hint.
export function explanation(
  o: { tour: Tour; chapter: Chapter; hunk?: Hunk; hi: number; collapsed: boolean; files: Map<string, DiffFile>; confirms?: Record<string, boolean>; linkedTests: boolean; showUntested: boolean },
  width: number,
): GuideLine[] {
  const { tour, chapter, hunk, hi, collapsed } = o;
  const configFile = (chapter.kind === 'config' || isSpecialKind(chapter.kind)) && hunk ? o.files.get(hunk.file) : undefined;
  // A narrated collapsed chapter (lockfiles) shares one narration across its hunks: show it above the file list.
  const sharedNarration = collapsed ? chapter.hunkIds.map((id) => tour.hunks[id]?.narration).find(Boolean) : undefined;
  const narration = hunk?.narration ?? (collapsed ? [sharedNarration, chapter.summary].filter(Boolean).join('\n\n') : (configFile?.summary ?? configFile?.kindReason));
  const chapterNotes: string[] = [];
  if (chapter.linkedHunkIds.length && hi <= 0) chapterNotes.push(`Also uses ${chapter.linkedHunkIds.length} hunk(s) shown in an earlier chapter.`);
  if (chapter.lowConfidence) chapterNotes.push('Some flow links use naming guesses: low confidence.');
  if (hi <= 0 && chapter.checklist?.length) {
    const open = chapter.checklist.filter((c) => !o.confirms?.[c.id]).length;
    if (open) chapterNotes.push(`Team checklist: ${open} item(s) to confirm (i). ${chapter.checklist.filter((c) => c.status === 'fail').length} flagged by the agent.`);
  }
  const nameGuess = hunk?.tests.find((t) => t.source === 'naming');
  const hint = hunk && !o.linkedTests ? noTestHint(hunk, nameGuess?.testFile) : undefined;
  const untestedBranches = hi <= 0 ? chapter.untestedBranches : [];
  const testGapSummary = [hint ? 'No linked test' : '', untestedBranches.length ? `${untestedBranches.length} possible untested behavior${untestedBranches.length === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .join(' · ');
  return [
    ...guideLines(narration, !!hunk?.narrationInferred, chapterNotes, width, tour.mode, !!hunk),
    ...(testGapSummary
      ? [
          [],
          line(truncate(`○ ${testGapSummary} · U: ${o.showUntested ? 'hide' : 'details'}`, width), { color: 'red' }),
          ...(o.showUntested
            ? [
                ...(hint ? wrap(safe(hint), width).map((t) => line(t, { dim: true })) : []),
                ...untestedBranches.flatMap((b) => wrap(safe(`Untested: ${b}`), width).map((t) => line(t, { color: 'yellow' }))),
              ]
            : []),
        ]
      : []),
  ];
}
