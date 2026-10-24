import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { GLYPH_SETS } from '../src/tui/glyphs.js';

describe('glyphs', () => {
  it('are each one cell wide, so columns of marks line up', () => {
    for (const [set, glyphs] of Object.entries(GLYPH_SETS)) {
      const wide = Object.entries(glyphs).filter(([, g]) => stringWidth(g) !== 1);
      expect(wide, set).toEqual([]);
    }
  });

  it('has a plain character for every mark', () => {
    expect(Object.keys(GLYPH_SETS.ascii)).toEqual(Object.keys(GLYPH_SETS.unicode));
    for (const g of Object.values(GLYPH_SETS.ascii)) expect(g).toMatch(/^[\x21-\x7e]$/);
  });
});

describe('file icons', () => {
  it('are off until asked for, then name the file type', async () => {
    const { fileIcon, setIcons } = await import('../src/tui/icons.js');
    expect(fileIcon('src/a.ts')).toBe('');
    setIcons('nerd');
    expect(fileIcon('src/a.ts')).toBe(' ');
    expect(fileIcon('Dockerfile')).toBe(' ');
    expect(fileIcon('notes.unknown')).toBe(' ');
    setIcons('none');
  });
});
