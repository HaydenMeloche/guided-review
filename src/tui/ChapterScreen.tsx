import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useInput } from 'ink';
import { Box, Text } from './themed.js';
import type { Chapter, ChapterOrder, DiffFile, DiffLine, Draft, DraftAnchor, ExistingThread, Hunk, ReactionContent, ReadState, ThreadComment, Tour } from '../types.js';
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
  const [overlay, setOverlay] = useState<Overlay>(NONE);
  const close = () => setOverlay(NONE);
  const show = (kind: Exclude<OverlayKind, 'none' | 'comment' | 'move'>) => setOverlay({ kind });
  const [summarySel, setSummarySel] = useState(0);
  const [flash, setFlash] = useState('');
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
        if (input === '?') return show('ask');
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
        return show('reply');
      }
      if (input === 'e' && hunk) {
        if (!cursorThreads.length) return setFlash('No review thread on this line. Move to a commented line and press e.');
        return show('thread');
      }
      if (input === 'E' && hunk) {
        if (!cursorDraft) return setFlash('No draft on this line. Move to a line with ✎ and press E.');
        return openComposer(cursorDraft);
      }
      if (input === 'X' && hunk) {
        if (!cursorDraft) return setFlash('No draft on this line. Move to a line with ✎ and press X.');
        return show('delete');
      }
      if (input === 'C' && chapter) return openComposer(draft({ type: 'chapter', chapterId: chapter.id }));
      if (input === '?') {
        if (hunk && cursorLine?.newLine !== undefined) noteRecent.current?.({ path: hunk.file, line: cursorLine.newLine, why: 'ask' });
        return collapsedView || hunk ? show('ask') : setFlash('Nothing to ask about here.');
      }
      if (input === 'd') return chapter?.diagram || tour.overview ? show('diagram') : setFlash('No diagram for this chapter.');
      if (input === 'm' && hunk) return setOverlay({ kind: 'move', sel: ci });
      if (input === 'f') return props.toggleOrder();
      if (input === 'D' && tour.rereview) return props.toggleDelta();
      if (input === 'R' && props.rebase) return props.rebase();
      if (input === 'o') return props.openInAgent(hunk, chapter);
      if (input === 's') return props.openSubmit();
      if (input === 'h') return show('help');
      if (input === 'i') {
        if (!chapter?.checklist?.length) return setFlash('No team checklist applies to this chapter (.guided-review.json → checklists).');
        return svc ? show('checklist') : setFlash('The checklist opens once the checkout is ready.');
      }
      if (input === 'L' && props.onTheme) return props.onTheme();
      if (input === 'q') return (props.back ?? props.quit)();
      if (input === 'Q') return props.quit();
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
      ...(hasLinkedTests ? ([['t', 'tests']] as [string, string][]) : []),
      ...(chapter?.diagram || tour.overview ? ([['d', 'diagram']] as [string, string][]) : []),
      ['x', 'skip'],
      ['+/-', 'context'],
      ['S', splitView ? 'inline' : 'split'],
    ];
  };

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
        keys={overlay.kind !== 'none' ? [] : barKeys()}
      />
    </Box>
  );
  // Help floats over the screen, which stays visible around it.
  if (overlay.kind === 'help')
    return (
      <ReviewPopup background={screen} width={width} height={height} maxWidth={HELP_WIDTH} maxHeight={HELP_ROWS.length + 4}>
        {(w, h) => <Help width={w} height={h} ai={!!props.agent} />}
      </ReviewPopup>
    );
  return screen;
}
