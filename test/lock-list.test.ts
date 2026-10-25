import { describe, expect, it } from 'vitest';
import { lockListLines, type LockPage } from '../src/tui/chapter/lockList.js';
import type { PackageChange } from '../src/analysis/lockfile.js';

const text = (lines: ReturnType<typeof lockListLines>) =>
  lines.map((l) =>
    l
      .map((s) => s.text)
      .join('')
      .trimEnd(),
  );
const minor = (i: number): PackageChange => ({ name: `dep-${i}`, change: 'minor', from: '1.0.0', to: '1.0.1' });

const page: LockPage = {
  lockfile: 'pnpm-lock.yaml',
  direct: [
    { name: 'react', change: 'major', from: '18.3.1', to: '19.0.0' },
    { name: 'zod', change: 'added', to: '3.23.8' },
  ],
  indirect: [{ name: 'scheduler', change: 'major', from: '0.23.2', to: '0.25.0' }, ...Array.from({ length: 30 }, (_, i) => minor(i)), { name: 'left-pad', change: 'removed', from: '1.3.0' }],
  indirectElsewhere: 0,
  total: 34,
};

describe('lockListLines', () => {
  it('lists the direct changes one per row, then the indirect ones by kind', () => {
    const lines = text(lockListLines(page, 80));
    expect(lines[0]).toBe('pnpm-lock.yaml · 34 package changes in the lockfile');
    expect(lines[1]).toMatch(/^ {2}react +18\.3\.1 → 19\.0\.0 +major$/);
    expect(lines[2]).toMatch(/^ {2}zod +3\.23\.8 +added$/);
    expect(lines[3]).toBe('Indirect · 1 major · 30 minor/patch · 1 removed');
    expect(lines[4]).toBe('  major        scheduler 0.23.2 → 0.25.0');
    expect(lines[5]).toMatch(/^ {2}minor\/patch {2}dep-0 1\.0\.0 → 1\.0\.1, dep-1/);
    expect(lines.at(-1)).toBe('  removed      left-pad 1.3.0');
    expect(lines.every((l) => l.length <= 80)).toBe(true);
  });

  it('fits a short height: every kind keeps a row, and what is cut says how many more', () => {
    const lines = text(lockListLines(page, 80, 6));
    expect(lines).toHaveLength(6);
    expect(lines.slice(0, 4)).toEqual([
      'pnpm-lock.yaml · 34 package changes in the lockfile',
      expect.stringMatching(/^ {2}react/),
      expect.stringMatching(/^ {2}zod/),
      'Indirect · 1 major · 30 minor/patch · 1 removed',
    ]);
    // Three kinds and two rows: the first two get a row, the last is counted.
    expect(lines[4]).toMatch(/^ {2}major/);
    expect(lines[5]).toMatch(/^ {2}minor\/patch .*… \d+ more$/);
    const tiny = text(lockListLines({ ...page, indirect: [] }, 80, 2));
    expect(tiny).toEqual(['pnpm-lock.yaml · 34 package changes in the lockfile', '  … 2 more']);
  });

  it('points at the first page for the indirect changes, and says when a hunk names none', () => {
    const lines = text(lockListLines({ ...page, direct: [], indirect: [], indirectElsewhere: 32 }, 80));
    expect(lines).toEqual([
      'pnpm-lock.yaml · 34 package changes in the lockfile',
      '  No package this hunk names changed in the lockfile.',
      '32 indirect changes, listed on this lockfile’s first page',
    ]);
    expect(text(lockListLines({ ...page, direct: [], indirect: [], total: 0 }, 80))).toEqual(['pnpm-lock.yaml · no package changes parsed']);
  });
});
