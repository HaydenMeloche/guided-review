import { describe, expect, it } from 'vitest';
import { codePaneWidths } from '../src/tui/paneWidths.js';

describe('code pane widths', () => {
  it('fits both panes to their longest line when there is room', () => {
    expect(codePaneWidths(150, ['short', 'x'.repeat(70)], ['x'.repeat(20)])).toEqual({ source: 82, test: 40 });
  });

  it('uses the actual longest line, including expanded tabs', () => {
    const lines = Array(20).fill('short');
    lines.push('\t' + 'x'.repeat(100));
    expect(codePaneWidths(200, lines, ['test']).source).toBe(114);
  });

  it('keeps both panes visible when their longest lines cannot fit', () => {
    expect(codePaneWidths(100, ['x'.repeat(80)], ['x'.repeat(45)])).toEqual({ source: 60, test: 40 });
  });

  it('expands the focused test pane to its longest line', () => {
    expect(codePaneWidths(100, ['x'.repeat(80)], ['x'.repeat(45)], 'test')).toEqual({ source: 41, test: 59 });
    expect(codePaneWidths(100, ['x'.repeat(80)], ['x'.repeat(90)], 'test')).toEqual({ source: 40, test: 60 });
  });
});
