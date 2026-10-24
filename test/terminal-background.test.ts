import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { detectBackground, fromColorFgBg, parseOsc11, stripReply, typeOf } from '../src/tui/terminalBackground.js';
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

describe('a late answer', () => {
  it('strips OSC 11 and DA1 replies from input, holding one cut across chunks', () => {
    expect(stripReply('', 'x\u001b]11;rgb:ffff/ffff/ffff\u0007\u001b[?62;1;4cy')).toEqual({ text: 'xy', held: '', over: true });
    const first = stripReply('', 'a\u001b]11;rgb:ff');
    expect(first).toEqual({ text: 'a', held: '\u001b]11;rgb:ff', over: false });
    expect(stripReply(first.held, 'ff/0/0\u001b\\\u001b[?1;2cb')).toEqual({ text: 'b', held: '', over: true });
    // Keys pass untouched, Esc included.
    expect(stripReply('', 'j\u001b')).toEqual({ text: 'j\u001b', held: '', over: false });
    expect(stripReply('', '\u001b[A')).toEqual({ text: '\u001b[A', held: '', over: false });
  });

  it('keeps an answer that comes after the timeout from reaching the screens as keys', async () => {
    const tty = <T extends object>(s: T) => Object.assign(s, { isTTY: true, isRaw: false, setRawMode: (raw: boolean) => Object.assign(s, { isRaw: raw }) });
    const stdin = tty(new PassThrough()) as unknown as NodeJS.ReadStream;
    const stdout = tty(new PassThrough()) as unknown as NodeJS.WriteStream;
    expect(await detectBackground({ stdin, stdout, env: {}, timeoutMs: 10 })).toBeUndefined();
    stdin.setEncoding('utf8'); // as Ink reads it
    (stdin as unknown as PassThrough).write('\u001b]11;rgb:ffff/ffff/ffff\u0007\u001b[?62;1;4c');
    expect(stdin.read() ?? '').toBe('');
    // Once the answer has gone by, input is read as it was.
    (stdin as unknown as PassThrough).write('\u001b[?1;2cq');
    expect(stdin.read()).toBe('\u001b[?1;2cq');
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
