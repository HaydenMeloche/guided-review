import React, { use, useEffect, useMemo, useRef, useState } from 'react';
import { useInput } from './input.js';
import { Box, Text } from './themed.js';
import type { Chapter, ChapterOrder, Draft, DraftAnchor, ExistingThread, Hunk, ReactionContent, ReadState, ThreadComment, Tour } from '../types.js';
import { ChecklistPanel, Reader } from './Panels.js';
import { firstHunk, hunkPosition, lockPairOfHunk, nextPos, opensOnSummary, pad, pageOf, prevPos, progress, stateOf, summaryHunkIds, type States } from './nav.js';
import { DiagramView } from './DiagramView.js';
import { CommentEditor, CommentLabels, type SetComposer } from './CommentEditor.js';
import { INLINE_ROWS, inlineComposerSlot } from './AiSuggestion.js';
import { ThreadView } from './ThreadView.js';
import { AskOverlay } from './AskOverlay.js';
import { MIN_SPLIT_WIDTH } from './paneWidths.js';
import type { AgentContext } from '../agent/types.js';
import { KeyBar, type Hint } from './KeyBar.js';
import { initComposer, isLineAnchor, sameAnchor, type ComposerEnv, type ComposerState, type ReferenceServices } from './composer.js';
import { generateSuggestion } from '../agent/suggest.js';
import { safe } from './chapter/text.js';
import { copiesNote, cursorNotes } from './chapter/lineNotes.js';
import { useMentions } from './chapter/mentions.js';
import { linkedTests } from './chapter/linkedTests.js';
import { SourcePane } from './chapter/SourcePane.js';
import { TestPane } from './chapter/TestPane.js';
import { ChapterList, ChapterStrip, ChapterTitle, CollapsedSummary, EmptyChapter, Explanation, Header, LockfileChanges, MoveList, StatusRow } from './chapter/parts.js';
import { HelpPopup } from './Help.js';
import { ReviewPopup } from './ReviewPopup.js';
import { reviewLegend } from './legend.js';
import { anchorLines, crossesContext, describeAnchor, lineAnchor, newDraft, selectedCode, selRange, testLineAnchor } from './chapter/selection.js';
import { CONTEXT_STEP, useFoldedCursor, useFolds, useHunkView } from './chapter/hunkView.js';
import { barEnd, barKeys, PALETTE_HINT, chapterHelp, keyAction, paletteCommands, type Action, type KeyCtx, type View } from './chapter/keys.js';
import { CommandPalette, type PaletteItem } from './CommandPalette.js';
import { explanation } from './chapter/guide.js';
import { lockListLines, lockPage } from './chapter/lockList.js';
import { unboundKey, useFlash } from './flash.js';
import { plural } from './plural.js';
import { chapterLayout, overlaySlots, type OverlayKind } from './chapter/layout.js';
import { G } from './glyphs.js';
import { hunkKeys } from '../review/hunkState.js';
import { sameChange } from '../diff/parse.js';
import { CopiesCard, copiesCardHeight } from './chapter/CopiesCard.js';
import { WIDE } from './breakpoints.js';
import { EndCard } from './chapter/EndCard.js';
import { EVENT_TEXT, suggestVerdict } from '../review/submit.js';

export { KeyBar };

// "src/x.ts:27–31": an open range, by its lines on the side they are on.
function rangeLabel(hunk: Hunk, sel: [number, number]): string {
  const at = (i: number) => hunk.lines[i]?.newLine ?? hunk.lines[i]?.oldLine;
  const [a, b] = [at(sel[0]), at(sel[1])];
  return `${hunk.file}:${a === b ? a : `${a}–${b}`}`;
}

export type AgentCtx = AgentContext;

// The open overlay, holding the state only it uses: a comment's draft and composer, the move list's selection.
type Overlay = { kind: 'none' } | { kind: 'comment'; draft: Draft; composer: ComposerState } | { kind: 'move'; sel: number } | { kind: Exclude<OverlayKind, 'none' | 'comment' | 'move'> };
const NONE: Overlay = { kind: 'none' };

// v1.1 features that need the worktree, the repo config or the store.
export interface Services {
  root: string;
  confirms: Record<string, boolean>;
  setConfirm: (id: string, v: boolean) => void;
  // Loads repository collaborators for @mention suggestions; absent in preview mode and tests.
  loadMentionUsers?: () => Promise<string[]>;
}

// A view setting App owns and saves, or, when it passes none (tests), one the screen keeps.
function useSetting(value: boolean | undefined, toggle: (() => void) | undefined, initial: boolean): [boolean, () => void] {
  const [own, setOwn] = useState(initial);
  return [value ?? own, toggle ?? (() => setOwn((v) => !v))];
}

export function ChapterScreen(props: {
  tour: Tour;
  chapters: Chapter[];
  allChapters?: Chapter[]; // the whole tour; a re-review greys the chapters `chapters` leaves out
  states: States;
  drafts: Draft[];
  ci: number;
  hi: number;
  order: ChapterOrder;
  deltaOnly: boolean;
  banner?: string; // a notice that needs a decision (the author pushed); esc folds it into the header
  busy?: string; // background work, shown quietly in the header
  agent?: AgentCtx;
  aiOff?: string; // why the agent is absent
  width: number;
  height: number;
  active?: boolean;
  setPos: (ci: number, hi: number) => void;
  // Marks hunks read, skipped, deferred or unread, all in one store write.
  setState: (hunks: Hunk[], s: ReadState) => void;
  saveDraft: (d: Draft) => void;
  deleteDraft: (d: Draft) => void;
  replyToThread?: (thread: ExistingThread, body: string) => Promise<void>;
  reactToComment?: (comment: ThreadComment, content: ReactionContent, remove: boolean) => Promise<void>;
  moveHunk: (h: Hunk, chapterId: string) => void;
  toggleOrder: () => void;
  hideWhitespace?: boolean; // hide whitespace-only changes; the screen keeps its own when unset
  toggleWhitespace?: () => void;
  splitDiff?: boolean; // old and new side by side; the screen keeps its own when unset
  toggleSplit?: () => void;
  sidebar?: boolean; // the chapter list beside the chapter, when wide; likewise
  toggleSidebar?: () => void;
  shortExplanation?: boolean; // the explanation cut to its first lines; likewise
  toggleExplanation?: () => void;
  takeTip?: (tip: string) => boolean; // true once per tip: show it (first-run tips)
  hideTestPane?: boolean; // keep linked tests out of the way (t still opens them); likewise
  toggleTestPane?: () => void;
  toggleDelta: () => void;
  openSubmit: () => void;
  openBriefing: () => void;
  openInAgent: (h: Hunk | undefined, chapter: Chapter) => void;
  rebase?: () => void;
  onTheme?: () => void; // L: the color theme picker
  services?: Services;
  references?: ReferenceServices; // recent locations, repo index; tests may leave it out
  quit: () => void;
}) {
  const { tour, chapters, states, ci, hi, width, height } = props;
  const chapter = chapters[ci];
  const diffHunk: Hunk | undefined = chapter && hi >= 0 ? tour.hunks[chapter.hunkIds[hi]] : undefined;
  const svc = props.services;
  const { flash, show: setFlash, dismiss: dismissFlash } = useFlash();
  const view = useHunkView(diffHunk, tour, svc?.root, setFlash);
  const { hunk, cursor, anchor, setAnchor, scroll, setScroll, raw, setRaw, testFocus, setTestFocus, testIdx, setTestIdx, testCursor, setTestCursor, testScroll, setTestScroll, growContext } = view;
  const [ignoreWhitespace, toggleWhitespace] = useSetting(props.hideWhitespace, props.toggleWhitespace, true);
  const [wantSplit, toggleSplit] = useSetting(props.splitDiff, props.toggleSplit, false);
  const [hideTests, toggleTestPane] = useSetting(props.hideTestPane, props.toggleTestPane, false);
  const [sidebar, toggleSidebar] = useSetting(props.sidebar, props.toggleSidebar, true);
  const [shortExplanation, toggleExplanation] = useSetting(props.shortExplanation, props.toggleExplanation, false);
  const [showUntested, setShowUntested] = useState(false);
  const [foldImports, setFoldImports] = useState(true);
  const [overlay, setOverlay] = useState<Overlay>(NONE);
  const close = () => setOverlay(NONE);
  const show = (kind: Exclude<OverlayKind, 'none' | 'comment' | 'move'>) => setOverlay({ kind });
  const [summarySel, setSummarySel] = useState(0);
  // Which pane has the keys besides the code and the tests (which keep their own testFocus):
  // the chapter list or the explanation. Tab moves it; Esc brings it back to the code.
  const [paneFocus, setPaneFocus] = useState<'code' | 'list' | 'explain'>('code');
  const [listSel, setListSel] = useState(0);
  const [explainScroll, setExplainScroll] = useState(0);
  // Esc folds the banner into a tag in the header; a new notice unfolds it.
  const [folded, setFolded] = useState<string>();
  const banner = props.banner && props.banner !== folded ? props.banner : undefined;
  const ev = props.references;
  // The open composer's working state (see composer.ts).
  const setComposerState: SetComposer = (f) => setOverlay((o) => (o.kind === 'comment' ? { ...o, composer: f(o.composer) } : o));
  const mentions = useMentions(tour, overlay.kind === 'comment' || overlay.kind === 'reply' || overlay.kind === 'thread', svc?.loadMentionUsers);
  const linked = useMemo(() => linkedTests(hunk, testIdx), [hunk, testIdx]);
  const { tests: relevantTests, selected: selectedTest, file: testFile, lines: testCodeLines } = linked;

  const hasLinkedTests = linked.any;
  const collapsedView = opensOnSummary(chapter) && hi < 0;
  const summaryIds = useMemo(() => (chapter ? summaryHunkIds(chapter) : []), [chapter]);
  const labels = use(CommentLabels);
  const filesByPath = useMemo(() => new Map(tour.files.map((f) => [f.path, f])), [tour.files]);
  // Hunks that make the same change (a line added to 15 tests), by that change.
  const copies = useMemo(() => {
    const m = new Map<string, Hunk[]>();
    for (const h of Object.values(tour.hunks)) {
      const k = sameChange(h);
      const group = m.get(k);
      if (group) group.push(h);
      else m.set(k, [h]);
    }
    return m;
  }, [tour.hunks]);
  const copiesOf = (h: Hunk) => copies.get(sameChange(h)) ?? [h];
  const hunkCopies = useMemo(() => {
    const others = hunk ? (copies.get(sameChange(hunk)) ?? []).filter((h) => h.id !== hunk.id) : [];
    return others.length ? { others: others.length, unread: others.filter((h) => stateOf(states, h) === 'unread').length } : undefined;
  }, [hunk, copies, states]);
  const [askCopies, setAskCopies] = useState<Hunk[]>(); // n's question: read these unread copies too?
  const oneByOne = useRef(new Set<string>()); // changes whose copies the reviewer reads one at a time
  // A lockfile pair's manifest page lists the lockfile's package changes under the diff.
  const at = chapter && hunk ? hunkPosition(chapter, hi) : undefined;
  const lockList = useMemo(() => (chapter && hunk ? lockPage(tour, chapter, hunk.id) : undefined), [tour, chapter, hunk]);
  const plan = chapterLayout({
    width,
    height,
    banner: !!banner,
    hunkLines: hunk?.lines,
    noteWidth: hunkCopies ? copiesNote(hunkCopies).length : 0,
    testLines: testCodeLines,
    linkedTests: hasLinkedTests,
    collapsedHunks: collapsedView ? summaryIds.length : undefined,
    testFocus,
    split: wantSplit,
    hideTests,
    raw,
    sidebar,
    short: shortExplanation,
    explainScroll,
    listOpen: overlay.kind === 'comment' && !!overlay.composer.listOpen,
    lockRows: lockList ? (w) => lockListLines(lockList, w - 1).length : undefined,
    explain: (w) => (chapter ? explanation({ tour, chapter, hunk, hi, collapsed: collapsedView, files: filesByPath, confirms: svc?.confirms, linkedTests: hasLinkedTests, showUntested }, w) : []),
  });
  const { wide, listWidth, mainWidth, sideBySide, srcWidth, splitView, bodyHeight, askHeight } = plan;

  const { partner, hidden, runs, land } = useFolds(hunk, ignoreWhitespace, splitView, foldImports);
  const moveCursor = useFoldedCursor(view, hidden, partner, land);
  const cursorLine = hunk?.lines[cursor];
  const { threads: cursorThreads, draft: cursorDraft } = cursorNotes(hunk, cursor, hidden, partner, tour.existingThreads, props.drafts, runs.get(cursor));
  useEffect(() => {
    setSummarySel(0);
    setShowUntested(false);
  }, [chapter?.id]);
  useEffect(() => setExplainScroll(0), [chapter?.id, hunk?.id]);
  // First-run tips, one at a time in the status row, each shown once: how to move on the first
  // hunk, and how to read a review thread the first time one is on screen.
  // A thread's line and originalLine are optional (an outdated or file thread may have neither).
  const hunkHasThreads =
    !!hunk &&
    tour.existingThreads.some((t) => t.path === hunk.file && hunk.lines.some((l) => (t.line !== undefined && l.newLine === t.line) || (t.originalLine !== undefined && l.oldLine === t.originalLine)));
  useEffect(() => {
    if (!hunk || flash) return;
    if (props.takeTip?.('first-chapter')) setFlash('Tip: n marks this hunk read and moves on; ? lists every key.', 'tip');
    else if (hunkHasThreads && props.takeTip?.('first-thread')) setFlash(`Tip: ${G.thread} marks a review thread: e reads it, y replies.`, 'tip');
    // A tip is a one-off on arriving at a hunk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hunk?.id]);

  // An explanation that arrives while its hunk is on screen says so for a moment.
  const narration = hunk?.narration;
  const [updated, setUpdated] = useState(false);
  const seen = useRef<{ id?: string; text?: string }>({});
  useEffect(() => {
    const changed = seen.current.id === hunk?.id && seen.current.text !== narration && !!narration;
    seen.current = { id: hunk?.id, text: narration };
    if (!changed) return;
    setUpdated(true);
    const t = setTimeout(() => setUpdated(false), 3000);
    return () => clearTimeout(t);
  }, [hunk?.id, narration]);

  const prog = useMemo(() => progress(tour, states), [tour, states]);
  const delta = useMemo(() => new Set(tour.rereview?.newHunkIds ?? []), [tour.rereview]);
  // On a re-review showing only changes, the chapter list keeps the whole tour and greys what it leaves out.
  const listed = props.deltaOnly && props.allChapters ? props.allChapters : chapters;
  const unchangedHunks = props.deltaOnly && chapter ? (props.allChapters?.find((c) => c.id === chapter.id)?.hunkIds.length ?? 0) - chapter.hunkIds.length : 0;

  // ---------- navigation ----------
  const go = (to: { ci: number; hi: number } | undefined) => void (to && props.setPos(to.ci, to.hi));
  // A lockfile pair's hunks, read with its last manifest page still unread: marking that page
  // marks them too, as the summary page does for folded lockfiles.
  const pairedLocks = (h: Hunk | undefined): Hunk[] => {
    const pair = lockPairOfHunk(chapter, h?.id);
    if (!h || !pair) return [];
    const othersDone = pair.hunkIds.every((id) => id === h.id || !tour.hunks[id] || stateOf(states, tour.hunks[id]) !== 'unread');
    return othersDone ? pair.lockHunkIds.map((id) => tour.hunks[id]).filter((l) => l && stateOf(states, l) === 'unread') : [];
  };
  const next = (mark?: ReadState, past?: Set<string>) => {
    if (hunk && mark) props.setState([hunk, ...pairedLocks(hunk)], mark);
    if (!chapter) return;
    let to = nextPos(chapters, ci, hi);
    // Past the hunks just read with this one, when they follow it.
    while (to && past?.has(chapters[to.ci].hunkIds[to.hi])) to = nextPos(chapters, to.ci, to.hi);
    if (to) return go(to);
    // The last hunk: a card says what the review comes to, and s submits it.
    show('end');
  };

  const sel = selRange(cursor, anchor);
  const draft = (a: DraftAnchor) => newDraft(tour, a);

  const saveDraft = (d: Draft) => {
    const edited = props.drafts.some((x) => x.id === d.id);
    props.saveDraft(d);
    setAnchor(null);
    close();
    if (!edited && props.takeTip?.('first-draft')) return setFlash(`Tip: drafts stay on your machine until you submit them all at once with s.`, 'tip');
    setFlash(`Draft ${edited ? 'updated' : 'saved'}${labels ? ` (${d.label})` : ''}. Nothing posts until you submit.`, 'info');
  };

  // ---------- references: composer, recent locations ----------
  const noteRecent = useRef(ev?.noteRecent);
  noteRecent.current = ev?.noteRecent;
  // A line the reader stays on for a second is a recent location.
  const dwellPath = testFocus ? testFile : hunk?.file;
  const dwellLine = testFocus ? testCodeLines[testCursor]?.newLine : cursorLine?.kind !== 'del' ? cursorLine?.newLine : undefined;
  useEffect(() => {
    if (!dwellPath || dwellLine === undefined) return;
    const t = setTimeout(() => noteRecent.current?.({ path: dwellPath, line: dwellLine, why: testFocus ? 'test' : 'dwell' }), 1000);
    return () => clearTimeout(t);
  }, [dwellPath, dwellLine, testFocus]);

  const composerEnv: ComposerEnv = {
    tour,
    root: svc?.root,
    host: ev?.host ?? 'github.com',
    agent: props.agent,
    generate: ev?.generate ?? generateSuggestion,
    recent: ev?.recent,
    noteRecent: ev?.noteRecent,
    repoIndex: ev?.repoIndex,
  };
  const openComposer = (d: Draft) => {
    setOverlay({ kind: 'comment', draft: d, composer: initComposer(d, { index: ev?.repoIndex?.() }) });
    if (isLineAnchor(d.anchor)) noteRecent.current?.({ path: d.anchor.file, line: d.anchor.line, why: 'comment' });
  };

  // ---------- input ----------
  const keyView: View = testFocus ? 'tests' : collapsedView ? 'collapsed' : 'code';
  const keyCtx: KeyCtx = {
    hunk: !!hunk,
    chapter: !!chapter,
    agent: !!props.agent,
    selecting: anchor !== null,
    threads: cursorThreads.length > 0,
    reply: !!props.replyToThread,
    draft: !!cursorDraft,
    tests: hasLinkedTests,
    diagram: !!(chapter?.diagram || tour.overview),
    done: prog.read + prog.skipped === prog.total,
    split: splitView,
    rereview: !!tour.rereview,
    deltaOnly: props.deltaOnly,
    rebase: !!props.rebase,
    theme: !!props.onTheme,
  };
  const lastTestLine = Math.max(0, testCodeLines.length - 1);
  const stepTest = (by: number) => {
    const n = relevantTests.length;
    setTestScroll(0);
    setTestCursor(0);
    setTestIdx((i) => (n ? (i + by + n) % n : 0));
  };
  // n: this hunk read (a collapsed chapter's summary: its hunks), then on to the next.
  const readAndNext = () => {
    if (!collapsedView && hunk && chapter) {
      const locks = pairedLocks(hunk);
      const p = progress(tour, { ...states, ...Object.fromEntries([hunk, ...locks].flatMap(hunkKeys).map((k) => [k, 'read'])) }, chapter.hunkIds);
      const withLocks = locks.length ? ` with its ${plural(locks.length, 'lockfile hunk')}` : '';
      setFlash(`${G.read} hunk ${at?.n} read${withLocks} · ${p.read + p.skipped}/${p.total} in this chapter`, 'info');
    }
    // A collapsed chapter's hunks, and folded ones, are read as their summary: n on it marks them read.
    if (collapsedView && chapter) {
      const unread = summaryIds.map((id) => tour.hunks[id]).filter((h) => h && stateOf(states, h) === 'unread');
      if (unread.length) props.setState(unread, 'read');
      if (unread.length) setFlash(`${G.read} ${chapter.folded?.length ? 'lockfile ' : ''}summary read · ${plural(unread.length, 'hunk')}`, 'info');
    }
    next(collapsedView ? undefined : 'read');
  };
  // y to n's question: this hunk and the unread copies of its change read, then on past them.
  const readCopies = (others: Hunk[]) => {
    if (!hunk || !chapter) return;
    const all = [hunk, ...pairedLocks(hunk), ...others];
    props.setState(all, 'read');
    const p = progress(tour, { ...states, ...Object.fromEntries(all.flatMap(hunkKeys).map((k) => [k, 'read'])) }, chapter.hunkIds);
    setFlash(`${G.read} the same change read in ${plural(others.length + 1, 'hunk')} · ${p.read + p.skipped}/${p.total} in this chapter`, 'info');
    next(undefined, new Set(copiesOf(hunk).map((h) => h.id)));
  };
  const actions: Record<Action, () => void> = {
    briefing: () => props.openBriefing(),
    quit: () => props.quit(),
    // Tests
    leaveTests: () => setTestFocus(false),
    testDown: () => setTestCursor((i) => Math.min(lastTestLine, i + 1)),
    testUp: () => setTestCursor((i) => Math.max(0, i - 1)),
    testPageDown: () => setTestCursor((i) => Math.min(lastTestLine, i + 10)),
    testPageUp: () => setTestCursor((i) => Math.max(0, i - 10)),
    nextTest: () => stepTest(1),
    prevTest: () => stepTest(-1),
    commentTest: () => {
      const a = testLineAnchor(tour.hunks, testFile, testCodeLines[testCursor]);
      if (!a) return setFlash('This test line is outside the PR diff, so GitHub cannot attach a line comment.');
      openComposer(draft(a));
    },
    askTest: () => show('ask'),
    // A collapsed chapter's summary
    summaryDown: () => setSummarySel((s) => Math.min(summaryIds.length - 1, s + 1)),
    summaryUp: () => setSummarySel((s) => Math.max(0, s - 1)),
    expand: () => void (summaryIds[summarySel] ? props.setPos(ci, chapter.hunkIds.indexOf(summaryIds[summarySel])) : undefined),
    skipChapter: () => {
      const ids = chapter.hunkIds;
      props.setState(
        ids.map((id) => tour.hunks[id]).filter((h) => h && stateOf(states, h) === 'unread'),
        'skipped',
      );
      setFlash(`Skipped ${plural(ids.length, 'hunk')} in "${chapter.title}".`, 'info');
      next();
    },
    // Code
    next: () => {
      // The same change is in other unread hunks: ask whether to read them all now.
      if (!collapsedView && hunk && !oneByOne.current.has(sameChange(hunk))) {
        const others = copiesOf(hunk).filter((h) => h.id !== hunk.id && stateOf(states, h) === 'unread');
        if (others.length) return setAskCopies(others);
      }
      readAndNext();
    },
    prev: () => go(prevPos(chapters, ci, hi)),
    nextChapter: () => go(ci < chapters.length - 1 ? { ci: ci + 1, hi: firstHunk(chapters, ci + 1) } : undefined),
    prevChapter: () => go(ci > 0 ? { ci: ci - 1, hi: firstHunk(chapters, ci - 1) } : undefined),
    down: () => moveCursor(1),
    up: () => moveCursor(-1),
    pageDown: () => moveCursor(10),
    pageUp: () => moveCursor(-10),
    range: () => setAnchor((a) => (a === null ? cursor : null)),
    // Esc closes the innermost thing: an open range, else the chapter, back to the briefing.
    escape: () => (anchor !== null ? setAnchor(null) : banner ? setFolded(banner) : props.openBriefing()),
    skip: () => next('skipped'),
    defer: () => {
      setFlash('Deferred: it stays on the submit screen as unread work.', 'info');
      next('deferred');
    },
    unread: () => props.setState([hunk!], 'unread'),
    raw: () => setRaw((r) => !r),
    whitespace: toggleWhitespace,
    imports: () => setFoldImports((f) => !f),
    split: () => {
      if (!wantSplit && srcWidth < MIN_SPLIT_WIDTH) setFlash('Split view needs a wider terminal; showing it once there is room.');
      toggleSplit();
    },
    testPane: () => {
      if (!hasLinkedTests) return setFlash('No test exercises this hunk.');
      toggleTestPane();
    },
    moreContext: () => growContext(CONTEXT_STEP),
    lessContext: () => growContext(-CONTEXT_STEP),
    untested: () => setShowUntested((shown) => !shown),
    focusTests: () => (hasLinkedTests ? setTestFocus(true) : setFlash('No test exercises this hunk.')),
    comment: () => {
      // c on a line that holds your draft edits it.
      if (anchor === null && cursorDraft) return openComposer(cursorDraft);
      if (anchor === null && runs.has(cursor)) return setFlash('These imports are folded: press I to show them, then comment on one.');
      if (crossesContext(hunk!, sel)) return setFlash('This range crosses dimmed lines outside the PR’s diff: GitHub can’t take one comment across them. Select one side.');
      const a = lineAnchor(hunk!, sel);
      if (!a && anchorLines(hunk!, sel).length === 0) return setFlash('This is context outside the PR’s diff: GitHub can’t take a comment on it.');
      if (!a) return setFlash('Nothing to anchor a comment to here.');
      openComposer(draft(a));
    },
    reply: () => (cursorThreads.length ? show('reply') : setFlash('No review thread on this line. Move to a commented line and press y.')),
    thread: () => (cursorThreads.length ? show('thread') : setFlash('No review thread on this line. Move to a commented line and press e.')),
    palette: () => show('palette'),
    sidebar: () => (width >= WIDE ? toggleSidebar() : setFlash(`The chapter list needs ${WIDE} columns; this terminal has ${width}.`)),
    explanation: () => toggleExplanation(),
    commentFlow: () => openComposer(draft({ type: 'chapter', chapterId: chapter.id })),
    ask: () => {
      if (hunk && cursorLine?.newLine !== undefined) noteRecent.current?.({ path: hunk.file, line: cursorLine.newLine, why: 'ask' });
      if (collapsedView || hunk) show('ask');
      else setFlash('Nothing to ask about here.');
    },
    diagram: () => (keyCtx.diagram ? show('diagram') : setFlash('No diagram for this chapter.')),
    move: () => setOverlay({ kind: 'move', sel: ci }),
    order: () => props.toggleOrder(),
    delta: () => props.toggleDelta(),
    rebase: () => props.rebase?.(),
    openInAgent: () => props.openInAgent(hunk, chapter),
    submit: () => props.openSubmit(),
    help: () => show('help'),
    checklist: () => {
      if (!chapter?.checklist?.length) return setFlash('No team checklist applies to this chapter (.guided-review.json → checklists).');
      if (svc) show('checklist');
      else setFlash('The checklist opens once the checkout is ready.');
    },
    theme: () => props.onTheme?.(),
  };
  // The panes Tab moves between, in screen order: the chapter list, the explanation, the code, and
  // the tests, each only when it is on screen.
  const panes = [...(wide ? ['list' as const] : []), ...(plan.explainLines.length ? ['explain' as const] : []), 'code' as const, ...(hasLinkedTests && hunk ? ['tests' as const] : [])];
  // A focused pane that leaves the screen (a narrower terminal, \ hiding the list, a hunk with no
  // explanation) hands focus back to the code, so its keys never act on something unseen.
  if (paneFocus !== 'code' && !panes.includes(paneFocus)) setPaneFocus('code'); // React re-renders before committing
  const focusNow = testFocus ? 'tests' : paneFocus;
  const focusPane = (p: (typeof panes)[number]) => {
    setTestFocus(p === 'tests');
    setPaneFocus(p === 'tests' ? 'code' : p);
    if (p === 'list')
      setListSel(
        Math.max(
          0,
          listed.findIndex((c) => c.id === chapter?.id),
        ),
      );
  };
  useInput(
    (input, key) => {
      // A held message has been seen once a key is pressed.
      dismissFlash();
      if (key.tab) {
        const at = Math.max(0, panes.indexOf(focusNow));
        return focusPane(panes[(at + (key.shift ? panes.length - 1 : 1)) % panes.length]);
      }
      if (paneFocus === 'list' && !testFocus) {
        if (input === 'j' || key.downArrow) return setListSel((s) => Math.min(listed.length - 1, s + 1));
        if (input === 'k' || key.upArrow) return setListSel((s) => Math.max(0, s - 1));
        if (key.return) {
          const target = chapters.findIndex((c) => c.id === listed[listSel]?.id);
          focusPane('code');
          return target >= 0 ? props.setPos(target, firstHunk(chapters, target)) : setFlash('That chapter has no changes in this re-review.');
        }
        if (key.escape) return focusPane('code');
      }
      if (paneFocus === 'explain' && !testFocus) {
        if (input === 'j' || key.downArrow) return setExplainScroll((s) => Math.min(plan.explainMaxScroll, s + 1));
        if (input === 'k' || key.upArrow) return setExplainScroll((s) => Math.max(0, s - 1));
        if (input === 'J' || key.pageDown) return setExplainScroll((s) => Math.min(plan.explainMaxScroll, s + 5));
        if (input === 'K' || key.pageUp) return setExplainScroll((s) => Math.max(0, s - 5));
        if (key.return) return show('reader');
        if (key.escape) return focusPane('code');
      }
      const action = keyAction(keyView, keyCtx, input, key);
      if (action) return actions[action]();
      const none = unboundKey(input, key);
      if (none) setFlash(none, 'quiet');
    },
    { isActive: props.active !== false && overlay.kind === 'none' && !askCopies },
  );

  useInput(
    (input, key) => {
      if (overlay.kind === 'move') {
        if (key.escape) return close();
        const move = (by: number) => setOverlay((o) => (o.kind === 'move' ? { ...o, sel: Math.max(0, Math.min(chapters.length - 1, o.sel + by)) } : o));
        if (input === 'j' || key.downArrow) return move(1);
        if (input === 'k' || key.upArrow) return move(-1);
        if (key.return && hunk) {
          props.moveHunk(hunk, chapters[overlay.sel].id);
          setFlash(`Moved to "${chapters[overlay.sel].title}".`, 'info');
          return close();
        }
      }
    },
    { isActive: props.active !== false && overlay.kind === 'move' },
  );

  if (!chapter) {
    if (overlay.kind !== 'none') close(); // see slots.shown below
    return <EmptyChapter deltaOnly={props.deltaOnly} width={width} />;
  }

  // Linked tests that are not beside the code (a narrow terminal, T, or a split diff) get a tab
  // saying they are there and how to open them.
  const testDrawer =
    hunk && hasLinkedTests && !sideBySide && !testFocus && !collapsedView ? `◂ ${hunk.covers ? 'code it covers' : `${relevantTests.length} test${relevantTests.length === 1 ? '' : 's'}`}` : undefined;
  // The composer sits under the commented line, growing while its AI line is open. Its state is
  // ours, so it survives moving between the inline slot and the popup.
  const slots = overlaySlots(plan, {
    overlay: overlay.kind,
    testFocus,
    threadsHere: cursorThreads.length > 0,
    commentOpen: overlay.kind === 'comment',
    lineComment: overlay.kind === 'comment' && isLineAnchor(overlay.composer.anchor),
    checklist: !!chapter.checklist && !!svc,
  });
  // An open overlay owns the keyboard through its own useInput. One with nowhere to show would
  // leave no handler active, so close it.
  if (overlay.kind !== 'none' && !slots.shown) close(); // React re-renders before committing

  // A lockfile pair's package list sits under the diff, unless a comment, thread or question
  // open under a line needs the room.
  const lockShown = lockList && plan.lockHeight > 0 && !slots.sourceInline ? lockList : undefined;

  // The palette: this view's commands, then every chapter and every changed file to go to.
  const paletteItems = (): PaletteItem[] => {
    const commands = paletteCommands(keyView, keyCtx).map((c) => ({ label: c.label, key: c.key, run: () => actions[c.action]() }));
    const toChapter = chapters.map((c, i) => ({ label: `Go to chapter ${i + 1}: ${c.title}`, detail: plural(c.hunkIds.length, 'hunk'), run: () => props.setPos(i, firstHunk(chapters, i)) }));
    const toFile: PaletteItem[] = [];
    for (const f of tour.files) {
      const ci = chapters.findIndex((c) => c.hunkIds.some((id) => tour.hunks[id]?.file === f.path));
      if (ci < 0) continue;
      const c = chapters[ci];
      const hi = c.hunkIds.findIndex((id) => tour.hunks[id]?.file === f.path);
      // A collapsed chapter, or a folded lockfile hunk, is read as its summary; a paired lockfile, on its manifest's page.
      const page = pageOf(c, hi);
      toFile.push({ label: `Go to ${f.path}`, detail: `chapter ${ci + 1} · ${page < 0 ? 'summary' : `hunk ${hunkPosition(c, page).n}`}`, run: () => props.setPos(ci, page) });
    }
    return [...commands, ...toChapter, ...toFile];
  };

  // The diagram, the move list, the checklist, and a chapter or node comment float over the
  // screen, which stays in view around them: the diagram's job is to orient you in that code.
  const floating = (() => {
    if (slots.popup === 'diagram') {
      const g = chapter.diagram ?? tour.overview!;
      return {
        tone: 'reading' as const,
        width: Math.max(40, Math.floor(width * 0.85)),
        height: Math.max(10, Math.floor(height * 0.8)),
        node: (w: number, h: number) => (
          <DiagramView
            graph={g}
            width={w}
            height={h}
            onClose={() => close()}
            onJump={(hid) => {
              const c = chapters.findIndex((ch) => ch.hunkIds.includes(hid));
              if (c >= 0) props.setPos(c, chapters[c].hunkIds.indexOf(hid));
              close();
            }}
            onComment={(nodeId) => openComposer(draft({ type: 'node', chapterId: chapter.id, nodeId }))}
          />
        ),
      };
    }
    if (slots.popup === 'comment' && overlay.kind === 'comment')
      return { tone: 'input' as const, width: Math.min(96, width - 4), height: overlay.composer.ai ? Math.min(30, height - 4) : 18, node: (w: number, h: number) => commentEditor(w, h) };
    if (overlay.kind === 'reader')
      return {
        tone: 'reading' as const,
        width: Math.min(110, width - 4),
        height: height - 4,
        node: (w: number, h: number) => <Reader title={`${chapter.title}${hunk ? ` · ${hunk.file}` : ''}`} lines={plan.explainAll} width={w} height={h} onClose={close} />,
      };
    if (askCopies && hunk) {
      const changed = hunk.lines.filter((l) => l.kind !== 'ctx');
      const files = [...new Set([hunk.file, ...copiesOf(hunk).map((h) => h.file)])];
      const answer = (fn: () => void) => () => {
        setAskCopies(undefined);
        fn();
      };
      return {
        tone: 'decision' as const,
        width: Math.min(72, width - 4),
        height: copiesCardHeight(changed.length, files.length),
        node: (w: number) => (
          <CopiesCard
            files={files}
            changed={changed}
            unread={askCopies.length}
            total={copiesOf(hunk).length}
            width={w}
            onAll={answer(() => readCopies(askCopies))}
            onOne={answer(() => {
              oneByOne.current.add(sameChange(hunk));
              readAndNext();
            })}
            onClose={() => setAskCopies(undefined)}
          />
        ),
      };
    }
    if (overlay.kind === 'end') {
      const p = progress(tour, hunk ? { ...states, ...Object.fromEntries(hunkKeys(hunk).map((k) => [k, stateOf(states, hunk) === 'unread' ? 'read' : stateOf(states, hunk)])) } : states);
      const verdict = suggestVerdict(tour, props.drafts, states, labels);
      const pending = props.drafts.filter((d) => !d.posted).length;
      const optional = chapters.some((c) => c.optional);
      return {
        tone: 'decision' as const,
        width: Math.min(72, width - 4),
        height: 9 + Math.min(3, verdict.reasons.length) + (optional ? 1 : 0),
        node: () => (
          <EndCard
            read={p.read}
            skipped={p.skipped}
            deferred={p.deferred}
            unread={p.unread}
            drafts={pending}
            verdict={EVENT_TEXT[verdict.event]}
            reasons={verdict.reasons.slice(0, 3)}
            optional={optional}
            onSubmit={() => {
              close();
              props.openSubmit();
            }}
            onOptional={() => {
              close();
              const oi = chapters.findIndex((c) => c.optional);
              if (oi >= 0) props.setPos(oi, firstHunk(chapters, oi));
            }}
            onClose={close}
            onQuit={props.quit}
          />
        ),
      };
    }
    if (overlay.kind === 'palette')
      return {
        tone: 'input' as const,
        width: Math.min(90, width - 4),
        height: Math.min(height - 4, 22),
        node: (w: number, h: number) => <CommandPalette items={paletteItems()} width={w} height={h} onClose={close} />,
      };
    if (overlay.kind === 'move')
      return { tone: 'input' as const, width: Math.min(70, width - 4), height: chapters.length + 5, node: (w: number) => <MoveList chapters={chapters} sel={overlay.sel} width={w} /> };
    if (slots.popup === 'checklist' && chapter.checklist && svc) {
      const items = chapter.checklist;
      return {
        tone: 'input' as const,
        width: Math.min(110, width - 4),
        height: items.length * 2 + 4,
        node: (w: number) => <ChecklistPanel items={items} confirms={svc.confirms} width={w} onToggle={svc.setConfirm} onClose={() => close()} />,
      };
    }
    return undefined;
  })();

  // The inline composer under a source or test line, `w` wide in a `pane` rows tall.
  const inlineComposer = (w: number, pane: number) => {
    const slot = inlineComposerSlot(overlay.kind === 'comment' ? overlay.composer : undefined, tour, pane, w);
    return { node: commentEditor(w, INLINE_ROWS, slot.aiRows, slot.listRows), height: slot.height };
  };

  function commentEditor(w: number, h: number, aiRows?: number, listRows?: number) {
    if (overlay.kind !== 'comment') return null;
    const { draft: pending, composer } = overlay;
    const a = composer.anchor;
    return (
      <CommentEditor
        draft={pending}
        target={safe(describeAnchor(a, chapters, chapter))}
        hunk={isLineAnchor(a) ? tour.hunks[a.hunkId] : hunk}
        selectedText={sameAnchor(a, pending.anchor) ? (testFocus ? testCodeLines[testCursor]?.text : hunk ? selectedCode(hunk, sel) : undefined) : undefined}
        width={w}
        height={h}
        mentions={mentions}
        env={composerEnv}
        state={composer}
        setState={setComposerState}
        aiRows={aiRows}
        listRows={listRows}
        onCancel={() => close()}
        onSave={saveDraft}
        onDelete={
          props.drafts.some((d) => d.id === pending.id)
            ? () => {
                props.deleteDraft(pending);
                close();
                setFlash(`Draft deleted${labels ? ` (${pending.label})` : ''}.`, 'info');
              }
            : undefined
        }
      />
    );
  }

  const askTestLine = testCodeLines[testCursor];
  const askContext = testFocus && hunk && testFile ? { ...hunk, file: testFile, header: selectedTest?.diffHunks?.[0]?.header ?? hunk.header, lines: testCodeLines } : hunk;
  const askPanelAt = (w: number, h: number) =>
    overlay.kind === 'ask' ? (
      <AskOverlay
        hunk={askContext}
        lineIdx={testFocus ? testCursor : hunk ? sel[0] : undefined}
        endIdx={testFocus ? testCursor : hunk ? sel[1] : undefined}
        target={
          testFocus && testFile
            ? `${testFile}:${askTestLine?.newLine ?? askTestLine?.oldLine ?? ''}`
            : hunk
              ? `${hunk.file}:${hunk.lines[sel[0]]?.newLine ?? hunk.lines[sel[0]]?.oldLine ?? ''}`
              : `chapter "${chapter.title}"`
        }
        agent={props.agent}
        aiOff={props.aiOff}
        width={w}
        height={h}
        onClose={() => close()}
      />
    ) : null;
  const askPanel = askPanelAt(plan.askWidth, askHeight);
  const threadAt = (w: number, h: number) => (
    <ThreadView
      threads={cursorThreads}
      width={w}
      height={h}
      mentions={mentions}
      startReply={overlay.kind === 'reply'}
      onReply={props.replyToThread}
      onReact={props.reactToComment}
      onNotice={(text) => setFlash(text, 'info')}
      onClose={() => close()}
    />
  );

  const testPane =
    plan.testPaneShown && hunk ? (
      <TestPane
        tests={relevantTests}
        covers={hunk.covers}
        idx={testIdx}
        cursor={testCursor}
        scroll={testScroll}
        setScroll={setTestScroll}
        focused={testFocus}
        inline={slots.testInline === 'comment' ? inlineComposer(plan.testPane.inlineWidth, plan.testPane.height) : slots.testInline === 'ask' ? { node: askPanel, height: askHeight } : undefined}
        width={plan.testPane.width}
        height={plan.testPane.height}
      />
    ) : null;

  const screen = (
    <Box flexDirection="column" width={width} height={height}>
      <Header
        tour={tour}
        prog={prog}
        order={props.order}
        deltaOnly={props.deltaOnly}
        width={width}
        busy={props.busy}
        pushed={!!props.banner && !banner}
        where={`chapter ${ci + 1}/${chapters.length}${hunk ? ` · hunk ${at?.n}/${at?.total}` : ''}`}
      />
      {banner ? (
        <Text backgroundColor="yellow" color="black">
          {pad(` ${banner} · esc hides this`, width)}
        </Text>
      ) : null}
      {!wide ? <ChapterStrip tour={tour} chapters={chapters} ci={ci} hi={hunk ? hi : -1} order={props.order} width={width} /> : null}
      <Box flexDirection="row">
        {wide ? (
          <ChapterList
            tour={tour}
            chapters={chapters}
            listed={listed}
            states={states}
            current={chapter.id}
            focusedRow={focusNow === 'list' ? listSel : undefined}
            width={listWidth}
            height={plan.mainHeight}
          />
        ) : null}
        {wide ? <Box width={1} /> : null}
        <Box flexDirection="column" width={mainWidth}>
          <>
            <ChapterTitle chapter={chapter} hunk={hunk} hi={hi} isNew={!!hunk && delta.has(hunk.id)} unchanged={unchangedHunks} width={mainWidth} states={states} drawer={testDrawer} />
            <Explanation lines={plan.explainLines} inferred={!!hunk?.narrationInferred} collapsed={collapsedView} updated={updated} focused={focusNow === 'explain'} width={mainWidth} />
            {collapsedView ? (
              <>
                <CollapsedSummary
                  hunks={tour.hunks}
                  files={filesByPath}
                  ids={summaryIds}
                  states={states}
                  sel={summarySel}
                  width={mainWidth}
                  height={bodyHeight - (slots.collapsedAsk ? askHeight : 0)}
                />
                {slots.collapsedAsk ? askPanel : null}
              </>
            ) : hunk ? (
              <Box flexDirection={sideBySide ? 'row' : 'column'}>
                {plan.sourcePaneShown ? (
                  <Box flexDirection="column" flexShrink={0} width={srcWidth}>
                    <SourcePane
                      inline={
                        slots.sourceInline === 'thread'
                          ? { afterIdx: cursor, node: threadAt(srcWidth - 1, plan.threadHeight), height: plan.threadHeight }
                          : slots.sourceInline === 'comment'
                            ? { afterIdx: sel[1], ...inlineComposer(srcWidth - 1, bodyHeight) }
                            : slots.sourceInline === 'ask'
                              ? { afterIdx: sel[1], node: askPanel, height: askHeight }
                              : undefined
                      }
                      hunk={hunk}
                      cursor={cursor}
                      range={anchor !== null ? sel : null}
                      raw={raw}
                      split={splitView}
                      partner={partner}
                      hidden={hidden}
                      runs={runs}
                      ignoreWhitespace={ignoreWhitespace}
                      scroll={scroll}
                      setScroll={setScroll}
                      threads={tour.existingThreads}
                      copies={hunkCopies}
                      drafts={props.drafts}
                      root={svc?.root}
                      headSha={tour.headSha}
                      baseSha={tour.baseSha}
                      width={srcWidth}
                      height={lockShown ? plan.sourceHeight : bodyHeight}
                    />
                    {lockShown ? <LockfileChanges lines={lockListLines(lockShown, srcWidth - 1, plan.lockHeight)} width={srcWidth} height={plan.lockHeight} /> : null}
                  </Box>
                ) : null}
                {sideBySide ? <Box width={1} /> : null}
                {sideBySide ? (
                  <Box
                    flexDirection="column"
                    width={plan.testWidth}
                    flexShrink={0}
                    height={bodyHeight}
                    borderStyle="single"
                    borderTop={false}
                    borderBottom={false}
                    borderRight={false}
                    borderColor="gray"
                    paddingLeft={1}
                  >
                    {slots.side === 'thread' ? (
                      threadAt(plan.testWidth - 2, bodyHeight)
                    ) : slots.side === 'ask' ? (
                      askPanelAt(plan.testWidth - 2, bodyHeight)
                    ) : (
                      <>
                        <Text bold dimColor={!testFocus} color={testFocus ? 'cyan' : undefined}>
                          Tests
                        </Text>
                        {testPane}
                      </>
                    )}
                  </Box>
                ) : (
                  testPane
                )}
              </Box>
            ) : (
              <Text dimColor>This chapter has no hunks.</Text>
            )}
          </>
        </Box>
      </Box>
      <StatusRow
        drafts={props.drafts}
        hunk={hunk}
        cursor={cursor}
        flash={flash}
        range={anchor !== null && hunk ? rangeLabel(hunk, sel) : undefined}
        position={hunk ? `hunk ${at?.n}/${at?.total} · line ${cursorLine?.newLine ?? cursorLine?.oldLine ?? ''}` : undefined}
        width={width}
      />
      <KeyBar
        width={width}
        status={overlay.kind === 'none' && hunk && !testFocus ? [raw && 'raw', splitView && 'split', ignoreWhitespace && 'whitespace hidden'].filter(Boolean).join(' · ') : undefined}
        end={overlay.kind !== 'none' ? [] : [...(panes.length > 1 ? [['tab', 'pane'] as Hint] : []), ...barEnd(keyView, keyCtx)]}
        extraEnd={overlay.kind !== 'none' ? [] : [PALETTE_HINT]}
        keys={
          overlay.kind !== 'none'
            ? []
            : focusNow === 'list'
              ? [
                  ['j/k', 'choose'],
                  ['enter', 'open chapter'],
                ]
              : focusNow === 'explain'
                ? [
                    ['j/k', 'scroll'],
                    ['enter', 'read it all'],
                  ]
                : barKeys(keyView, keyCtx)
        }
      />
    </Box>
  );
  if (floating && props.active !== false)
    return (
      <ReviewPopup background={screen} width={width} height={height} maxWidth={floating.width} maxHeight={floating.height} tone={floating.tone}>
        {floating.node}
      </ReviewPopup>
    );
  // Help floats over the screen, which stays visible around it.
  if (overlay.kind === 'help' && props.active !== false)
    return <HelpPopup background={screen} width={width} height={height} title="chapter" sections={chapterHelp(!!props.agent)} legend={reviewLegend()} onClose={close} />;
  return screen;
}
