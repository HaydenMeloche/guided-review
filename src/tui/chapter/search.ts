import type { Chapter, DiffLine, Tour } from '../../types.js';
import { pageOf } from '../nav.js';

// `/` on the chapter screen: text anywhere in the diff (not the rest of the codebase), so "where else does this appear in the
// diff?" has an answer without leaving gr.

export interface SearchHit {
  ci: number; // the chapter
  page: number; // the page that shows the hunk: its own, a lockfile pair's manifest, or -1 for a summary
  hunkId: string;
  line?: number; // the line's index in the hunk; unset for a hit in the explanation
  kind: DiffLine['kind'] | 'explanation';
  where: string; // file:line
  text: string; // the line, or the explanation's line that matched
  at: number; // where the match starts in text
}

// Past this many, the list says there are more rather than holding every line of a huge diff.
export const MAX_HITS = 500;

// Smart case: a query in lowercase matches any case, one with a capital matches exactly.
export function matcher(query: string): ((text: string) => number) | undefined {
  if (!query) return undefined;
  if (query !== query.toLowerCase()) return (text) => text.indexOf(query);
  return (text) => text.toLowerCase().indexOf(query);
}

// Every hunk line and explanation line in `chapters` holding the query: changed lines first,
// then context, then explanations, each in reading order. `total` counts past MAX_HITS.
export function searchTour(tour: Pick<Tour, 'hunks'>, chapters: Chapter[], query: string): { hits: SearchHit[]; total: number } {
  const find = matcher(query);
  if (!find) return { hits: [], total: 0 };
  const changed: SearchHit[] = [];
  const context: SearchHit[] = [];
  const explained: SearchHit[] = [];
  const seen = new Set<string>(); // a shared narration is one hit, on its first hunk
  chapters.forEach((c, ci) =>
    c.hunkIds.forEach((id, hi) => {
      const h = tour.hunks[id];
      if (!h) return;
      const page = pageOf(c, hi);
      h.lines.forEach((l, line) => {
        const at = find(l.text);
        if (at < 0) return;
        (l.kind === 'ctx' ? context : changed).push({ ci, page, hunkId: id, line, kind: l.kind, where: `${h.file}:${l.newLine ?? l.oldLine ?? ''}`, text: l.text, at });
      });
      for (const text of (h.narration ?? '').split('\n')) {
        const at = find(text);
        if (at < 0 || seen.has(`${ci}\0${text}`)) continue;
        seen.add(`${ci}\0${text}`);
        explained.push({ ci, page, hunkId: id, kind: 'explanation', where: h.file, text, at });
      }
    }),
  );
  const all = [...changed, ...context, ...explained];
  return { hits: all.slice(0, MAX_HITS), total: all.length };
}
