import { describe, expect, it } from 'vitest';
import { fromColorFgBg, parseOsc11, typeOf } from '../src/tui/terminalBackground.js';
import { detectColorDepth, resolveColor, setColorDepth, SURFACES, terminalPaletteFor } from '../src/tui/theme.js';

describe('the terminal background', () => {
  it('reads an OSC 11 reply in any digit count', () => {
    expect(parseOsc11('\u001b]11;rgb:ffff/ffff/ffff\u0007\u001b[?62;c')).toBe('#ffffff');
    expect(parseOsc11('\u001b]11;rgb:1e/1e/2e\u001b\\')).toBe('#1e1e2e');
    expect(parseOsc11('\u001b[?1;2c')).toBeUndefined();
  });

  it('tells light from dark, from the color or COLORFGBG', () => {
    expect(typeOf('#fdf6e3')).toBe('light');
    expect(typeOf('#002b36')).toBe('dark');
    expect(fromColorFgBg('0;15')).toEqual({ type: 'light' });
    expect(fromColorFgBg('15;default;0')).toEqual({ type: 'dark' });
    expect(fromColorFgBg(undefined)).toBeUndefined();
  });

  it('mixes light tints for a light terminal, and keeps the dark ones otherwise', () => {
    const light = terminalPaletteFor({ type: 'light', hex: '#ffffff' });
    expect(light.type).toBe('light');
    expect(light.diffLine.add).toMatch(/^#[d-f][0-9a-f]/);
    expect(terminalPaletteFor().popup).toBe('#1E1E2E');
  });
});

describe('color depth', () => {
  it('reads the environment as chalk does', () => {
    expect(detectColorDepth({ COLORTERM: 'truecolor' })).toBe('truecolor');
    expect(detectColorDepth({ TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' })).toBe('256');
    expect(detectColorDepth({ TERM: 'xterm' })).toBe('16');
  });

  it('swaps mixed surfaces for cube colors below truecolor', () => {
    const p = terminalPaletteFor();
    setColorDepth('256');
    expect(resolveColor(p, SURFACES.lineAdd)).toBe('#003300');
    expect(resolveColor(p, SURFACES.selection)).toBeUndefined(); // the terminal palette inverts instead
    setColorDepth('truecolor');
    expect(resolveColor(p, SURFACES.lineAdd)).toBe('#173B2A');
  });
});
