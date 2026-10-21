import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useInput } from 'ink';
import { Box, Text } from './themed.js';
import type { Chapter, ChapterOrder, DiffFile, DiffLine, Draft, DraftAnchor, ExistingThread, Hunk, ReactionContent, ReadState, ThreadComment, Tour } from '../types.js';
import { MdLineView, line } from './markdown.js';
import { ChecklistPanel } from './Panels.js';
import { chapterState, ORDER_LABEL, pad, progress, stateMark, stateOf, truncate, wrap, type States } from './nav.js';
import { DiagramView } from './DiagramView.js';
import { CommentEditor, type SetComposer } from './CommentEditor.js';
import { INLINE_ROWS, inlineComposerSlot } from './AiSuggestion.js';
import { ThreadView } from './ThreadView.js';
import { AskOverlay } from './AskOverlay.js';
import { codePaneWidths, MIN_SPLIT_WIDTH } from './paneWidths.js';
import { ReviewPopup } from './ReviewPopup.js';
import type { AgentContext } from '../agent/types.js';
import { foldedLines, pairChangedLines, type Fold } from '../diff/lines.js';
import { isSpecialKind } from '../analysis/special.js';
import { safeReadFile } from '../analysis/safeRead.js';
import { fileLines, headFor, withContext } from '../diff/context.js';
import { KeyBar } from './KeyBar.js';
import { initComposer, isLineAnchor, sameAnchor, type ComposerEnv, type ComposerState, type ReferenceServices } from './composer.js';
import { generateSuggestion } from '../agent/suggest.js';
import { clean, safe } from './chapter/text.js';
import { draftsAt, threadAt } from './chapter/lineNotes.js';
import { SourcePane } from './chapter/SourcePane.js';
import { TestPane } from './chapter/TestPane.js';
import { ChapterList, ChapterTitle, CollapsedSummary, DraftLine, Header } from './chapter/parts.js';
import { Help, HELP_ROWS, HELP_WIDTH } from './chapter/Help.js';
import { anchorLines, crossesContext, describeAnchor, lineAnchor, newDraft, selectedCode, selRange, testLineAnchor } from './chapter/selection.js';
import { guideLines, noTestHint, type GuideLine } from './chapter/guide.js';

export { KeyBar };

export type AgentCtx = AgentContext;

type Overlay = 'none' | 'diagram' | 'comment' | 'thread' | 'reply' | 'ask' | 'move' | 'help' | 'checklist' | 'delete';

// v1.1 features that need the worktree, the repo config or the store.
export interface Services {
  root: string;
  confirms: Record<string, boolean>;
  setConfirm: (id: string, v: boolean) => void;
  // Loads repository collaborators for @mention suggestions; absent in preview mode and tests.
  loadMentionUsers?: () => Promise<string[]>;
}

// The head's lines of a hunk's file, for expanding its context, or why there are none to show.
function headOf(hunk: Hunk, files: DiffFile[], root?: string): { lines: string[] } | { reason: string } {
  const file = files.find((f) => f.path === hunk.file);
  if (!file || file.status === 'added') return { reason: 'No context to add: this file is new, so the hunk already shows all of it.' };
  if (file.status === 'deleted') return { reason: 'No context to add: this file is deleted in the PR.' };
  if (file.binary) return { reason: 'No context to add: this is a binary file.' };
  if (!root) return { reason: 'Context can be expanded once the checkout is ready.' };
  const text = safeReadFile(root, hunk.file);
  if (text === undefined) return { reason: 'Can’t read more of this file: it is over 1 MB, or not a plain file in the checkout.' };
  const lines = headFor(hunk, fileLines(text));
  return lines ? { lines } : { reason: 'No context to add: the file has changed since the diff was taken.' };
}

const CONTEXT_STEP = 10; // lines + and - add or remove on each side of a hunk

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
  // Context the reader expanded around the hunk (+ and -), read from the checkout's head. Keyed
  // on the hunk, so moving to another hunk starts it unexpanded.
  const [expand, setExpand] = useState({ id: '', above: 0, below: 0 });
  const headLines = useMemo(() => {
    const head = diffHunk && expand.id === diffHunk.id ? headOf(diffHunk, tour.files, svc?.root) : undefined;
    return head && 'lines' in head ? head.lines : undefined;
  }, [diffHunk, tour.files, svc?.root, expand.id]);
  const neighbours = useMemo(() => {
    const ids = diffHunk ? (tour.files.find((f) => f.path === diffHunk.file)?.hunkIds ?? []) : [];
    const at = diffHunk ? ids.indexOf(diffHunk.id) : -1;
    const prev = at > 0 ? tour.hunks[ids[at - 1]] : undefined;
    const next = at >= 0 ? tour.hunks[ids[at + 1]] : undefined;
    return { prevEnd: prev?.lines.findLast((l) => l.newLine !== undefined)?.newLine, nextStart: next?.lines.find((l) => l.newLine !== undefined)?.newLine };
  }, [diffHunk, tour.files, tour.hunks]);
  // The hunk as shown: the diff's hunk plus any expanded context, with the same id and content hash.
  const hunk = useMemo(() => (diffHunk && headLines ? withContext(diffHunk, headLines, expand.above, expand.below, neighbours).hunk : diffHunk), [diffHunk, headLines, expand, neighbours]);
  const [cursor, setCursor] = useState(0);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [scroll, setScroll] = useState(0);
  const [raw, setRaw] = useState(false);
  const [ownHideWhitespace, setOwnHideWhitespace] = useState(true);
  const ignoreWhitespace = props.hideWhitespace ?? ownHideWhitespace;
  const [testFocus, setTestFocus] = useState(false);
  const [testIdx, setTestIdx] = useState(0);
  const [testCursor, setTestCursor] = useState(0);
  const [testScroll, setTestScroll] = useState(0);
  const [showUntested, setShowUntested] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>('none');
  const [pending, setPending] = useState<Draft | null>(null);
  const [moveSel, setMoveSel] = useState(0);
  const [summarySel, setSummarySel] = useState(0);
  const [flash, setFlash] = useState('');
  const [ownSplit, setOwnSplit] = useState(false);
  const wantSplit = props.splitDiff ?? ownSplit;
  const [ownHideTests, setOwnHideTests] = useState(false);
  const hideTests = props.hideTestPane ?? ownHideTests;
  // The open composer's working state (see composer.ts).
  const ev = props.references;
  const [composer, setComposer] = useState<ComposerState>();
  const setComposerState: SetComposer = (f) => setComposer((c) => (c ? f(c) : c));
  // The pipeline fills tour.mentionUsers only if the collaborator list arrived in time; fetch it
  // (memoized in gh.ts) the first time an editor that offers @mentions opens.
  const [lateMentions, setLateMentions] = useState<string[]>();
  const wantsMentions = overlay === 'comment' || overlay === 'reply' || overlay === 'thread';
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

  const wide = width >= 180;
  const roomForTests = width >= 130; // tests can sit beside the code
  const listWidth = wide ? 32 : 0;
  const mainWidth = width - listWidth - (wide ? 1 : 0);
  const hasLinkedTests = !!hunk && (relevantTests.length > 0 || !!hunk.covers);
  const paneWidths = useMemo(
    () =>
      codePaneWidths(
        mainWidth - 1,
        hunk?.lines.map((line) => line.text) ?? [],
        testCodeLines.map((line) => line.text),
        testFocus ? 'test' : 'source',
        wantSplit,
      ),
    [mainWidth, hunk, testCodeLines, testFocus, wantSplit],
  );
  // A split diff too narrow to read beside the tests stacks them instead: t still opens them.
  const testsStacked = roomForTests && hasLinkedTests && !hideTests && wantSplit && paneWidths.source < MIN_SPLIT_WIDTH;
  // While the comment's @ list is open the pane holding it takes the full width, so the list
  // and its code preview sit side by side; the other pane comes back when the list closes.
  const listWide = overlay === 'comment' && !!composer?.listOpen;
  const sideBySide = roomForTests && hasLinkedTests && !hideTests && !testsStacked && !listWide;
  // Stacked, only one pane shows at a time, so whichever is visible gets the full width.
  const srcWidth = sideBySide ? paneWidths.source : mainWidth;
  const testWidth = sideBySide ? paneWidths.test : mainWidth;
  const splitView = wantSplit && !raw && srcWidth >= MIN_SPLIT_WIDTH;

  const partner = useMemo(() => (hunk ? pairChangedLines(hunk.lines) : []), [hunk]);
  // Removed lines folded into the line replacing them; the cursor steps over them.
  // Split, every removed line with a replacement sits beside it, on the replacement's row.
  const hidden = useMemo(() => {
    const folds = hunk ? foldedLines(hunk.lines, partner, ignoreWhitespace) : new Map<number, Fold>();
    if (splitView && hunk) for (const [i, p] of partner.entries()) if (p >= 0 && hunk.lines[i].kind === 'del' && !folds.has(i)) folds.set(i, 'beside');
    return folds;
  }, [hunk, partner, ignoreWhitespace, splitView]);
  const visibleLine = (i: number, dir: 1 | -1) => {
    const n = hunk?.lines.length ?? 0;
    for (let j = i; j >= 0 && j < n; j += dir) if (!hidden.has(j)) return j;
    for (let j = i; j >= 0 && j < n; j -= dir) if (!hidden.has(j)) return j;
    return i;
  };
  const moveCursor = (by: number) => setCursor((c) => visibleLine(Math.max(0, Math.min((hunk?.lines.length ?? 1) - 1, c + by)), by > 0 ? 1 : -1));
  const cursorLine = hunk?.lines[cursor];
  const threadsOn = (l: DiffLine | undefined) => (hunk && l ? threadAt(tour.existingThreads, hunk.file, l.kind === 'del' ? l.oldLine : l.newLine, l.kind === 'del' ? 'LEFT' : 'RIGHT') : []);
  // Split, a removed line's threads are on the row it shares with its replacement.
  const cursorThreads = [...threadsOn(cursorLine), ...(hidden.get(partner[cursor]) === 'beside' ? threadsOn(hunk?.lines[partner[cursor]]) : [])];
  // Unposted drafts on the selected line, likewise; E and X act on the newest.
  const draftsOn = (l: DiffLine | undefined) => (hunk && l ? draftsAt(props.drafts, hunk, l.kind === 'del' ? l.oldLine : l.newLine, l.kind === 'del' ? 'LEFT' : 'RIGHT').filter((d) => !d.posted) : []);
  const cursorDraft = [...draftsOn(cursorLine), ...(hidden.get(partner[cursor]) === 'beside' ? draftsOn(hunk?.lines[partner[cursor]]) : [])]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  // Reset per-hunk view state when the hunk changes; the test side jumps to the matching case.
  useEffect(() => {
    // The first real change: not a folded line, nor a line that only changed whitespace.
    const first = hunk
      ? Math.max(
          0,
          hunk.lines.findIndex((l, i) => l.kind !== 'ctx' && !hidden.has(i) && hidden.get(partner[i]) !== 'whitespace'),
          hunk.lines.findIndex((l, i) => l.kind !== 'ctx' && !hidden.has(i)),
        )
      : 0;
    setCursor(first);
    setAnchor(null);
    setScroll(0);
    setTestIdx(0);
    setTestCursor(0);
    setTestScroll(0);
    setTestFocus(false);
    setRaw(false);
    // Keyed on the id: the hunk object is replaced as narration streams in, and folds changing
    // are handled by the effect below, neither of which should reset the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hunk?.id]);
  // Folding a line moves a cursor or range end off it onto its replacement. Updaters, so a
  // cursor the hunk reset just placed is the one checked.
  useEffect(() => {
    setCursor((c) => (hidden.has(c) ? partner[c] : c));
    setAnchor((a) => (a !== null && hidden.has(a) ? partner[a] : a));
  }, [hidden, partner]);
  useEffect(() => {
    setSummarySel(0);
    setShowUntested(false);
  }, [chapter?.id]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(''), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  const collapsedView = !!chapter && chapter.collapsed && hi < 0;
  const prog = useMemo(() => progress(tour, states), [tour, states]);
  const delta = useMemo(() => new Set(tour.rereview?.newHunkIds ?? []), [tour.rereview]);
  const filesByPath = useMemo(() => new Map(tour.files.map((f) => [f.path, f])), [tour.files]);
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

  // Shows `by` more lines of context on each side of the hunk, or fewer when negative, keeping the
  // cursor on its line.
  const growContext = (by: number) => {
    if (!diffHunk) return;
    const head = headLines ? { lines: headLines } : headOf(diffHunk, tour.files, svc?.root);
    if ('reason' in head) return setFlash(head.reason);
    const { lines } = head;
    const now = expand.id === diffHunk.id ? expand : { above: 0, below: 0 };
    const before = withContext(diffHunk, lines, now.above, now.below, neighbours);
    const after = withContext(diffHunk, lines, Math.max(0, now.above + by), Math.max(0, now.below + by), neighbours);
    if (by > 0 && after.above === before.above && after.below === before.below) return setFlash('No more context: the hunk reaches the file’s edges or its neighbouring hunks.');
    const shift = after.above - before.above;
    const last = after.hunk.lines.length - 1;
    setCursor((c) => Math.max(0, Math.min(last, c + shift)));
    setAnchor((a) => (a === null ? null : Math.max(0, Math.min(last, a + shift))));
    setExpand({ id: diffHunk.id, above: after.above, below: after.below });
  };

  const sel = selRange(cursor, anchor);
  const draft = (a: DraftAnchor) => newDraft(tour, a);
  const describe = (d: Draft) => describeAnchor(d.anchor, chapters, chapter);

  const saveDraft = (d: Draft) => {
    const edited = props.drafts.some((x) => x.id === d.id);
    props.saveDraft(d);
    setAnchor(null);
    setOverlay('none');
    setComposer(undefined);
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
    setPending(d);
    setComposer(initComposer(d, { index: ev?.repoIndex?.() }));
    setOverlay('comment');
    if (isLineAnchor(d.anchor)) noteRecent.current?.({ path: d.anchor.file, line: d.anchor.line, why: 'comment' });
  };

  // ---------- input ----------
  useInput(
    (input, key) => {
      if (input === 'b') return props.openBriefing();
      if (testFocus) {
        if (key.escape || input === 't') {
          setTestFocus(false);
          return;
        }
        if (input === 'j' || key.downArrow) return setTestCursor((i) => Math.min(Math.max(0, testCodeLines.length - 1), i + 1));
        if (input === 'k' || key.upArrow) return setTestCursor((i) => Math.max(0, i - 1));
        if (input === 'J' || key.pageDown) return setTestCursor((i) => Math.min(Math.max(0, testCodeLines.length - 1), i + 10));
        if (input === 'K' || key.pageUp) return setTestCursor((i) => Math.max(0, i - 10));
        if (input === 'n' || input === 'p' || key.tab) {
          const n = relevantTests.length;
          setTestScroll(0);
          setTestCursor(0);
          return setTestIdx((i) => (n ? (i + (input === 'p' ? n - 1 : 1)) % n : 0));
        }
        if (input === 'c') {
          const a = testLineAnchor(tour.hunks, testFile, testCodeLines[testCursor]);
          if (!a) return setFlash('This test line is outside the PR diff, so GitHub cannot attach a line comment.');
          return openComposer(draft(a));
        }
        if (input === '?') return setOverlay('ask');
        if (input === 'q') return (props.back ?? props.quit)();
        if (input === 'Q') return props.quit();
        return;
      }
      if (collapsedView) {
        const ids = chapter.hunkIds;
        if (input === 'j' || key.downArrow) return setSummarySel((s) => Math.min(ids.length - 1, s + 1));
        if (input === 'k' || key.upArrow) return setSummarySel((s) => Math.max(0, s - 1));
        if (key.return || input === 'e') return ids.length ? props.setPos(ci, summarySel) : undefined;
        if (input === 'x') {
          for (const id of ids) if (stateOf(states, tour.hunks[id]) === 'unread') props.setState(tour.hunks[id], 'skipped');
          setFlash(`Skipped ${ids.length} hunk(s) in "${chapter.title}".`);
          return next();
        }
      }
      if (input === 'n') return next(collapsedView ? undefined : 'read');
      if (input === 'p') return prev();
      if (input === ']') return ci < chapters.length - 1 ? props.setPos(ci + 1, firstHunk(ci + 1)) : undefined;
      if (input === '[') return ci > 0 ? props.setPos(ci - 1, firstHunk(ci - 1)) : undefined;
      if (hunk && (input === 'j' || key.downArrow)) return moveCursor(1);
      if (hunk && (input === 'k' || key.upArrow)) return moveCursor(-1);
      if (hunk && (input === 'J' || key.pageDown)) return moveCursor(10);
      if (hunk && (input === 'K' || key.pageUp)) return moveCursor(-10);
      if (input === 'v' && hunk) return setAnchor((a) => (a === null ? cursor : null));
      if (key.escape) return setAnchor(null);
      if (input === 'x' && hunk) return next('skipped');
      if (input === 'z' && hunk) {
        setFlash('Deferred: it stays on the submit screen as unread work.');
        return next('deferred');
      }
      if (input === 'u' && hunk) return props.setState(hunk, 'unread');
      if (input === 'r' && hunk) return setRaw((r) => !r);
      if (input === 'w') return props.toggleWhitespace ? props.toggleWhitespace() : setOwnHideWhitespace((w) => !w);
      if (input === 'S') {
        if (!wantSplit && srcWidth < MIN_SPLIT_WIDTH) setFlash('Split view needs a wider terminal; showing it once there is room.');
        return props.toggleSplit ? props.toggleSplit() : setOwnSplit((v) => !v);
      }
      if (input === 'T') {
        if (!hasLinkedTests) return setFlash('No test exercises this hunk.');
        return props.toggleTestPane ? props.toggleTestPane() : setOwnHideTests((v) => !v);
      }
      if ((input === '+' || input === '=') && hunk) return growContext(CONTEXT_STEP);
      if (input === '-' && hunk) return growContext(-CONTEXT_STEP);

      if (input === 'U') return setShowUntested((shown) => !shown);
      if (input === 't') {
        const has = !!hunk && (hunk.tests.some((t) => t.source !== 'naming') || !!hunk.covers);
        if (!has) return setFlash('No test exercises this hunk.');
        return setTestFocus(true);
      }
      if (input === 'c' && hunk) {
        if (crossesContext(hunk, sel)) return setFlash('This range crosses dimmed lines outside the PR’s diff: GitHub can’t take one comment across them. Select one side.');
        const a = lineAnchor(hunk, sel);
        if (!a && anchorLines(hunk, sel).length === 0) return setFlash('This is context outside the PR’s diff: GitHub can’t take a comment on it.');
        if (!a) return setFlash('Nothing to anchor a comment to here.');
        return openComposer(draft(a));
      }
      if (input === 'y' && hunk && props.replyToThread) {
        if (!cursorThreads.length) return setFlash('No review thread on this line. Move to a commented line and press y.');
        return setOverlay('reply');
      }
      if (input === 'e' && hunk) {
        if (!cursorThreads.length) return setFlash('No review thread on this line. Move to a commented line and press e.');
        return setOverlay('thread');
      }
      if (input === 'E' && hunk) {
        if (!cursorDraft) return setFlash('No draft on this line. Move to a line with ✎ and press E.');
        return openComposer(cursorDraft);
      }
      if (input === 'X' && hunk) {
        if (!cursorDraft) return setFlash('No draft on this line. Move to a line with ✎ and press X.');
        return setOverlay('delete');
      }
      if (input === 'C' && chapter) return openComposer(draft({ type: 'chapter', chapterId: chapter.id }));
      if (input === '?') {
        if (hunk && cursorLine?.newLine !== undefined) noteRecent.current?.({ path: hunk.file, line: cursorLine.newLine, why: 'ask' });
        return collapsedView || hunk ? setOverlay('ask') : setFlash('Nothing to ask about here.');
      }
      if (input === 'd') return chapter?.diagram || tour.overview ? setOverlay('diagram') : setFlash('No diagram for this chapter.');
      if (input === 'm' && hunk) {
        setMoveSel(ci);
        return setOverlay('move');
      }
      if (input === 'f') return props.toggleOrder();
      if (input === 'D' && tour.rereview) return props.toggleDelta();
      if (input === 'R' && props.rebase) return props.rebase();
      if (input === 'o') return props.openInAgent(hunk, chapter);
      if (input === 's') return props.openSubmit();
      if (input === 'h') return setOverlay('help');
      if (input === 'i') {
        if (!chapter?.checklist?.length) return setFlash('No team checklist applies to this chapter (.guided-review.json → checklists).');
        return svc ? setOverlay('checklist') : setFlash('The checklist opens once the checkout is ready.');
      }
      if (input === 'L' && props.onTheme) return props.onTheme();
      if (input === 'q') return (props.back ?? props.quit)();
      if (input === 'Q') return props.quit();
    },
    { isActive: props.active !== false && overlay === 'none' },
  );

  useInput(
    (input, key) => {
      if (overlay === 'help') return setOverlay('none');
      if (overlay === 'move') {
        if (key.escape) return setOverlay('none');
        if (input === 'j' || key.downArrow) return setMoveSel((s) => Math.min(chapters.length - 1, s + 1));
        if (input === 'k' || key.upArrow) return setMoveSel((s) => Math.max(0, s - 1));
        if (key.return && hunk) {
          props.moveHunk(hunk, chapters[moveSel].id);
          setFlash(`Moved to "${chapters[moveSel].title}".`);
          return setOverlay('none');
        }
      }
    },
    { isActive: props.active !== false && (overlay === 'help' || overlay === 'move') },
  );

  useInput(
    (input) => {
      if (input === 'y' && cursorDraft) {
        props.deleteDraft(cursorDraft);
        setFlash(`Draft deleted (${cursorDraft.label}).`);
      }
      setOverlay('none');
    },
    { isActive: props.active !== false && overlay === 'delete' },
  );

  if (!chapter) {
    if (overlay !== 'none') setOverlay('none'); // see overlayShown below
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

  // The key bar shows only keys that do something here, most useful first; the rest are under h.
  const barKeys = (): [string, string][] => {
    const ask: [string, string][] = props.agent ? [['?', 'ask']] : [];
    if (testFocus) return [['n/p', 'test'], ['c', 'comment'], ...ask];
    const submit: [string, string][] = prog.read + prog.skipped === prog.total ? [['s', 'submit']] : [];
    if (collapsedView) return [...submit, ['enter', 'expand'], ['n/p', 'next/prev'], ['C', 'comment on flow'], ['x', 'skip chapter'], [']/[', 'chapter']];
    const selecting = anchor !== null;
    return [
      ...submit,
      ['n/p', 'hunk'],
      ['c', selecting ? 'comment on range' : 'comment'],
      ...(cursorThreads.length ? ([['e', 'thread'], ...(props.replyToThread ? [['y', 'reply']] : [])] as [string, string][]) : []),
      ...(cursorDraft
        ? ([
            ['E', 'edit draft'],
            ['X', 'delete draft'],
          ] as [string, string][])
        : []),
      ...ask,
      ['v', selecting ? 'end range' : 'range'],
      [']/[', 'chapter'],
      ...(showTests ? ([['t', 'tests']] as [string, string][]) : []),
      ...(chapter?.diagram || tour.overview ? ([['d', 'diagram']] as [string, string][]) : []),
      ['x', 'skip'],
      ['+/-', 'context'],
      ['S', splitView ? 'inline' : 'split'],
    ];
  };

  // ---------- layout ----------
  // The guide (narration and notes) sits beside the code on wide terminals and
  // above it on narrow ones. Tests show under the guide only when a test actually
  // exercises the hunk; a filename-only guess becomes a one-line hint.
  const configFile = (chapter.kind === 'config' || isSpecialKind(chapter.kind)) && hunk ? filesByPath.get(hunk.file) : undefined;
  // A narrated collapsed chapter (lockfiles) shares one narration across its hunks: show it above the file list.
  const sharedNarration = collapsedView ? chapter.hunkIds.map((id) => tour.hunks[id]?.narration).find(Boolean) : undefined;
  const narration = hunk?.narration ?? (collapsedView ? [sharedNarration, chapter.summary].filter(Boolean).join('\n\n') : (configFile?.summary ?? configFile?.kindReason));
  const chapterNotes: string[] = [];
  if (chapter.linkedHunkIds.length && hi <= 0) chapterNotes.push(`Also uses ${chapter.linkedHunkIds.length} hunk(s) shown in an earlier chapter.`);
  if (chapter.lowConfidence) chapterNotes.push('Some flow links use naming guesses: low confidence.');
  if (hi <= 0 && chapter.checklist?.length) {
    const open = chapter.checklist.filter((c) => !svc?.confirms[c.id]).length;
    if (open) chapterNotes.push(`Team checklist: ${open} item(s) to confirm (i). ${chapter.checklist.filter((c) => c.status === 'fail').length} flagged by the agent.`);
  }

  // Linked tests that are not beside the code (a narrow terminal, T, or a split diff) get a tab
  // saying they are there and how to open them.
  const testDrawer =
    hasLinkedTests && !sideBySide && !testFocus && !collapsedView ? `◂ ${hunk.covers ? 'code it covers' : `${relevantTests.length} test${relevantTests.length === 1 ? '' : 's'}`}` : undefined;
  const nameGuess = hunk?.tests.find((t) => t.source === 'naming');
  const showTests = hasLinkedTests;

  const headerRows = 1 + (props.banner ? 1 : 0) + (wide ? 0 : 1);
  const titleRows = 2;
  const footerRows = 3;
  // The explanation is its own large section above the code: narration, the author's note,
  // notes on the chapter or hunk, and the no-test hint. It takes what it needs, up to about
  // half the screen; the code gets the rest. Tests sit beside the code only when relevant.
  const avail = height - headerRows - titleRows - footerRows;
  const explainW = mainWidth - 4; // border + padding
  const hint = hunk && !showTests ? noTestHint(hunk, nameGuess?.testFile) : undefined;
  const untestedBranches = hi <= 0 ? chapter.untestedBranches : [];
  const testGapSummary = [hint ? 'No linked test' : '', untestedBranches.length ? `${untestedBranches.length} possible untested behavior${untestedBranches.length === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .join(' · ');
  const explainAll: GuideLine[] = [
    ...guideLines(narration, !!hunk?.narrationInferred, chapterNotes, explainW, tour.mode, !!hunk),
    ...(testGapSummary
      ? [
          [],
          line(truncate(`○ ${testGapSummary} · U: ${showUntested ? 'hide' : 'details'}`, explainW), { color: 'red' }),
          ...(showUntested
            ? [
                ...(hint ? wrap(safe(hint), explainW).map((t) => line(t, { dim: true })) : []),
                ...untestedBranches.flatMap((b) => wrap(safe(`Untested: ${b}`), explainW).map((t) => line(t, { color: 'yellow' }))),
              ]
            : []),
        ]
      : []),
  ];
  const codeNeed = collapsedView ? Math.min(chapter.hunkIds.length, 10) : Math.min((hunk?.lines.length ?? 0) + 1, 14);
  const explainMax = Math.max(4, Math.max(Math.floor(avail * 0.5), avail - codeNeed - 3) - 3);
  const explainLines = explainAll.length > explainMax ? [...explainAll.slice(0, explainMax - 1), line('… more than fits: widen or heighten the terminal', { dim: true })] : explainAll;
  const explainRows = explainLines.length ? explainLines.length + 3 : 0; // title + top/bottom border
  const bodyHeight = Math.max(6, avail - explainRows);
  const codeWidth = srcWidth;
  // The composer sits under the commented line, growing while its AI line is open. Its state is
  // ours, so it survives moving between the inline slot and the popup.
  const editAnchor = composer?.anchor ?? pending?.anchor;
  const lineComment = overlay === 'comment' && pending && editAnchor && isLineAnchor(editAnchor);
  const inlineSourceComment = lineComment && !testFocus;
  const inlineTestComment = lineComment && testFocus;
  const threadHeight = Math.min(Math.max(6, bodyHeight - 2), Math.max(8, Math.floor(bodyHeight * 0.7)));

  const overlayNode = (() => {
    if (overlay === 'diagram') {
      const g = chapter.diagram ?? tour.overview!;
      return (
        <DiagramView
          graph={g}
          width={mainWidth}
          height={height - 4}
          onClose={() => setOverlay('none')}
          onJump={(hid) => {
            const c = chapters.findIndex((ch) => ch.hunkIds.includes(hid));
            if (c >= 0) props.setPos(c, chapters[c].hunkIds.indexOf(hid));
            setOverlay('none');
          }}
          onComment={(nodeId) => openComposer(draft({ type: 'node', chapterId: chapter.id, nodeId }))}
        />
      );
    }
    if (overlay === 'comment' && pending && !inlineSourceComment && !inlineTestComment) return commentEditor(mainWidth, height - headerRows - footerRows);
    if (overlay === 'move') {
      return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>Move this hunk to…</Text>
          {chapters.map((c, i) => (
            <Text key={c.id} inverse={i === moveSel}>
              {truncate(`${c.title}`, mainWidth - 6)}
            </Text>
          ))}
          <Text dimColor>enter: move · esc: cancel</Text>
        </Box>
      );
    }
    if (overlay === 'checklist' && chapter.checklist && svc) {
      return <ChecklistPanel items={chapter.checklist} confirms={svc.confirms} width={mainWidth} onToggle={svc.setConfirm} onClose={() => setOverlay('none')} />;
    }
    return null;
  })();

  // The inline composer under a source or test line, `w` wide in a `pane` rows tall.
  const inlineComposer = (w: number, pane: number) => {
    const slot = inlineComposerSlot(composer, tour, pane, w);
    return { node: commentEditor(w, INLINE_ROWS, slot.aiRows, slot.listRows), height: slot.height };
  };

  function commentEditor(w: number, h: number, aiRows?: number, listRows?: number) {
    if (!pending || !composer) return null;
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
        onCancel={() => setOverlay('none')}
        onSave={saveDraft}
      />
    );
  }

  const askHeight = Math.min(14, Math.max(5, bodyHeight - 2));
  const askTestLine = testCodeLines[testCursor];
  const askContext = testFocus && hunk && testFile ? { ...hunk, file: testFile, header: selectedTest?.diffHunks?.[0]?.header ?? hunk.header, lines: testCodeLines } : hunk;
  const askPanel =
    overlay === 'ask' ? (
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
        width={testFocus ? testWidth - (sideBySide ? 3 : 1) : hunk ? codeWidth - 1 : mainWidth}
        height={askHeight}
        onClose={() => setOverlay('none')}
      />
    ) : null;

  // An open overlay owns the keyboard through its own useInput. One that renders nothing (its
  // hunk or thread went away) would leave no handler active, so close it. Mirrors where the
  // JSX below mounts each overlay.
  const sourcePaneShown = !collapsedView && !!hunk && (sideBySide || !testFocus || !showTests);
  const testPaneShown = !collapsedView && !!hunk && (sideBySide || (testFocus && showTests));
  const threadInline = (overlay === 'thread' || overlay === 'reply') && cursorThreads.length > 0;
  const overlayShown =
    overlay === 'help' ||
    (overlay === 'delete' && !!cursorDraft) ||
    overlayNode !== null ||
    (collapsedView && !!askPanel) ||
    (sourcePaneShown && (threadInline || !!inlineSourceComment || (!!askPanel && !testFocus))) ||
    (testPaneShown && (!!inlineTestComment || (testFocus && overlay === 'ask')));
  if (overlay !== 'none' && !overlayShown) setOverlay('none'); // React re-renders before committing

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
        {wide ? <ChapterList tour={tour} chapters={chapters} listed={listed} states={states} current={chapter.id} width={listWidth} height={height - headerRows - footerRows} /> : null}
        {wide ? <Box width={1} /> : null}
        <Box flexDirection="column" width={mainWidth}>
          {overlayNode ?? (
            <>
              <ChapterTitle chapter={chapter} hunk={hunk} hi={hi} isNew={!!hunk && delta.has(hunk.id)} unchanged={unchangedHunks} width={mainWidth} states={states} drawer={testDrawer} />
              {explainLines.length ? (
                <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor={hunk?.narrationInferred ? 'gray' : 'blue'} paddingX={1} width={mainWidth}>
                  <Text bold color={hunk?.narrationInferred ? 'gray' : 'blue'}>
                    {collapsedView ? 'About this chapter' : 'Explanation'}
                  </Text>
                  {explainLines.map((l, i) => (
                    <MdLineView key={i} line={l} />
                  ))}
                </Box>
              ) : null}
              {collapsedView ? (
                <>
                  <CollapsedSummary hunks={tour.hunks} files={filesByPath} chapter={chapter} states={states} sel={summarySel} width={mainWidth} height={bodyHeight - (askPanel ? askHeight : 0)} />
                  {askPanel}
                </>
              ) : hunk ? (
                <Box flexDirection={sideBySide ? 'row' : 'column'}>
                  {sideBySide || !testFocus || !showTests ? (
                    <SourcePane
                      inline={
                        threadInline
                          ? {
                              afterIdx: cursor,
                              node: (
                                <ThreadView
                                  threads={cursorThreads}
                                  width={codeWidth - 1}
                                  height={threadHeight}
                                  mentions={mentions}
                                  startReply={overlay === 'reply'}
                                  onReply={props.replyToThread}
                                  onReact={props.reactToComment}
                                  onClose={() => setOverlay('none')}
                                />
                              ),
                              height: threadHeight,
                            }
                          : inlineSourceComment
                            ? { afterIdx: sel[1], ...inlineComposer(codeWidth - 1, bodyHeight) }
                            : askPanel && !testFocus
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
                      width={codeWidth}
                      height={bodyHeight}
                    />
                  ) : null}
                  {sideBySide ? <Box width={1} /> : null}
                  {sideBySide ? (
                    <Box
                      flexDirection="column"
                      width={testWidth}
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
                        inline={inlineTestComment ? inlineComposer(testWidth - 3, bodyHeight - 1) : testFocus && overlay === 'ask' ? { node: askPanel, height: askHeight } : undefined}
                        width={testWidth - 2}
                        height={bodyHeight - 1}
                      />
                    </Box>
                  ) : testFocus && showTests ? (
                    <TestPane
                      tests={relevantTests}
                      covers={hunk.covers}
                      idx={testIdx}
                      cursor={testCursor}
                      scroll={testScroll}
                      setScroll={setTestScroll}
                      focused={testFocus}
                      inline={inlineTestComment ? inlineComposer(testWidth - 1, bodyHeight) : testFocus && overlay === 'ask' ? { node: askPanel, height: askHeight } : undefined}
                      width={testWidth}
                      height={bodyHeight}
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
      {overlay === 'delete' && cursorDraft ? (
        <Text color="yellow" wrap="truncate">
          {truncate(`Delete this draft? [${cursorDraft.label}] ${clean(cursorDraft.body).replace(/\s+/g, ' ')}`, width - 8)} y / n
        </Text>
      ) : (
        <DraftLine drafts={props.drafts} hunk={hunk} cursor={cursor} flash={flash} width={width} describe={describe} />
      )}
      <KeyBar
        width={width}
        status={overlay === 'none' && hunk && !testFocus ? [raw && 'raw', splitView && 'split', ignoreWhitespace && 'whitespace hidden'].filter(Boolean).join(' · ') : undefined}
        end={
          overlay !== 'none'
            ? []
            : testFocus
              ? [
                  ['t/esc', 'back to code'],
                  ['b', 'briefing'],
                ]
              : [...((tour.rereview ? [['D', props.deltaOnly ? 'full review' : 'changes only']] : []) as [string, string][]), ['b', 'briefing'], ['h', 'all keys']]
        }
        keys={overlay !== 'none' ? [] : barKeys()}
      />
    </Box>
  );
  // Help floats over the screen, which stays visible around it.
  if (overlay === 'help')
    return (
      <ReviewPopup background={screen} width={width} height={height} maxWidth={HELP_WIDTH} maxHeight={HELP_ROWS.length + 4}>
        {(w, h) => <Help width={w} height={h} ai={!!props.agent} />}
      </ReviewPopup>
    );
  return screen;
}
