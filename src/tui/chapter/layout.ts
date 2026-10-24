import type { DiffLine } from '../../types.js';
import { line, type MdLine } from '../markdown.js';
import { codePaneWidths, MIN_SPLIT_WIDTH } from '../paneWidths.js';
import { breakpoint, hasSidePanel } from '../breakpoints.js';

const TITLE_ROWS = 1;
const LIST_WIDTH = 36;
const SHORT_LINES = 2; // a short explanation's lines before its note
const FOOTER_ROWS = 3;

export interface LayoutInput {
  width: number;
  height: number;
  banner: boolean;
  hunkLines?: DiffLine[]; // the hunk on screen, if any
  testLines: DiffLine[]; // the selected linked test's code
  linkedTests: boolean; // a test, or the code a test covers, is linked to the hunk
  collapsedHunks?: number; // a collapsed chapter's summary is on screen, listing this many hunks
  testFocus: boolean;
  split: boolean; // the reader wants old and new side by side
  hideTests: boolean;
  raw: boolean;
  sidebar?: boolean;
  short?: boolean; // the explanation cut to its first lines (a saved preference) // the chapter list beside the chapter, on a wide terminal (\ toggles it)
  listOpen: boolean; // the comment's @ list is open
  explain: (width: number) => MdLine[]; // the explanation's lines at its inner width
}

export type ChapterLayout = ReturnType<typeof chapterLayout>;

// Where everything on the chapter screen goes and how big it is, for one terminal size and view.
export function chapterLayout(i: LayoutInput) {
  const wide = i.sidebar !== false && breakpoint(i.width) === 'wide'; // the chapter list sits on the left
  const roomForTests = hasSidePanel(i.width - (wide ? LIST_WIDTH + 1 : 0)); // tests can sit beside the code
  const listWidth = wide ? LIST_WIDTH : 0;
  const mainWidth = i.width - listWidth - (wide ? 1 : 0);
  const panes = codePaneWidths(
    mainWidth - 1,
    i.hunkLines?.map((l) => l.text) ?? [],
    i.testLines.map((l) => l.text),
    i.testFocus ? 'test' : 'source',
    i.split,
  );
  const showTests = i.linkedTests && !i.hideTests;
  // A split diff too narrow to read beside the tests stacks them instead: t still opens them.
  const testsStacked = roomForTests && showTests && i.split && panes.source < MIN_SPLIT_WIDTH;
  // While the comment's @ list is open the pane holding it takes the full width, so the list
  // and its code preview sit side by side; the other pane comes back when the list closes.
  const sideBySide = roomForTests && showTests && !testsStacked && !i.listOpen;
  // Stacked, only one pane shows at a time, so whichever is visible gets the full width.
  const srcWidth = sideBySide ? panes.source : mainWidth;
  const testWidth = sideBySide ? panes.test : mainWidth;
  const splitView = i.split && !i.raw && srcWidth >= MIN_SPLIT_WIDTH;

  const headerRows = 1 + (i.banner ? 1 : 0) + (wide ? 0 : 1);
  const mainHeight = i.height - headerRows - FOOTER_ROWS;
  // The explanation is its own large section above the code: narration, the author's note,
  // notes on the chapter or hunk, and the no-test hint. It takes what it needs, up to about
  // half the screen; the code gets the rest.
  const avail = mainHeight - TITLE_ROWS;
  const explainAll = i.explain(mainWidth - 2); // the left rule
  const collapsed = i.collapsedHunks !== undefined;
  const codeNeed = collapsed ? Math.min(i.collapsedHunks!, 10) : Math.min((i.hunkLines?.length ?? 0) + 1, 14);
  const explainMax = Math.max(4, Math.max(Math.floor(avail * 0.5), avail - codeNeed - 3) - 1);
  const cap = i.short ? Math.min(explainMax, SHORT_LINES + 1) : explainMax;
  const explainLines =
    explainAll.length > cap
      ? [
          ...explainAll.slice(0, cap - 1),
          line(i.short ? `… ${explainAll.length - cap + 1} more lines · the whole explanation is in the palette (:)` : '… more than fits: widen or heighten the terminal', { dim: true }),
        ]
      : explainAll;
  const explainRows = explainLines.length ? explainLines.length + 1 : 0; // and a blank row under it
  const bodyHeight = Math.max(6, avail - explainRows);

  const hunk = !collapsed && !!i.hunkLines;
  // Beside the code the test pane sits in a bordered column under a title row.
  const testInlineWidth = sideBySide ? testWidth - 3 : testWidth - 1;
  return {
    wide,
    listWidth,
    mainWidth,
    mainHeight,
    sideBySide,
    testsStacked,
    srcWidth,
    testWidth,
    splitView,
    headerRows,
    explainMax,
    explainLines,
    bodyHeight,
    threadHeight: Math.min(Math.max(6, bodyHeight - 2), Math.max(8, Math.floor(bodyHeight * 0.7))),
    askHeight: Math.min(14, Math.max(5, bodyHeight - 2)),
    askWidth: i.testFocus ? testInlineWidth : hunk ? srcWidth - 1 : mainWidth,
    collapsed,
    sourcePaneShown: hunk && (sideBySide || !i.testFocus || !i.linkedTests),
    testPaneShown: hunk && (sideBySide || (i.testFocus && i.linkedTests)),
    testPane: { width: sideBySide ? testWidth - 2 : testWidth, height: sideBySide ? bodyHeight - 1 : bodyHeight, inlineWidth: testInlineWidth },
  };
}

export type OverlayKind = 'none' | 'diagram' | 'comment' | 'thread' | 'reply' | 'ask' | 'move' | 'help' | 'checklist' | 'delete' | 'palette';

export interface SlotInput {
  overlay: OverlayKind;
  testFocus: boolean;
  threadsHere: boolean; // review threads on the cursor line
  draftHere: boolean; // an unposted draft on the cursor line
  commentOpen: boolean; // a draft and its composer state
  lineComment: boolean; // the open comment is on a line or range, so it goes under the code
  checklist: boolean; // the chapter has a checklist and the checkout is ready
}

// Where the open overlay mounts: in place of the chapter (popup), under a line of the source or
// test pane, or under the collapsed summary. `shown` is false when it has nowhere to go (its hunk
// or thread went away); it would then hold the keyboard with nothing on screen, so it closes.
export function overlaySlots(plan: ChapterLayout, o: SlotInput) {
  const { overlay } = o;
  const popup = overlay === 'diagram' || overlay === 'move' || (overlay === 'checklist' && o.checklist) || (overlay === 'comment' && o.commentOpen && !o.lineComment) ? overlay : undefined;
  const lineComment = overlay === 'comment' && o.lineComment;
  const sourceInline = !plan.sourcePaneShown
    ? undefined
    : (overlay === 'thread' || overlay === 'reply') && o.threadsHere
      ? 'thread'
      : lineComment && !o.testFocus
        ? 'comment'
        : overlay === 'ask' && !o.testFocus
          ? 'ask'
          : undefined;
  const testInline = !plan.testPaneShown ? undefined : lineComment && o.testFocus ? 'comment' : overlay === 'ask' && o.testFocus ? 'ask' : undefined;
  const collapsedAsk = plan.collapsed && overlay === 'ask';
  const confirmDelete = overlay === 'delete' && o.draftHere;
  return {
    popup,
    sourceInline,
    testInline,
    collapsedAsk,
    confirmDelete,
    shown: overlay === 'help' || overlay === 'palette' || confirmDelete || !!popup || collapsedAsk || !!sourceInline || !!testInline,
  } as const;
}
