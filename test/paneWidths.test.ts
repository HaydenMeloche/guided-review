import { describe, expect, it } from 'vitest';
import { codePaneWidths } from '../src/tui/paneWidths.js';

describe('code pane widths', () => {
  it('fits both panes to their longest line when there is room', () => {
    expect(codePaneWidths(150, ['short', 'x'.repeat(70)], ['x'.repeat(20)])).toEqual({ source: 85, test: 40, stack: false });
  });

  it('uses the actual longest line, including expanded tabs', () => {
    const lines = Array(20).fill('short');
    lines.push('\t' + 'x'.repeat(100));
    expect(codePaneWidths(200, lines, ['test']).source).toBe(117);
  });

  it('gives the source its longest line and the tests what is left', () => {
    expect(codePaneWidths(140, ['x'.repeat(80)], ['x'.repeat(60)])).toEqual({ source: 95, test: 45, stack: false });
  });

  it('stacks the tests rather than wrap the source', () => {
    expect(codePaneWidths(100, ['x'.repeat(80)], ['x'.repeat(45)])).toEqual({ source: 100, test: 100, stack: true });
  });

  it('widens the source pane for a note under its lines', () => {
    expect(codePaneWidths(150, ['anyOrNull(),'], ['x'.repeat(20)], false, 70)).toEqual({ source: 71, test: 40, stack: false });
    expect(codePaneWidths(120, ['anyOrNull(),'], ['x'.repeat(45)], false, 70)).toEqual({ source: 71, test: 49, stack: false });
  });

  it('counts a split diff twice', () => {
    expect(codePaneWidths(140, ['x'.repeat(40)], ['x'], true).stack).toBe(true);
    expect(codePaneWidths(200, ['x'.repeat(40)], ['x'], true)).toEqual({ source: 102, test: 40, stack: false });
  });
});
