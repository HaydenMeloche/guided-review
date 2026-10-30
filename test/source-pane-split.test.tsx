import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { SourcePane } from '../src/tui/chapter/SourcePane.js';
import { foldedLines, pairChangedLines } from '../src/diff/lines.js';
import type { Draft } from '../src/types.js';
import { diffLines, hunk } from './fixtures/tour.js';

const h = hunk('h1', 'src/app.ts', diffLines([' keep', '-const old = 1;', '+const fresh = 2;', '+const added = 3;']));
const draft = (id: string, line: number, side: 'LEFT' | 'RIGHT', body: string): Draft => ({
  id,
  repo: 'acme/shop',
  pr: 1,
  headSha: 'head',
  anchor: { type: 'line', hunkId: 'h1', file: 'src/app.ts', line, side },
  label: 'nit',
  body,
  posted: false,
  createdAt: '2026-10-01T00:00:00Z',
});

describe('SourcePane split view', () => {
  it('draws a note in its own pane, with the divider through it', () => {
    const width = 80;
    const partner = pairChangedLines(h.lines);
    const ui = render(
      <SourcePane
        hunk={h}
        cursor={0}
        range={null}
        raw={false}
        split
        partner={partner}
        hidden={foldedLines(h.lines, partner, false)}
        ignoreWhitespace={false}
        scroll={0}
        setScroll={() => {}}
        threads={[]}
        drafts={[draft('d1', 2, 'LEFT', 'old side'), draft('d2', 3, 'RIGHT', 'new side')]}
        headSha="head"
        baseSha="base"
        width={width}
        height={20}
      />,
    );
    const lines = ui.lastFrame()!.split('\n');
    const divider = lines.find((l) => l.includes('const fresh'))!.indexOf('│', 20);
    const left = lines.find((l) => l.includes('old side'))!;
    const right = lines.find((l) => l.includes('new side'))!;
    expect(left.indexOf('old side')).toBeLessThan(divider);
    expect(left[divider]).toBe('│');
    expect(right.indexOf('new side')).toBeGreaterThan(divider);
    expect(right[divider]).toBe('│');
  });
});
