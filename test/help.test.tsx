import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Help, helpSize } from '../src/tui/Help.js';
import { reviewLegend } from '../src/tui/legend.js';
import { waitFor } from './helpers/waitFor.js';

const sections = [
  { title: 'Move', rows: Array.from({ length: 12 }, (_, i): [string, string] => [`k${i}`, `row ${i}`]) },
  { title: 'Read', rows: [['x', 'skip'] as [string, string]] },
];

describe('Help', () => {
  it('scrolls on a short terminal, turns to the marks on tab, and closes on esc', async () => {
    const onClose = vi.fn();
    const ui = render(<Help title="chapter" sections={sections} legend={reviewLegend()} width={70} height={8} onClose={onClose} />);
    expect(ui.lastFrame()).toContain('Keys · chapter · 1/2');
    expect(ui.lastFrame()).toContain('row 0');
    expect(ui.lastFrame()).not.toContain('skip');
    ui.stdin.write('G');
    await waitFor(() => expect(ui.lastFrame()).toContain('these keys'));
    expect(ui.lastFrame()).not.toContain('row 0');
    ui.stdin.write('\t');
    await waitFor(() => expect(ui.lastFrame()).toContain('Marks · chapter · 2/2'));
    expect(ui.lastFrame()).toContain('deferred');
    ui.stdin.write('\u001b');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    ui.unmount();
  });

  it('is sized to fit every row and the keys that work everywhere', () => {
    expect(helpSize(sections).height).toBe(13 + 1 + 1 + 4 + 2 + 2);
  });
});
