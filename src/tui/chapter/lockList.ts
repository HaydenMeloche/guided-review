import { pairChanges, type PackageChange, type PairChanges } from '../../analysis/lockfile.js';
import type { Chapter, Hunk, LockPair, Tour } from '../../types.js';
import { line, type MdLine } from '../markdown.js';
import { lockPairOfHunk, truncate } from '../nav.js';
import { plural } from '../plural.js';
import { ROLES } from '../theme.js';

// What a lockfile pair's manifest page lists under its diff: the package changes the hunk names,
// and, on the pair's first page only, the indirect ones (on the others, how many there are).
export interface LockPage {
  lockfile: string;
  direct: PackageChange[];
  indirect: PackageChange[];
  indirectElsewhere: number; // indirect changes listed on the pair's first page instead
  total: number;
}

// Parsing a lockfile's hunks is linear in its lines, which can be many: cache it per pair until
// one of its hunks changes (narration arriving makes new hunk objects).
const cache = new WeakMap<LockPair, { hunks: Hunk[]; changes: PairChanges }>();

function changesOf(tour: Tour, pair: LockPair): PairChanges {
  const hunks = [...pair.hunkIds, ...pair.lockHunkIds].map((id) => tour.hunks[id]).filter(Boolean);
  const hit = cache.get(pair);
  if (hit && hit.hunks.length === hunks.length && hit.hunks.every((h, i) => h === hunks[i])) return hit.changes;
  const lockfile = new Set(pair.lockHunkIds);
  const changes = pairChanges(
    pair.lockfile,
    hunks.filter((h) => lockfile.has(h.id)),
    hunks.filter((h) => !lockfile.has(h.id)),
  );
  cache.set(pair, { hunks, changes });
  return changes;
}

// The lockfile list for a hunk's page, when the hunk is a manifest hunk of a lockfile pair.
export function lockPage(tour: Tour, chapter: Chapter, hunkId: string): LockPage | undefined {
  const pair = lockPairOfHunk(chapter, hunkId);
  if (!pair) return undefined;
  const c = changesOf(tour, pair);
  const first = chapter.hunkIds.find((id) => pair.hunkIds.includes(id)) === hunkId;
  return {
    lockfile: pair.lockfile,
    direct: c.direct.get(hunkId) ?? [],
    indirect: first ? c.indirect : [],
    indirectElsewhere: first ? 0 : c.indirect.length,
    total: c.total,
  };
}

const GROUPS: { change: PackageChange['change']; label: string }[] = [
  { change: 'major', label: 'major' },
  { change: 'minor', label: 'minor/patch' },
  { change: 'added', label: 'added' },
  { change: 'removed', label: 'removed' },
];
const LABEL = 13; // the indirect groups' label column
const INDENT = '  ';

const versions = (p: PackageChange) => (p.change === 'added' ? (p.to ?? '') : p.change === 'removed' ? (p.from ?? '') : `${p.from} → ${p.to}`);
const item = (p: PackageChange) => `${p.name} ${versions(p)}`;
const TAG: Record<PackageChange['change'], { text: string; color?: string; dim?: boolean }> = {
  major: { text: 'major', color: 'yellow' },
  minor: { text: 'minor/patch', dim: true },
  added: { text: 'added', color: 'green' },
  removed: { text: 'removed', color: 'red' },
};

// A group's items, comma-separated and wrapped to `width`.
function wrapItems(items: string[], width: number): string[][] {
  const lines: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const it of items) {
    const add = (cur.length ? 2 : 0) + it.length;
    if (cur.length && len + add > width) {
      lines.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(it);
    len += cur.length > 1 ? add : it.length;
  }
  if (cur.length) lines.push(cur);
  return lines;
}

// The first `rows` lines of a wrapped group; when that cuts it short, the last ends "… N more".
function cutItems(lines: string[][], total: number, rows: number, width: number): string[] {
  if (lines.length <= rows) return lines.map((l) => l.join(', '));
  const kept = lines.slice(0, rows).map((l) => [...l]);
  const last = kept[kept.length - 1];
  let shown = kept.reduce((n, l) => n + l.length, 0);
  const tail = () => `${last.length ? ', ' : ''}… ${total - shown} more`;
  while (last.length && last.join(', ').length + tail().length > width) {
    last.pop();
    shown--;
  }
  return kept.map((l, i) => (i === kept.length - 1 ? `${l.join(', ')}${tail()}` : l.join(', ')));
}

// The list under a pair's manifest diff, `width` wide and at most `height` rows: a heading, the
// direct changes one per row, then the indirect ones by kind. When it does not fit, the direct
// changes keep a row each where they can, then each indirect kind gets a row in turn, and what is
// cut says how many more there are (the indirect heading counts every kind).
export function lockListLines(page: LockPage, width: number, height = Infinity): MdLine[] {
  if (height < 1) return [];
  const head: MdLine = [
    { text: truncate(page.lockfile, Math.max(8, Math.floor(width * 0.6))), bold: true, color: ROLES.heading },
    { text: ` · ${plural(page.total, 'package change')} in the lockfile`, dim: true },
  ];
  if (!page.total) return [[head[0], { text: ' · no package changes parsed', dim: true }]];

  const nameWidth = Math.min(28, Math.max(8, ...page.direct.map((p) => p.name.length)));
  const directRow = (p: PackageChange): MdLine => {
    const v = versions(p);
    const tag = TAG[p.change];
    const room = Math.max(4, width - INDENT.length - nameWidth - 2 - tag.text.length - 2);
    return [
      { text: `${INDENT}${truncate(p.name, nameWidth).padEnd(nameWidth)}  ` },
      { text: truncate(v, room).padEnd(Math.min(room, Math.max(v.length, 18))) },
      { text: `  ${tag.text}`, color: tag.color, dim: tag.dim },
    ];
  };
  const direct: MdLine[] = page.direct.length ? page.direct.map(directRow) : [line(`${INDENT}No package this hunk names changed in the lockfile.`, { dim: true })];

  const groups = GROUPS.map((g) => ({ ...g, items: page.indirect.filter((p) => p.change === g.change).map(item) })).filter((g) => g.items.length);
  const itemWidth = Math.max(10, width - INDENT.length - LABEL);
  const wrapped = groups.map((g) => wrapItems(g.items, itemWidth));
  const counts = groups.map((g) => `${g.items.length} ${g.label}`).join(' · ');
  const indirectHead: MdLine[] = page.indirect.length
    ? [
        [
          { text: 'Indirect', bold: true },
          { text: ` · ${counts}`, dim: true },
        ],
      ]
    : page.indirectElsewhere
      ? [line(`${plural(page.indirectElsewhere, 'indirect change')}, listed on this lockfile’s first page`, { dim: true })]
      : [];

  // Rows: the heading, then the direct rows, then the indirect heading and groups.
  const groupRows = wrapped.map((w) => w.length);
  const want = 1 + direct.length + indirectHead.length + groupRows.reduce((a, b) => a + b, 0);
  let directRows = direct.length;
  const give = groupRows.slice();
  if (want > height) {
    // The direct changes come first; the indirect ones keep their heading and a row.
    const indirectMin = indirectHead.length + (groups.length ? 1 : 0);
    directRows = Math.min(direct.length, Math.max(1, height - 1 - indirectMin));
    let left = Math.max(0, height - 1 - directRows - indirectHead.length);
    for (let i = 0; i < give.length; i++) give[i] = 0;
    for (let i = 0; i < give.length && left > 0; i++, left--) give[i] = 1;
    for (let i = 0; i < give.length && left > 0; i++) {
      const more = Math.min(left, groupRows[i] - give[i]);
      give[i] += more;
      left -= more;
    }
  }
  const out: MdLine[] = [head];
  if (directRows < direct.length) out.push(...direct.slice(0, directRows - 1), line(`${INDENT}… ${direct.length - directRows + 1} more`, { dim: true }));
  else out.push(...direct);
  out.push(...indirectHead);
  groups.forEach((g, i) => {
    if (!give[i]) return;
    cutItems(wrapped[i], g.items.length, give[i], itemWidth).forEach((text, k) => {
      const tag = TAG[g.change];
      out.push([{ text: `${INDENT}${k ? '' : g.label}`.padEnd(INDENT.length + LABEL), color: tag.color, dim: tag.dim }, { text }]);
    });
  });
  // Kinds with no row left: one closing line counts them.
  const dropped = groups.filter((_, i) => !give[i]);
  if (dropped.length && out.length < height) out.push(line(`${INDENT}… ${dropped.map((g) => `${g.items.length} ${g.label}`).join(', ')}`, { dim: true }));
  return out.slice(0, height);
}
