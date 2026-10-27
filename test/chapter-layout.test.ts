import { describe, expect, it } from 'vitest';
import type { DiffLine } from '../src/types.js';
import { chapterLayout, overlaySlots, type LayoutInput, type SlotInput } from '../src/tui/chapter/layout.js';
import { line } from '../src/tui/markdown.js';

const code = (n: number, width = 20): DiffLine[] => Array.from({ length: n }, (_, i) => ({ kind: 'add', text: 'x'.repeat(width), newLine: i + 1 }));
const base: LayoutInput = {
  width: 100,
  height: 40,
  banner: false,
  hunkLines: code(5),
  testLines: code(8),
  linkedTests: true,
  testFocus: false,
  split: false,
  hideTests: false,
  raw: false,
  listOpen: false,
  explain: () => [],
};
const layout = (o: Partial<LayoutInput>) => chapterLayout({ ...base, ...o });

describe('chapterLayout widths', () => {
  it.each([
    ['narrow', { width: 100 }, { wide: false, listWidth: 0, mainWidth: 100, sideBySide: false, testsStacked: false, srcWidth: 100, testWidth: 100, splitView: false }],
    ['narrow, split', { width: 100, split: true }, { sideBySide: false, testsStacked: false, srcWidth: 100, splitView: true }],
    ['130', { width: 130 }, { wide: false, mainWidth: 130, sideBySide: true, testsStacked: false }],
    ['130, split of short lines stacks the tests', { width: 130, split: true }, { sideBySide: false, testsStacked: true, srcWidth: 130, testWidth: 130, splitView: true }],
    ['130, tests hidden', { width: 130, hideTests: true }, { sideBySide: false, testsStacked: false, srcWidth: 130 }],
    ['130, @ list open', { width: 130, listOpen: true }, { sideBySide: false, srcWidth: 130 }],
    ['130, no linked tests', { width: 130, linkedTests: false }, { sideBySide: false, srcWidth: 130 }],
    ['180', { width: 180 }, { wide: true, listWidth: 36, mainWidth: 143, sideBySide: true }],
    ['180, split of long lines sits beside the tests', { width: 180, split: true, hunkLines: code(5, 60) }, { sideBySide: true, testsStacked: false, srcWidth: 102, testWidth: 40, splitView: true }],
    ['180, split but raw', { width: 180, split: true, raw: true, hunkLines: code(5, 60) }, { sideBySide: true, splitView: false }],
    ['140 has the chapter list', { width: 140 }, { wide: true, listWidth: 36, mainWidth: 103, sideBySide: false }],
    ['140 with the list hidden', { width: 140, sidebar: false }, { wide: false, mainWidth: 140, sideBySide: true }],
    ['200, split of short lines', { width: 200, split: true }, { wide: true, mainWidth: 163, sideBySide: false, testsStacked: true, splitView: true }],
  ] as const)('%s', (_, input, want) => {
    expect(layout(input)).toMatchObject(want);
  });

  it('beside the code, the panes share the main width less the gutter', () => {
    const p = layout({ width: 150, hunkLines: code(5, 200) });
    expect(p.sideBySide).toBe(true);
    expect(p.srcWidth + p.testWidth).toBe(p.mainWidth - 1);
  });
});

describe('chapterLayout heights', () => {
  it('counts the banner and the narrow chapter strip in the header', () => {
    expect(layout({ width: 100 }).headerRows).toBe(2);
    expect(layout({ width: 100, banner: true }).headerRows).toBe(3);
    expect(layout({ width: 180 }).headerRows).toBe(1);
    expect(layout({ width: 180 }).mainHeight).toBe(36);
  });

  it('gives the code the rest when there is no explanation', () => {
    const p = layout({});
    expect(p.explainLines).toEqual([]);
    expect(p.bodyHeight).toBe(34);
    expect(p.threadHeight).toBe(17);
    expect(p.askHeight).toBe(20);
  });

  it('cuts a long explanation to explainMax, ending in a note', () => {
    const p = layout({ explain: () => Array.from({ length: 30 }, (_, i) => line(`l${i}`)) });
    expect(p.explainMax).toBe(24);
    expect(p.explainLines).toHaveLength(24);
    expect(p.explainLines.at(-1)).toEqual(line('… 7 more lines · tab to it, then j/k to scroll or enter to read it all', { dim: true }));
    // Scrolled, it shows a later window and says what is above.
    const scrolled = layout({ explain: () => Array.from({ length: 30 }, (_, i) => line(`l${i}`)), explainScroll: 3 });
    expect(scrolled.explainLines[0]).toEqual(line('l3'));
    expect(scrolled.explainLines.at(-1)).toEqual(line('… 3 above, 4 more lines · tab to it, then j/k to scroll or enter to read it all', { dim: true }));
    expect(p.bodyHeight).toBe(9);
    expect(p.threadHeight).toBe(7);
    expect(p.askHeight).toBe(7);
  });

  it('lays out the explanation at its inner width', () => {
    let asked = 0;
    layout({ width: 180, explain: (w) => ((asked = w), []) });
    expect(asked).toBe(141);
  });

  it('never squeezes the code below six rows', () => {
    expect(layout({ height: 12, explain: () => Array.from({ length: 30 }, () => []) }).bodyHeight).toBe(6);
  });
});

describe('chapterLayout panes', () => {
  it('stacked, shows the source or the focused tests', () => {
    expect(layout({})).toMatchObject({ sourcePaneShown: true, testPaneShown: false });
    expect(layout({ testFocus: true })).toMatchObject({ sourcePaneShown: false, testPaneShown: true, testPane: { width: 100, inlineWidth: 99 } });
    expect(layout({ testFocus: true }).testPane.height).toBe(layout({ testFocus: true }).bodyHeight);
  });

  it('beside the code, shows both, the tests in a bordered column', () => {
    const p = layout({ width: 150 });
    expect(p).toMatchObject({ sourcePaneShown: true, testPaneShown: true });
    expect(p.testPane).toEqual({ width: p.testWidth - 2, height: p.bodyHeight - 1, inlineWidth: p.testWidth - 3 });
  });

  it('shows the source when t has nothing to focus', () => {
    expect(layout({ testFocus: true, linkedTests: false })).toMatchObject({ sourcePaneShown: true, testPaneShown: false });
  });

  it('shows no code pane on a collapsed summary or without a hunk', () => {
    expect(layout({ hunkLines: undefined, collapsedHunks: 3 })).toMatchObject({ collapsed: true, sourcePaneShown: false, testPaneShown: false, askWidth: 100 });
    expect(layout({ hunkLines: undefined })).toMatchObject({ collapsed: false, sourcePaneShown: false, testPaneShown: false });
  });

  it('sizes the ask panel to the pane it opens in', () => {
    expect(layout({}).askWidth).toBe(99);
    const p = layout({ width: 150, testFocus: true });
    expect(p.askWidth).toBe(p.testWidth - 3);
  });
});

describe('overlaySlots', () => {
  const none: SlotInput = { overlay: 'none', testFocus: false, threadsHere: false, commentOpen: false, lineComment: false, checklist: false };
  const slots = (o: Partial<SlotInput>, plan = layout({})) => overlaySlots(plan, { ...none, ...o });

  it('opens a thread or the ask panel in the right column when tests sit beside the code', () => {
    const beside = layout({ width: 130 });
    expect(slots({ overlay: 'thread', threadsHere: true }, beside)).toMatchObject({ side: 'thread', sourceInline: undefined, shown: true });
    expect(slots({ overlay: 'ask' }, beside)).toMatchObject({ side: 'ask', sourceInline: undefined });
    // Stacked, they open under the line as before.
    expect(slots({ overlay: 'thread', threadsHere: true })).toMatchObject({ side: undefined, sourceInline: 'thread' });
  });

  it('shows nothing with no overlay', () => {
    expect(slots({})).toMatchObject({ popup: undefined, sourceInline: undefined, testInline: undefined, shown: false });
  });

  it.each([
    ['help', { overlay: 'help' }, true],
    ['diagram', { overlay: 'diagram' }, true],
    ['move', { overlay: 'move' }, true],
    ['checklist', { overlay: 'checklist', checklist: true }, true],
    ['checklist before the checkout is ready', { overlay: 'checklist' }, false],
    ['thread on a commented line', { overlay: 'thread', threadsHere: true }, true],
    ['reply with the thread gone', { overlay: 'reply' }, false],
    ['a chapter comment', { overlay: 'comment', commentOpen: true }, true],
    ['a line comment', { overlay: 'comment', commentOpen: true, lineComment: true }, true],
    ['ask', { overlay: 'ask' }, true],
  ] as const)('%s → shown %s', (_, o, shown) => {
    expect(slots(o).shown).toBe(shown);
  });

  it('puts a line comment under the pane that has focus', () => {
    expect(slots({ overlay: 'comment', commentOpen: true, lineComment: true })).toMatchObject({ popup: undefined, sourceInline: 'comment', testInline: undefined });
    expect(slots({ overlay: 'comment', commentOpen: true, lineComment: true, testFocus: true }, layout({ testFocus: true }))).toMatchObject({ sourceInline: undefined, testInline: 'comment' });
    expect(slots({ overlay: 'comment', commentOpen: true })).toMatchObject({ popup: 'comment', sourceInline: undefined });
  });

  it('puts ask under the focused pane, or the collapsed summary', () => {
    expect(slots({ overlay: 'ask' })).toMatchObject({ sourceInline: 'ask', testInline: undefined, collapsedAsk: false });
    expect(slots({ overlay: 'ask', testFocus: true }, layout({ width: 150, testFocus: true }))).toMatchObject({ sourceInline: undefined, testInline: 'ask' });
    expect(slots({ overlay: 'ask' }, layout({ hunkLines: undefined, collapsedHunks: 2 }))).toMatchObject({ collapsedAsk: true, shown: true });
  });

  it('closes a line comment or thread with no code pane to sit in', () => {
    const summary = layout({ hunkLines: undefined, collapsedHunks: 2 });
    expect(slots({ overlay: 'comment', commentOpen: true, lineComment: true }, summary).shown).toBe(false);
    expect(slots({ overlay: 'thread', threadsHere: true }, summary).shown).toBe(false);
  });

  it('shows a thread in the source pane even while beside tests have focus', () => {
    expect(slots({ overlay: 'thread', threadsHere: true, testFocus: true }, layout({ width: 150, testFocus: true })).sourceInline).toBe('thread');
  });
});
