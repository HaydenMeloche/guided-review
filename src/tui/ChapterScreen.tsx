import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useInput } from 'ink';
import { Box, Text } from './themed.js';
import type { Chapter, ChapterOrder, DiffLine, Draft, DraftAnchor, ExistingThread, Hunk, ReactionContent, ReadState, ThreadComment, Tour } from '../types.js';
import { MdLineView } from './markdown.js';
import { ChecklistPanel } from './Panels.js';
import { chapterState, ORDER_LABEL, pad, progress, stateMark, stateOf, truncate, type States } from './nav.js';
import { DiagramView } from './DiagramView.js';
import { CommentEditor, type SetComposer } from './CommentEditor.js';
import { INLINE_ROWS, inlineComposerSlot } from './AiSuggestion.js';
import { ThreadView } from './ThreadView.js';
import { AskOverlay } from './AskOverlay.js';
import { MIN_SPLIT_WIDTH } from './paneWidths.js';
import { ReviewPopup } from './ReviewPopup.js';
import type { AgentContext } from '../agent/types.js';
import { foldedLines, pairChangedLines, type Fold } from '../diff/lines.js';
import { KeyBar } from './KeyBar.js';
import { initComposer, isLineAnchor, sameAnchor, type ComposerEnv, type ComposerState, type ReferenceServices } from './composer.js';
import { generateSuggestion } from '../agent/suggest.js';
import { clean, safe } from './chapter/text.js';
import { draftsAt, threadAt } from './chapter/lineNotes.js';
import { SourcePane } from './chapter/SourcePane.js';
import { TestPane } from './chapter/TestPane.js';
import { ChapterList, ChapterTitle, CollapsedSummary, DraftLine, Header } from './chapter/parts.js';
import { Help, HELP_HEIGHT, HELP_WIDTH } from './chapter/Help.js';
import { anchorLines, crossesContext, describeAnchor, lineAnchor, newDraft, selectedCode, selRange, testLineAnchor } from './chapter/selection.js';
import { CONTEXT_STEP, useFoldedCursor, useHunkView } from './chapter/hunkView.js';
import { barKeys, keyAction, type Action, type KeyCtx, type View } from './chapter/keys.js';
import { explanation } from './chapter/guide.js';
import { chapterLayout, overlaySlots, type OverlayKind } from './chapter/layout.js';

export { KeyBar };

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
  banner?: string;
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
  back?: () => void; // q: back to the PR list; unset, q quits
  quit: () => void;
}) {
  const { tour, chapters, states, ci, hi, width, height } = props;
  const chapter = chapters[ci];
  const diffHunk: Hunk | undefined = chapter && hi >= 0 ? tour.hunks[chapter.hunkIds[hi]] : undefined;
  const svc = props.services;
  const [flash, setFlash] = useState('');
  const view = useHunkView(diffHunk, tour, svc?.root, setFlash);
  const { hunk, cursor, anchor, setAnchor, scroll, setScroll, raw, setRaw, testFocus, setTestFocus, testIdx, setTestIdx, testCursor, setTestCursor, testScroll, setTestScroll, growContext } = view;
  const [ownHideWhitespace, setOwnHideWhitespace] = useState(true);
  const ignoreWhitespace = props.hideWhitespace ?? ownHideWhitespace;
  const [showUntested, setShowUntested] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(NONE);
  const close = () => setOverlay(NONE);
  const show = (kind: Exclude<OverlayKind, 'none' | 'comment' | 'move'>) => setOverlay({ kind });
  const [summarySel, setSummarySel] = useState(0);
  const [ownSplit, setOwnSplit] = useState(false);
  const wantSplit = props.splitDiff ?? ownSplit;
  const [ownHideTests, setOwnHideTests] = useState(false);
  const hideTests = props.hideTestPane ?? ownHideTests;
  const ev = props.references;
  // The open composer's working state (see composer.ts).
  const setComposerState: SetComposer = (f) => setOverlay((o) => (o.kind === 'comment' ? { ...o, composer: f(o.composer) } : o));
  // The pipeline fills tour.mentionUsers only if the collaborator list arrived in time; fetch it
  // (memoized in gh.ts) the first time an editor that offers @mentions opens.
  const [lateMentions, setLateMentions] = useState<string[]>();
  const wantsMentions = overlay.kind === 'comment' || overlay.kind === 'reply' || overlay.kind === 'thread';
  useEffect(() => {
    const load = svc?.loadMentionUsers;
    if (!wantsMentions || !load || tour.mentionUsers !== undefined || lateMentions !== undefined) return;
    let live = true;
    load().then(
      (users) => void (live && setLateMentions(users)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [wantsMentions, svc?.loadMentionUsers, tour.mentionUsers, lateMentions]);
  const mentionUsers = tour.mentionUsers ?? lateMentions;
  const mentions = useMemo(
    () =>
      [...new Set([tour.author, ...(tour.existingReviews ?? []).map((r) => r.author), ...tour.existingThreads.flatMap((t) => t.comments.map((c) => c.author)), ...(mentionUsers ?? [])])].filter(
        (name) => name !== 'ghost',
      ),
    [tour.author, tour.existingReviews, tour.existingThreads, mentionUsers],
  );
  const relevantTests = useMemo(() => hunk?.tests.filter((t) => t.source !== 'naming') ?? [], [hunk]);
  const selectedTest = relevantTests[testIdx];
  const testFile = hunk?.covers?.file ?? selectedTest?.testFile;
  const testCodeLines: DiffLine[] = useMemo(
    () =>
      hunk?.covers
        ? hunk.covers.lines.map((text, i) => ({ kind: 'ctx', text, newLine: hunk.covers!.startLine + i }))
        : selectedTest?.diffHunks?.length
          ? selectedTest.diffHunks.flatMap((diff) => diff.lines)
          : (selectedTest?.lines.map((text, i) => ({ kind: 'ctx', text, newLine: selectedTest.startLine + i })) ?? []),
    [hunk, selectedTest],
  );

  const hasLinkedTests = !!hunk && (relevantTests.length > 0 || !!hunk.covers);
  const collapsedView = !!chapter && chapter.collapsed && hi < 0;
  const filesByPath = useMemo(() => new Map(tour.files.map((f) => [f.path, f])), [tour.files]);
  const plan = chapterLayout({
    width,
    height,
    banner: !!props.banner,
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

  const partner = useMemo(() => (hunk ? pairChangedLines(hunk.lines) : []), [hunk]);
  // Removed lines folded into the line replacing them; the cursor steps over them.
  // Split, every removed line with a replacement sits beside it, on the replacement's row.
  const hidden = useMemo(() => {
    const folds = hunk ? foldedLines(hunk.lines, partner, ignoreWhitespace) : new Map<number, Fold>();
    if (splitView && hunk) for (const [i, p] of partner.entries()) if (p >= 0 && hunk.lines[i].kind === 'del' && !folds.has(i)) folds.set(i, 'beside');
    return folds;
  }, [hunk, partner, ignoreWhitespace, splitView]);
  const moveCursor = useFoldedCursor(view, hidden, partner);
  const cursorLine = hunk?.lines[cursor];
  const threadsOn = (l: DiffLine | undefined) => (hunk && l ? threadAt(tour.existingThreads, hunk.file, l.kind === 'del' ? l.oldLine : l.newLine, l.kind === 'del' ? 'LEFT' : 'RIGHT') : []);
  // Split, a removed line's threads are on the row it shares with its replacement.
  const cursorThreads = [...threadsOn(cursorLine), ...(hidden.get(partner[cursor]) === 'beside' ? threadsOn(hunk?.lines[partner[cursor]]) : [])];
  // Unposted drafts on the selected line, likewise; E and X act on the newest.
  const draftsOn = (l: DiffLine | undefined) => (hunk && l ? draftsAt(props.drafts, hunk, l.kind === 'del' ? l.oldLine : l.newLine, l.kind === 'del' ? 'LEFT' : 'RIGHT').filter((d) => !d.posted) : []);
  const cursorDraft = [...draftsOn(cursorLine), ...(hidden.get(partner[cursor]) === 'beside' ? draftsOn(hunk?.lines[partner[cursor]]) : [])]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  useEffect(() => {
    setSummarySel(0);
    setShowUntested(false);
  }, [chapter?.id]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(''), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  const prog = useMemo(() => progress(tour, states), [tour, states]);
  const delta = useMemo(() => new Set(tour.rereview?.newHunkIds ?? []), [tour.rereview]);
  // On a re-review showing only changes, the chapter list keeps the whole tour and greys what it leaves out.
  const listed = props.deltaOnly && props.allChapters ? props.allChapters : chapters;
  const unchangedHunks = props.deltaOnly && chapter ? (props.allChapters?.find((c) => c.id === chapter.id)?.hunkIds.length ?? 0) - chapter.hunkIds.length : 0;
  const chapterStrip = useMemo(
    () =>
      wide
        ? ''
        : listed
            .map((c) => {
              const shown = chapters.find((d) => d.id === c.id);
              return c.id === chapter?.id ? `[${c.title}]` : shown ? stateMark(chapterState(tour, shown, states)).mark : '·';
            })
            .join(' '),
    [wide, listed, chapters, chapter?.id, tour, states],
  );

  // ---------- navigation ----------
  const firstHunk = (c: number) => (chapters[c]?.collapsed ? -1 : 0);
  // n/p never step into optional chapters (import-only changes); ]/[ and the chapter list still reach them.
  const nextChapter = () => chapters.findIndex((c, i) => i > ci && !c.optional);
  const prevChapter = () => chapters.findLastIndex((c, i) => i < ci && !c.optional);
  const next = (mark?: ReadState) => {
    if (hunk && mark) props.setState(hunk, mark);
    if (!chapter) return;
    if (!collapsedView && hi < chapter.hunkIds.length - 1) return props.setPos(ci, hi + 1);
    const nc = nextChapter();
    if (nc >= 0) return props.setPos(nc, firstHunk(nc));
    const optional = chapters.some((c) => c.optional);
    setFlash(`End of the tour.${optional ? ' Import-only changes are optional (] to open them).' : ''} Press s to review your drafts and submit.`);
  };
  const prev = () => {
    if (hi > 0) return props.setPos(ci, hi - 1);
    if (hi === 0 && chapter?.collapsed) return props.setPos(ci, -1);
    const pci = prevChapter();
    if (pci >= 0) {
      const pc = chapters[pci];
      return props.setPos(pci, pc.collapsed ? -1 : pc.hunkIds.length - 1);
    }
  };

  const sel = selRange(cursor, anchor);
  const draft = (a: DraftAnchor) => newDraft(tour, a);
  const describe = (d: Draft) => describeAnchor(d.anchor, chapters, chapter);

  const saveDraft = (d: Draft) => {
    const edited = props.drafts.some((x) => x.id === d.id);
    props.saveDraft(d);
    setAnchor(null);
    close();
    setFlash(`Draft ${edited ? 'updated' : 'saved'} (${d.label}). Nothing posts until you submit.`);
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
    back: () => (props.back ?? props.quit)(),
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
      setFlash(`Skipped ${ids.length} hunk(s) in "${chapter.title}".`);
      next();
    },
    // Code
    next: () => next(collapsedView ? undefined : 'read'),
    prev: () => prev(),
    nextChapter: () => void (ci < chapters.length - 1 ? props.setPos(ci + 1, firstHunk(ci + 1)) : undefined),
    prevChapter: () => void (ci > 0 ? props.setPos(ci - 1, firstHunk(ci - 1)) : undefined),
    down: () => moveCursor(1),
    up: () => moveCursor(-1),
    pageDown: () => moveCursor(10),
    pageUp: () => moveCursor(-10),
    range: () => setAnchor((a) => (a === null ? cursor : null)),
    clearRange: () => setAnchor(null),
    skip: () => next('skipped'),
    defer: () => {
      setFlash('Deferred: it stays on the submit screen as unread work.');
      next('deferred');
    },
    unread: () => props.setState(hunk!, 'unread'),
    raw: () => setRaw((r) => !r),
    whitespace: () => (props.toggleWhitespace ? props.toggleWhitespace() : setOwnHideWhitespace((w) => !w)),
    split: () => {
      if (!wantSplit && srcWidth < MIN_SPLIT_WIDTH) setFlash('Split view needs a wider terminal; showing it once there is room.');
      if (props.toggleSplit) props.toggleSplit();
      else setOwnSplit((v) => !v);
    },
    testPane: () => {
      if (!hasLinkedTests) return setFlash('No test exercises this hunk.');
      if (props.toggleTestPane) props.toggleTestPane();
      else setOwnHideTests((v) => !v);
    },
    moreContext: () => growContext(CONTEXT_STEP),
    lessContext: () => growContext(-CONTEXT_STEP),
    untested: () => setShowUntested((shown) => !shown),
    focusTests: () => (hasLinkedTests ? setTestFocus(true) : setFlash('No test exercises this hunk.')),
    comment: () => {
      if (crossesContext(hunk!, sel)) return setFlash('This range crosses dimmed lines outside the PR’s diff: GitHub can’t take one comment across them. Select one side.');
      const a = lineAnchor(hunk!, sel);
      if (!a && anchorLines(hunk!, sel).length === 0) return setFlash('This is context outside the PR’s diff: GitHub can’t take a comment on it.');
      if (!a) return setFlash('Nothing to anchor a comment to here.');
      openComposer(draft(a));
    },
    reply: () => (cursorThreads.length ? show('reply') : setFlash('No review thread on this line. Move to a commented line and press y.')),
    thread: () => (cursorThreads.length ? show('thread') : setFlash('No review thread on this line. Move to a commented line and press e.')),
    editDraft: () => (cursorDraft ? openComposer(cursorDraft) : setFlash('No draft on this line. Move to a line with ✎ and press E.')),
    deleteDraft: () => (cursorDraft ? show('delete') : setFlash('No draft on this line. Move to a line with ✎ and press X.')),
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
      const action = keyAction(keyView, keyCtx, input, key);
      if (action) actions[action]();
    },
    { isActive: props.active !== false && overlay.kind === 'none' },
  );

  useInput(
    (input, key) => {
      if (overlay.kind === 'help') return close();
      if (overlay.kind === 'move') {
        if (key.escape) return close();
        const move = (by: number) => setOverlay((o) => (o.kind === 'move' ? { ...o, sel: Math.max(0, Math.min(chapters.length - 1, o.sel + by)) } : o));
        if (input === 'j' || key.downArrow) return move(1);
        if (input === 'k' || key.upArrow) return move(-1);
        if (key.return && hunk) {
          props.moveHunk(hunk, chapters[overlay.sel].id);
          setFlash(`Moved to "${chapters[overlay.sel].title}".`);
          return close();
        }
      }
    },
    { isActive: props.active !== false && (overlay.kind === 'help' || overlay.kind === 'move') },
  );

  useInput(
    (input) => {
      if (input === 'y' && cursorDraft) {
        props.deleteDraft(cursorDraft);
        setFlash(`Draft deleted (${cursorDraft.label}).`);
      }
      close();
    },
    { isActive: props.active !== false && overlay.kind === 'delete' },
  );

  if (!chapter) {
    if (overlay.kind !== 'none') close(); // see overlayShown below
    return (
      <Box flexDirection="column">
        <Text>{props.deltaOnly ? 'Nothing changed since your last review. Press D to show the whole tour.' : 'This PR has no changes to review.'}</Text>
        <KeyBar
          width={width}
          keys={[
            ['D', 'whole tour'],
            ['s', 'submit'],
            ['b', 'briefing'],
            ...((props.back
              ? [
                  ['q', 'PR list'],
                  ['Q', 'quit'],
                ]
              : [['q', 'quit']]) as [string, string][]),
          ]}
        />
      </Box>
    );
  }

  // Linked tests that are not beside the code (a narrow terminal, T, or a split diff) get a tab
  // saying they are there and how to open them.
  const testDrawer =
    hasLinkedTests && !sideBySide && !testFocus && !collapsedView ? `◂ ${hunk.covers ? 'code it covers' : `${relevantTests.length} test${relevantTests.length === 1 ? '' : 's'}`}` : undefined;
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

  const overlayNode = (() => {
    if (slots.popup === 'diagram') {
      const g = chapter.diagram ?? tour.overview!;
      return (
        <DiagramView
          graph={g}
          width={mainWidth}
          height={height - 4}
          onClose={() => close()}
          onJump={(hid) => {
            const c = chapters.findIndex((ch) => ch.hunkIds.includes(hid));
            if (c >= 0) props.setPos(c, chapters[c].hunkIds.indexOf(hid));
            close();
          }}
          onComment={(nodeId) => openComposer(draft({ type: 'node', chapterId: chapter.id, nodeId }))}
        />
      );
    }
    if (slots.popup === 'comment') return commentEditor(mainWidth, plan.mainHeight);
    if (slots.popup === 'move') {
      return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>Move this hunk to…</Text>
          {chapters.map((c, i) => (
            <Text key={c.id} inverse={overlay.kind === 'move' && i === overlay.sel}>
              {truncate(`${c.title}`, mainWidth - 6)}
            </Text>
          ))}
          <Text dimColor>enter: move · esc: cancel</Text>
        </Box>
      );
    }
    if (slots.popup === 'checklist' && chapter.checklist && svc) {
      return <ChecklistPanel items={chapter.checklist} confirms={svc.confirms} width={mainWidth} onToggle={svc.setConfirm} onClose={() => close()} />;
    }
    return null;
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

  const screen = (
    <Box flexDirection="column" width={width} height={height}>
      <Header tour={tour} prog={prog} order={props.order} deltaOnly={props.deltaOnly} width={width} />
      {props.banner ? (
        <Text backgroundColor="yellow" color="black">
          {pad(` ${props.banner}`, width)}
        </Text>
      ) : null}
      {!wide ? (
        <Text dimColor wrap="truncate">
          {truncate(`${ORDER_LABEL[props.order]} order · Chapter ${ci + 1}/${chapters.length}: ${chapterStrip}`, width)}
        </Text>
      ) : null}
      <Box flexDirection="row">
        {wide ? <ChapterList tour={tour} chapters={chapters} listed={listed} states={states} current={chapter.id} width={listWidth} height={plan.mainHeight} /> : null}
        {wide ? <Box width={1} /> : null}
        <Box flexDirection="column" width={mainWidth}>
          {overlayNode ?? (
            <>
              <ChapterTitle chapter={chapter} hunk={hunk} hi={hi} isNew={!!hunk && delta.has(hunk.id)} unchanged={unchangedHunks} width={mainWidth} states={states} drawer={testDrawer} />
              {plan.explainLines.length ? (
                <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor={hunk?.narrationInferred ? 'gray' : 'blue'} paddingX={1} width={mainWidth}>
                  <Text bold color={hunk?.narrationInferred ? 'gray' : 'blue'}>
                    {collapsedView ? 'About this chapter' : 'Explanation'}
                  </Text>
                  {plan.explainLines.map((l, i) => (
                    <MdLineView key={i} line={l} />
                  ))}
                </Box>
              ) : null}
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
                      <TestPane
                        tests={relevantTests}
                        covers={hunk.covers}
                        idx={testIdx}
                        cursor={testCursor}
                        scroll={testScroll}
                        setScroll={setTestScroll}
                        focused={testFocus}
                        inline={
                          slots.testInline === 'comment'
                            ? inlineComposer(plan.testPane.inlineWidth, plan.testPane.height)
                            : slots.testInline === 'ask'
                              ? { node: askPanel, height: askHeight }
                              : undefined
                        }
                        width={plan.testPane.width}
                        height={plan.testPane.height}
                      />
                    </Box>
                  ) : plan.testPaneShown ? (
                    <TestPane
                      tests={relevantTests}
                      covers={hunk.covers}
                      idx={testIdx}
                      cursor={testCursor}
                      scroll={testScroll}
                      setScroll={setTestScroll}
                      focused={testFocus}
                      inline={
                        slots.testInline === 'comment'
                          ? inlineComposer(plan.testPane.inlineWidth, plan.testPane.height)
                          : slots.testInline === 'ask'
                            ? { node: askPanel, height: askHeight }
                            : undefined
                      }
                      width={plan.testPane.width}
                      height={plan.testPane.height}
                    />
                  ) : null}
                </Box>
              ) : (
                <Text dimColor>This chapter has no hunks.</Text>
              )}
            </>
          )}
        </Box>
      </Box>
      {slots.confirmDelete && cursorDraft ? (
        <Text color="yellow" wrap="truncate">
          {truncate(`Delete this draft? [${cursorDraft.label}] ${clean(cursorDraft.body).replace(/\s+/g, ' ')}`, width - 8)} y / n
        </Text>
      ) : (
        <DraftLine drafts={props.drafts} hunk={hunk} cursor={cursor} flash={flash} width={width} describe={describe} />
      )}
      <KeyBar
        width={width}
        status={overlay.kind === 'none' && hunk && !testFocus ? [raw && 'raw', splitView && 'split', ignoreWhitespace && 'whitespace hidden'].filter(Boolean).join(' · ') : undefined}
        end={
          overlay.kind !== 'none'
            ? []
            : testFocus
              ? [
                  ['t/esc', 'back to code'],
                  ['b', 'briefing'],
                ]
              : [...((tour.rereview ? [['D', props.deltaOnly ? 'full review' : 'changes only']] : []) as [string, string][]), ['b', 'briefing'], ['h', 'all keys']]
        }
        keys={overlay.kind !== 'none' ? [] : barKeys(keyView, keyCtx)}
      />
    </Box>
  );
  // Help floats over the screen, which stays visible around it.
  if (overlay.kind === 'help')
    return (
      <ReviewPopup background={screen} width={width} height={height} maxWidth={HELP_WIDTH} maxHeight={HELP_HEIGHT}>
        {(w, h) => <Help width={w} height={h} ai={!!props.agent} />}
      </ReviewPopup>
    );
  return screen;
}
