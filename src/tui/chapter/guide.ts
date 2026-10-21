import type { Hunk, Tour } from '../../types.js';
import { line, renderMarkdown, restyle, type MdLine } from '../markdown.js';

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
