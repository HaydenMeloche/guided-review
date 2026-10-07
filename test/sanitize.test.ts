import { describe, expect, it } from 'vitest';
import { sanitizeTerminal } from '../src/util/sanitize.js';

describe('sanitizeTerminal', () => {
  it('strips ESC so CSI sequences become inert text', () => {
    expect(sanitizeTerminal('a\u001b[2Jb')).toBe('a[2Jb');
    expect(sanitizeTerminal('\u001b[31mred\u001b[0m')).toBe('[31mred[0m');
  });

  it('defuses OSC 52 clipboard writes and OSC 0 title changes', () => {
    const out = sanitizeTerminal('Fix bug\u001b]52;c;Y3VybCBldmlsLnNofHNo\u0007 now');
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('\u0007');
    expect(sanitizeTerminal('\u001b]0;pwned\u001b\\')).toBe(']0;pwned\\');
  });

  it('strips BEL and the other C0 controls, including CR', () => {
    expect(sanitizeTerminal('ding\u0007')).toBe('ding');
    expect(sanitizeTerminal('\u0000\u0001\u0008\u000b\u000c\u000e\u001f')).toBe('');
    expect(sanitizeTerminal('safe\rEVIL')).toBe('safeEVIL');
    expect(sanitizeTerminal('del\u007f')).toBe('del');
  });

  it('strips C1 controls: CSI (\\u009b), ST (\\u009c) and OSC (\\u009d)', () => {
    expect(sanitizeTerminal('a\u009b2Jb')).toBe('a2Jb');
    expect(sanitizeTerminal('\u009d52;c;eA==\u009c')).toBe('52;c;eA==');
    expect(sanitizeTerminal('\u0080\u0085\u009f')).toBe('');
  });

  it('keeps newlines, tabs and ordinary Unicode', () => {
    expect(sanitizeTerminal('line 1\n\tline 2')).toBe('line 1\n\tline 2');
    expect(sanitizeTerminal('café → ✓ 日本  ')).toBe('café → ✓ 日本  ');
  });
});
