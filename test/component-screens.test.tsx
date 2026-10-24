import { describe, expect, it, vi } from 'vitest';

// Colors on, so the snapshots show them. Hoisted above the imports, which read it once.
vi.hoisted(() => {
  process.env.FORCE_COLOR = '3';
});

import path from 'node:path';
import { render } from 'ink-testing-library';
import { fitHints, KeyBar } from '../src/tui/KeyBar.js';
import { Help } from '../src/tui/Help.js';
import { chapterHelp } from '../src/tui/chapter/keys.js';
import { ChapterList, Header } from '../src/tui/chapter/parts.js';
import { CommentEditor } from '../src/tui/CommentEditor.js';
import { progress } from '../src/tui/nav.js';
import type { Draft } from '../src/types.js';
import { ansiMarks } from './helpers/ansiMarks.js';
import { hunkFromDiff, tour } from './fixtures/tour.js';

// Component snapshots: the shared pieces of the screens at two widths, colors and styles marked
// up, checked in under __screens__. Accept a diff with `pnpm test -u` only when the new look is
// intended.

// ink-testing-library renders into a 100-column stdout, so neither width goes past it.
const WIDTHS = [60, 100];
const file = (name: string, width: number) => path.join(import.meta.dirname, '__screens__', `${name}-${width}.txt`);
const frame = (node: React.ReactElement) => ansiMarks(render(node).lastFrame() ?? '') + '\n';

const h1 = hunkFromDiff('src/pricing.ts', ' export function quote(items: LineItem[]) {', '+  const discount = 0;', '   return items;');
const h2 = hunkFromDiff('src/orders.ts', '-old()', '+next()');
const t = tour(
  [h1, h2],
  [
    { title: 'Order API: route → pricing', hunkIds: [h1.id], risk: 3 },
    { title: 'Supporting changes', hunkIds: [h2.id] },
  ],
  { title: 'Discount codes and order cancellation', repo: 'acme/shop', pr: 42 },
);
const states = { [h1.contentHash]: 'read' as const };

const draft: Draft = {
  id: 'd1',
  repo: 'acme/shop',
  pr: 42,
  headSha: 'head',
  anchor: { type: 'line', hunkId: h1.id, file: 'src/pricing.ts', line: 2, side: 'RIGHT' },
  label: 'question',
  body: 'Should this apply before tax?',
  posted: false,
  createdAt: '2026-01-01T00:00:00Z',
};

describe.each(WIDTHS)('components at %i columns', (width) => {
  it('key bar', async () => {
    const keys: [string, string][] = [
      ['n/p', 'hunk'],
      ['c', 'comment'],
      ['v', 'range'],
      [']/[', 'chapter'],
      ['t', 'tests'],
      ['d', 'diagram'],
      ['x', 'skip'],
      ['+/-', 'context'],
      ['S', 'split'],
    ];
    const end: [string, string][] = [
      ['b', 'briefing'],
      ['h', 'all keys'],
    ];
    await expect(frame(<KeyBar width={width} keys={keys} end={end} status="whitespace hidden" />)).toMatchFileSnapshot(file('keybar', width));
  });

  it('help', async () => {
    await expect(frame(<Help title="chapter" sections={chapterHelp(true)} width={width} height={60} onClose={() => {}} />)).toMatchFileSnapshot(file('help', width));
  });

  it('header', async () => {
    await expect(frame(<Header tour={t} prog={progress(t, states)} order="flow" deltaOnly={false} width={width} />)).toMatchFileSnapshot(file('header', width));
  });

  it('chapter list', async () => {
    await expect(frame(<ChapterList tour={t} chapters={t.chapters} listed={t.chapters} states={states} current={t.chapters[0].id} width={32} height={6} />)).toMatchFileSnapshot(
      file('chapter-list', width),
    );
  });

  it('composer', async () => {
    await expect(frame(<CommentEditor draft={draft} target="src/pricing.ts:2" hunk={h1} width={width} onSave={() => {}} onCancel={() => {}} />)).toMatchFileSnapshot(file('composer', width));
  });
});

describe('fitHints', () => {
  it('rules between groups and counts what it leaves out', () => {
    const hints: [string, string, string][] = [
      ['n/p', 'hunk', 'move'],
      [']/[', 'chapter', 'move'],
      ['c', 'comment', 'do'],
      ['a', 'ask', 'do'],
      ['t', 'tests', 'view'],
    ];
    expect(fitHints(hints, 200)).toEqual({ shown: [hints[0], hints[1], 'sep', hints[2], hints[3], 'sep', hints[4]], dropped: 0 });
    const narrow = fitHints(hints, 40);
    expect(narrow.dropped).toBe(3);
    expect(narrow.shown).toEqual([hints[0], hints[1]]);
  });
});

describe('KeyBar extraEnd', () => {
  const bar = (width: number) =>
    render(
      <KeyBar
        width={width}
        keys={[
          ['n/p', 'hunk'],
          ['c', 'comment'],
        ]}
        extraEnd={[[':', 'commands']]}
        end={[
          ['esc', 'back'],
          ['?', 'keys'],
        ]}
      />,
    )
      .lastFrame()!
      .replace(/\u001b\[[0-9;]*m/g, '');

  it('goes before the end when the keys keep room', () => {
    expect(bar(90)).toMatch(/: commands\s+esc back\s+\? keys/);
  });

  it('is dropped first on a narrow bar, keeping help', () => {
    const narrow = bar(50);
    expect(narrow).not.toContain('commands');
    expect(narrow).toMatch(/\? keys\s*$/);
  });
});
