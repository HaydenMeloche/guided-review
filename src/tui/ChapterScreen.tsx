import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useInput } from 'ink';
import { Box, Text } from './themed.js';
import { Confirm } from './Confirm.js';
import type { Chapter, ChapterOrder, Draft, DraftAnchor, ExistingThread, Hunk, ReactionContent, ReadState, ThreadComment, Tour } from '../types.js';
import { ChecklistPanel } from './Panels.js';
import { firstHunk, nextPos, pad, prevPos, progress, stateOf, truncate, type States } from './nav.js';
import { DiagramView } from './DiagramView.js';
import { CommentEditor, type SetComposer } from './CommentEditor.js';
import { INLINE_ROWS, inlineComposerSlot } from './AiSuggestion.js';
import { ThreadView } from './ThreadView.js';
import { AskOverlay } from './AskOverlay.js';
import { MIN_SPLIT_WIDTH } from './paneWidths.js';
import type { AgentContext } from '../agent/types.js';
import { KeyBar } from './KeyBar.js';
import { initComposer, isLineAnchor, sameAnchor, type ComposerEnv, type ComposerState, type ReferenceServices } from './composer.js';
import { generateSuggestion } from '../agent/suggest.js';
import { clean, safe } from './chapter/text.js';
import { cursorNotes } from './chapter/lineNotes.js';
import { useMentions } from './chapter/mentions.js';
import { linkedTests } from './chapter/linkedTests.js';
import { SourcePane } from './chapter/SourcePane.js';
import { TestPane } from './chapter/TestPane.js';
import { ChapterList, ChapterStrip, ChapterTitle, CollapsedSummary, DraftLine, EmptyChapter, Explanation, Header, MoveList } from './chapter/parts.js';
import { HelpPopup } from './Help.js';
import { ReviewPopup } from './ReviewPopup.js';
import { reviewLegend } from './legend.js';
import { anchorLines, crossesContext, describeAnchor, lineAnchor, newDraft, selectedCode, selRange, testLineAnchor } from './chapter/selection.js';
import { CONTEXT_STEP, useFoldedCursor, useFolds, useHunkView } from './chapter/hunkView.js';
import { barEnd, barKeys, chapterHelp, keyAction, paletteCommands, type Action, type KeyCtx, type View } from './chapter/keys.js';
import { CommandPalette, type PaletteItem } from './CommandPalette.js';
import { explanation } from './chapter/guide.js';
import { useFlash } from './flash.js';
import { plural } from './plural.js';
import { chapterLayout, overlaySlots, type OverlayKind } from './chapter/layout.js';

export { KeyBar };

// For one release: ? used to ask the model.
export const HELP_NOTE = '? is now these keys · ask the model with a';

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
  setState: (h: Hunk, s: ReadState) => void;
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
  const [showUntested, setShowUntested] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(NONE);
  const close = () => setOverlay(NONE);
  const show = (kind: Exclude<OverlayKind, 'none' | 'comment' | 'move'>) => setOverlay({ kind });
  const [summarySel, setSummarySel] = useState(0);
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
  const collapsedView = !!chapter && chapter.collapsed && hi < 0;
  const filesByPath = useMemo(() => new Map(tour.files.map((f) => [f.path, f])), [tour.files]);
  const plan = chapterLayout({
    width,
    height,
    banner: !!banner,
    hunkLines: hunk?.lines,
    testLines: testCodeLines,
    linkedTests: hasLinkedTests,
    collapsedHunks: collapsedView ? chapter.hunkIds.length : undefined,
    testFocus,
    split: wantSplit,
    hideTests,
    raw,
    listOpen: overlay.kind === 'comment' && !!overlay.composer.listOpen,
    explain: (w) => (chapter ? explanation({ tour, chapter, hunk, hi, collapsed: collapsedView, files: filesByPath, confirms: svc?.confirms, linkedTests: hasLinkedTests, showUntested }, w) : []),
  });
  const { wide, listWidth, mainWidth, sideBySide, srcWidth, splitView, bodyHeight, askHeight } = plan;

  const { partner, hidden } = useFolds(hunk, ignoreWhitespace, splitView);
  const moveCursor = useFoldedCursor(view, hidden, partner);
  const cursorLine = hunk?.lines[cursor];
  const { threads: cursorThreads, draft: cursorDraft } = cursorNotes(hunk, cursor, hidden, partner, tour.existingThreads, props.drafts);
  useEffect(() => {
    setSummarySel(0);
    setShowUntested(false);
  }, [chapter?.id]);

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
  const next = (mark?: ReadState) => {
    if (hunk && mark) props.setState(hunk, mark);
    if (!chapter) return;
    const to = nextPos(chapters, ci, hi);
    if (to) return go(to);
    const optional = chapters.some((c) => c.optional);
    setFlash(`End of the tour.${optional ? ' Import-only changes are optional (] to open them).' : ''} Press s to review your drafts and submit.`);
  };

  const sel = selRange(cursor, anchor);
  const draft = (a: DraftAnchor) => newDraft(tour, a);

  const saveDraft = (d: Draft) => {
    const edited = props.drafts.some((x) => x.id === d.id);
    props.saveDraft(d);
    setAnchor(null);
    close();
    setFlash(`Draft ${edited ? 'updated' : 'saved'} (${d.label}). Nothing posts until you submit.`, 'info');
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
    summaryDown: () => setSummarySel((s) => Math.min(chapter.hunkIds.length - 1, s + 1)),
    summaryUp: () => setSummarySel((s) => Math.max(0, s - 1)),
    expand: () => void (chapter.hunkIds.length ? props.setPos(ci, summarySel) : undefined),
    skipChapter: () => {
      const ids = chapter.hunkIds;
      for (const id of ids) if (stateOf(states, tour.hunks[id]) === 'unread') props.setState(tour.hunks[id], 'skipped');
      setFlash(`Skipped ${plural(ids.length, 'hunk')} in "${chapter.title}".`, 'info');
      next();
    },
    // Code
    next: () => next(collapsedView ? undefined : 'read'),
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
    unread: () => props.setState(hunk!, 'unread'),
    raw: () => setRaw((r) => !r),
    whitespace: toggleWhitespace,
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
      if (crossesContext(hunk!, sel)) return setFlash('This range crosses dimmed lines outside the PR’s diff: GitHub can’t take one comment across them. Select one side.');
      const a = lineAnchor(hunk!, sel);
      if (!a && anchorLines(hunk!, sel).length === 0) return setFlash('This is context outside the PR’s diff: GitHub can’t take a comment on it.');
      if (!a) return setFlash('Nothing to anchor a comment to here.');
      openComposer(draft(a));
    },
    reply: () => (cursorThreads.length ? show('reply') : setFlash('No review thread on this line. Move to a commented line and press y.')),
    thread: () => (cursorThreads.length ? show('thread') : setFlash('No review thread on this line. Move to a commented line and press e.')),
    // E and X, for one release: they still work, and say where they moved.
    editDraft: () => {
      if (!cursorDraft) return setFlash('No draft on this line. Move to a line with ✎ and press c.');
      openComposer(cursorDraft);
      setFlash('E is going away: c on a line with your draft edits it.', 'info');
    },
    deleteDraft: () => {
      if (!cursorDraft) return setFlash('No draft on this line. Move to a line with ✎ and press c.');
      show('delete');
      setFlash('X is going away: ctrl+x in the comment deletes your draft.', 'info');
    },
    palette: () => show('palette'),
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
  useInput(
    (input, key) => {
      // A held message has been seen once a key is pressed.
      dismissFlash();
      const action = keyAction(keyView, keyCtx, input, key);
      if (action) actions[action]();
    },
    { isActive: props.active !== false && overlay.kind === 'none' },
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

  useInput(
    (input, key) => {
      if ((input === 'y' || key.return) && cursorDraft) {
        props.deleteDraft(cursorDraft);
        setFlash(`Draft deleted (${cursorDraft.label}).`, 'info');
      }
      close();
    },
    { isActive: props.active !== false && overlay.kind === 'delete' },
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
    draftHere: !!cursorDraft,
    commentOpen: overlay.kind === 'comment',
    lineComment: overlay.kind === 'comment' && isLineAnchor(overlay.composer.anchor),
    checklist: !!chapter.checklist && !!svc,
  });
  // An open overlay owns the keyboard through its own useInput. One with nowhere to show would
  // leave no handler active, so close it.
  if (overlay.kind !== 'none' && !slots.shown) close(); // React re-renders before committing

  // The palette: this view's commands, then every chapter and every changed file to go to.
  const paletteItems = (): PaletteItem[] => {
    const commands = paletteCommands(keyView, keyCtx).map((c) => ({ label: c.label, key: c.key, run: () => actions[c.action]() }));
    const toChapter = chapters.map((c, i) => ({ label: `Go to chapter ${i + 1}: ${c.title}`, detail: plural(c.hunkIds.length, 'hunk'), run: () => props.setPos(i, firstHunk(chapters, i)) }));
    const toFile: PaletteItem[] = [];
    for (const f of tour.files) {
      const ci = chapters.findIndex((c) => c.hunkIds.some((id) => tour.hunks[id]?.file === f.path));
      if (ci < 0) continue;
      const hi = chapters[ci].hunkIds.findIndex((id) => tour.hunks[id]?.file === f.path);
      toFile.push({ label: `Go to ${f.path}`, detail: `chapter ${ci + 1} · hunk ${hi + 1}`, run: () => props.setPos(ci, chapters[ci].collapsed ? -1 : hi) });
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
                setFlash(`Draft deleted (${pending.label}).`, 'info');
              }
            : undefined
        }
      />
    );
  }

  const askTestLine = testCodeLines[testCursor];
  const askContext = testFocus && hunk && testFile ? { ...hunk, file: testFile, header: selectedTest?.diffHunks?.[0]?.header ?? hunk.header, lines: testCodeLines } : hunk;
  const askPanel =
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
        width={plan.askWidth}
        height={askHeight}
        onClose={() => close()}
      />
    ) : null;

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
      <Header tour={tour} prog={prog} order={props.order} deltaOnly={props.deltaOnly} width={width} busy={props.busy} pushed={!!props.banner && !banner} />
      {banner ? (
        <Text backgroundColor="yellow" color="black">
          {pad(` ${banner} · esc hides this`, width)}
        </Text>
      ) : null}
      {!wide ? <ChapterStrip tour={tour} chapters={chapters} listed={listed} states={states} current={chapter.id} order={props.order} ci={ci} width={width} /> : null}
      <Box flexDirection="row">
        {wide ? <ChapterList tour={tour} chapters={chapters} listed={listed} states={states} current={chapter.id} width={listWidth} height={plan.mainHeight} /> : null}
        {wide ? <Box width={1} /> : null}
        <Box flexDirection="column" width={mainWidth}>
          <>
            <ChapterTitle chapter={chapter} hunk={hunk} hi={hi} isNew={!!hunk && delta.has(hunk.id)} unchanged={unchangedHunks} width={mainWidth} states={states} drawer={testDrawer} />
            <Explanation lines={plan.explainLines} inferred={!!hunk?.narrationInferred} collapsed={collapsedView} updated={updated} width={mainWidth} />
            {collapsedView ? (
              <>
                <CollapsedSummary
                  hunks={tour.hunks}
                  files={filesByPath}
                  chapter={chapter}
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
                  <SourcePane
                    inline={
                      slots.sourceInline === 'thread'
                        ? {
                            afterIdx: cursor,
                            node: (
                              <ThreadView
                                threads={cursorThreads}
                                width={srcWidth - 1}
                                height={plan.threadHeight}
                                mentions={mentions}
                                startReply={overlay.kind === 'reply'}
                                onReply={props.replyToThread}
                                onReact={props.reactToComment}
                                onNotice={(text) => setFlash(text, 'info')}
                                onClose={() => close()}
                              />
                            ),
                            height: plan.threadHeight,
                          }
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
                    ignoreWhitespace={ignoreWhitespace}
                    scroll={scroll}
                    setScroll={setScroll}
                    threads={tour.existingThreads}
                    drafts={props.drafts}
                    root={svc?.root}
                    headSha={tour.headSha}
                    baseSha={tour.baseSha}
                    width={srcWidth}
                    height={bodyHeight}
                  />
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
                    <Text bold dimColor>
                      Tests
                    </Text>
                    {testPane}
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
      {slots.confirmDelete && cursorDraft ? (
        <Confirm yes="delete">{truncate(`Delete this draft? [${cursorDraft.label}] ${clean(cursorDraft.body).replace(/\s+/g, ' ')}`, width - 26)}</Confirm>
      ) : (
        <DraftLine drafts={props.drafts} hunk={hunk} cursor={cursor} flash={flash} width={width} />
      )}
      <KeyBar
        width={width}
        status={overlay.kind === 'none' && hunk && !testFocus ? [raw && 'raw', splitView && 'split', ignoreWhitespace && 'whitespace hidden'].filter(Boolean).join(' · ') : undefined}
        end={overlay.kind !== 'none' ? [] : barEnd(keyView, keyCtx)}
        keys={overlay.kind !== 'none' ? [] : barKeys(keyView, keyCtx)}
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
    return <HelpPopup background={screen} width={width} height={height} title="chapter" sections={chapterHelp(!!props.agent)} legend={reviewLegend()} note={HELP_NOTE} onClose={close} />;
  return screen;
}
