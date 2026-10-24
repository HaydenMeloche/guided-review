// Every mark the screens draw, in one family: geometric shapes and a few dingbats, each one cell
// wide (test/glyphs.test.ts checks), so columns of marks stay aligned. "glyphs": "ascii" in
// config.json swaps in plain characters for terminals and fonts that lack these.

export type GlyphSet = 'unicode' | 'ascii';

const UNICODE = {
  read: '✓',
  skipped: '–',
  deferred: '◇',
  unread: '·',
  risk: '▲',
  lowRisk: '△',
  tested: '●',
  partial: '◐',
  untested: '○',
  draft: '✎',
  thread: '┊',
  moved: '↕',
  flag: '▲',
  note: '·',
  recent: '◇',
  marked: '■',
  queued: '◌',
  done: '✓',
  failed: '✗',
  cursor: '▶',
  range: '┃',
  wrapped: '↪',
  selected: '▌',
  model: '✦',
  meterOn: '▰',
  meterOff: '▱',
  rule: '─',
  gutter: '│',
  up: '↑',
};

export type Glyphs = typeof UNICODE;

const ASCII: Glyphs = {
  read: '+',
  skipped: '-',
  deferred: '~',
  unread: '.',
  risk: '^',
  lowRisk: '^',
  tested: '*',
  partial: 'o',
  untested: '.',
  draft: '*',
  thread: ':',
  moved: '|',
  flag: '!',
  note: 'i',
  recent: '~',
  marked: 'x',
  queued: '.',
  done: '+',
  failed: 'x',
  cursor: '>',
  range: '|',
  wrapped: '>',
  selected: '|',
  model: '*',
  meterOn: '#',
  meterOff: '-',
  rule: '-',
  gutter: '|',
  up: '^',
};

export const GLYPH_SETS: Record<GlyphSet, Glyphs> = { unicode: UNICODE, ascii: ASCII };

// The marks in use, set once at startup from the config.
export let G: Glyphs = UNICODE;

export function setGlyphs(set: GlyphSet): void {
  G = GLYPH_SETS[set];
}
