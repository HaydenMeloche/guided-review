import type { DiffLine, Draft, ExistingThread, Hunk } from '../../types.js';
import type { Fold } from '../../diff/lines.js';
import { safe } from './text.js';
import { plural } from '../plural.js';
import { G } from '../glyphs.js';

export function threadAt(threads: ExistingThread[], file: string, line?: number, side: 'LEFT' | 'RIGHT' = 'RIGHT') {
  if (line === undefined) return [];
  return threads.filter(
    (t) =>
      t.path === file &&
      (t.placed
        ? t.placed.side === side && t.placed.line === line
        : side === 'LEFT'
          ? t.isOutdated && t.originalLine === line
          : t.line === line || (t.line === undefined && !t.isOutdated && t.originalLine === line)),
  );
}

// Two moved blocks at most this many lines apart on both sides, going to the same place in the
// same way, are one move split by a small edit and share one note.
const SPLIT_GAP = 4;

const movedNotes = new WeakMap<Hunk, Map<number, string>>();

// Under the last line of a block moved within the PR: where the block was, or went, and how.
export function movedNote(hunk: Hunk, j: number): string | undefined {
  let notes = movedNotes.get(hunk);
  if (!notes) movedNotes.set(hunk, (notes = notesFor(hunk)));
  return notes.get(j);
}

// The move notes of a hunk, by the index of the line each goes under.
function notesFor(hunk: Hunk): Map<number, string> {
  const ls = hunk.lines;
  const alike = (a: DiffLine, b: DiffLine) => a.kind === b.kind && a.moved!.file === b.moved!.file && a.moved!.kind === b.moved!.kind && a.moved!.indent === b.moved!.indent;
  // Runs of lines moved alike to consecutive lines of one file.
  const blocks: [number, number][] = [];
  ls.forEach((l, k) => {
    const last = blocks.at(-1);
    if (!l.moved) return;
    if (last && last[1] === k - 1 && alike(ls[k - 1], l) && l.moved.line === ls[k - 1].moved!.line + 1) last[1] = k;
    else blocks.push([k, k]);
  });
  // Blocks a small edit apart, landing in order a few lines apart, as one note.
  const groups: [number, number][][] = [];
  for (const b of blocks) {
    const prev = groups.at(-1)?.at(-1);
    const between = prev ? ls.slice(prev[1] + 1, b[0]) : [];
    const [p, q] = prev ? [ls[prev[1]], ls[b[0]]] : [];
    const split = prev && between.length <= SPLIT_GAP && alike(p!, q!) && q!.moved!.line > p!.moved!.line && q!.moved!.line - p!.moved!.line - 1 <= SPLIT_GAP;
    if (split) groups.at(-1)!.push(b);
    else groups.push([b]);
  }
  const notes = new Map<number, string>();
  for (const g of groups) {
    const [first, last] = [g[0][0], g.at(-1)![1]];
    const l = ls[last];
    const at = ls[first].moved!;
    const n = g.reduce((t, [a, b]) => t + b - a + 1, 0);
    const other = last - first + 1 - n;
    const where = (p: { file: string; line: number }) => (p.file === hunk.file ? `line ${p.line}` : `${safe(p.file)}:${p.line}`);
    const lines = `${n} line${n === 1 ? '' : 's'}`;
    const gap = other ? `, split by ${plural(other, 'other line')}` : '';
    const indent = at.indent ? `indent ${at.indent > 0 ? '+' : '−'}${Math.abs(at.indent)}` : '';
    if (at.kind === 'reindented') {
      notes.set(last, `↔ ${lines} re-indented in place${indent ? ` (${indent})` : ''}, ${l.kind === 'del' ? 'now' : 'was'} ${where(at)}${gap}`);
      continue;
    }
    const also = (side: 'add' | 'del') => {
      const places = at.also.filter((p) => p.side === side);
      if (!places.length) return '';
      const shown = places.slice(0, 2).map(where).join(', ');
      return `; also ${side === 'add' ? 'added' : 'removed'} at ${shown}${places.length > 2 ? ` and ${places.length - 2} more` : ''}`;
    };
    notes.set(
      last,
      `${G.moved} ${lines} ${at.kind} ${l.kind === 'del' ? (at.kind === 'merged' ? 'into' : 'to') : 'from'} ${where(at)}${indent ? `, ${indent}` : ''}${gap}${also('add')}${also('del')}`,
    );
  }
  return notes;
}

// Under a hunk's last changed line: the other hunks of its file that make the same change.
export const copiesNote = (c: { others: number; unread: number }) => `          ${G.copies} same change in ${plural(c.others, 'other hunk')} · ${c.unread ? `${c.unread} unread` : 'all read'}`;

export function draftsAt(drafts: Draft[], hunk: Hunk, line?: number, side: 'LEFT' | 'RIGHT' = 'RIGHT') {
  if (line === undefined) return [];
  return drafts.filter((d) => (d.anchor.type === 'line' || d.anchor.type === 'range') && d.anchor.file === hunk.file && d.anchor.line === line && d.anchor.side === side);
}

// The review threads and the newest unposted draft on the cursor line, which E and X act on. Split,
// a removed line shares its replacement's row, so its threads and drafts are on the cursor line too.
export function cursorNotes(
  hunk: Hunk | undefined,
  cursor: number,
  hidden: ReadonlyMap<number, Fold>,
  partner: number[],
  threads: ExistingThread[],
  drafts: Draft[],
  run?: { start: number; end: number }, // a folded run of imports on the cursor's row: its lines' notes too
) {
  const side = (l: DiffLine) => [l.kind === 'del' ? l.oldLine : l.newLine, l.kind === 'del' ? 'LEFT' : 'RIGHT'] as const;
  const lines = run ? (hunk?.lines.slice(run.start, run.end + 1) ?? []) : [hunk?.lines[cursor], hidden.get(partner[cursor]) === 'beside' ? hunk?.lines[partner[cursor]] : undefined];
  const on = lines.flatMap((l) => (hunk && l ? [side(l)] : []));
  return {
    threads: on.flatMap(([line, s]) => threadAt(threads, hunk!.file, line, s)),
    draft: on
      .flatMap(([line, s]) => draftsAt(drafts, hunk!, line, s).filter((d) => !d.posted))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1),
  };
}
