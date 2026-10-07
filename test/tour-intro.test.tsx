import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { introFrame, TourIntro, type IntroLine } from '../src/tui/TourIntro.js';

const lines = (spinner: string): IntroLine[] => ['acme/app#42', 'Fix invoice rounding', [{ text: spinner }, { text: ' Tracing flows' }]];

describe('tour intro', () => {
  it('draws a centered title card that fits the screen', () => {
    const rows = introFrame(60, 14, lines('⠋'), 0).map((segs) => segs.map((s) => s.text).join(''));
    expect(rows).toHaveLength(14);
    expect(rows.every((r) => [...r].length === 60)).toBe(true);
    expect(rows.some((r) => r.includes('Guided Review'))).toBe(true);
    expect(rows.some((r) => r.includes('⠋ Tracing flows'))).toBe(true);
  });

  it('shows the pipeline steps and quits with q', async () => {
    const onQuit = vi.fn();
    const ui = render(<TourIntro width={60} height={14} lines={lines} onQuit={onQuit} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(ui.lastFrame()).toContain('Tracing flows');
    ui.stdin.write('x');
    expect(onQuit).not.toHaveBeenCalled();
    ui.stdin.write('q');
    expect(onQuit).toHaveBeenCalled();
    ui.unmount();
  });
});
