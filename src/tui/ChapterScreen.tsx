import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Chapter, ChapterOrder, DiffFile, DiffLine, Draft, DraftAnchor, ExistingThread, Hunk, ReactionContent, ReadState, TestLink, ThreadComment, Tour } from '../types.js';
import { MdLineView, line, renderMarkdown, restyle, type MdLine } from './markdown.js';
import { ChecklistPanel } from './Panels.js';
import { changedLineCount, chapterState, ORDER_LABEL, pad, progress, riskMark, stateMark, stateOf, truncate, wrap, type States } from './nav.js';
import { DiagramView } from './DiagramView.js';
import { CommentEditor, LABEL_COLOR, type SetComposer } from './CommentEditor.js';
import { INLINE_ROWS, inlineComposerSlot } from './AiSuggestion.js';
import { ThreadView } from './ThreadView.js';
import { AskOverlay } from './AskOverlay.js';
import { highlightDiffLines, highlightSourceLines, type HunkHighlights, type SyntaxSpan } from './highlight.js';
import { highlightHunkCached, hunkHighlightKey, peekHunkHighlights } from './highlightCache.js';
import { codePaneWidths, MIN_SPLIT_WIDTH } from './paneWidths.js';
import { ReviewPopup } from './ReviewPopup.js';
import type { AgentContext } from '../agent/types.js';
import { sanitizeTerminal } from '../util/sanitize.js';
import { foldedLines, pairChangedLines, wordDiff, type CharRange, type Fold } from '../diff/lines.js';
import { isSpecialKind } from '../analysis/special.js';
import { safeReadFile } from '../analysis/safeRead.js';
import { fileLines, headFor, withContext } from '../diff/context.js';
import { KeyBar } from './KeyBar.js';
import { initComposer, isLineAnchor, sameAnchor, type ComposerEnv, type ComposerState, type ReferenceServices } from './composer.js';
import { generateSuggestion } from '../agent/suggest.js';

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

const clean = (s: string) => sanitizeTerminal(s.replace(/\t/g, '  '));
const safe = sanitizeTerminal;
const codeChunks = (text: string, width: number) => {
  const code = clean(text);
  const size = Math.max(1, width);
  return code.match(new RegExp(`.{1,${size}}`, 'g')) ?? [''];
};

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

const COVERAGE = {
  tested: { mark: '●', color: 'green', text: 'tested' },
  partial: { mark: '◐', color: 'yellow', text: 'partly tested' },
  untested: { mark: '○', color: 'red', text: 'untested' },
  'n/a': { mark: ' ', color: 'gray', text: '' },
} as const;

const LINK_TEXT = { coverage: 'coverage run', 'name-match': 'name match', naming: 'naming guess' } as const;

export function ChapterScreen(props: {
  tour: Tour;
  chapters: Chapter[];
  states: States;
  drafts: Draft[];
  ci: number;
  hi: number;
  order: ChapterOrder;
  deltaOnly: boolean;
  banner?: string;
  agent?: AgentCtx;
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
  openInClaude: (h: Hunk | undefined, chapter: Chapter) => void;
  rebase?: () => void;
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
  const chapterStrip = useMemo(() => (wide ? '' : chapters.map((c, i) => (i === ci ? `[${c.title}]` : stateMark(chapterState(tour, c, states)).mark)).join(' ')), [wide, chapters, ci, tour, states]);

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

  const selRange = (): [number, number] => {
    if (anchor === null) return [cursor, cursor];
    return [Math.min(anchor, cursor), Math.max(anchor, cursor)];
  };

  const newDraft = (a: DraftAnchor): Draft => ({
    id: `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    repo: tour.repo,
    pr: tour.pr,
    headSha: tour.headSha,
    anchor: a,
    label: 'question',
    body: '',
    posted: false,
    createdAt: new Date().toISOString(),
  });

  // The selected lines a comment can attach to: expanded context at the ends is left out.
  const anchorLines = (h: Hunk): DiffLine[] => {
    const [a, b] = selRange();
    return h.lines.slice(a, b + 1).filter((l) => !l.expanded);
  };
  // A selection with expanded context between commentable lines spans two of GitHub's hunks,
  // which GitHub will not take one comment across.
  const crossesContext = (h: Hunk): boolean => {
    const [a, b] = selRange();
    const sel = h.lines.slice(a, b + 1);
    const first = sel.findIndex((l) => !l.expanded);
    const last = sel.findLastIndex((l) => !l.expanded);
    return first >= 0 && sel.slice(first, last + 1).some((l) => l.expanded);
  };
  // The code under the selection, prefilled as a suggestion: exactly the lines it replaces.
  const selectedCode = (): string | undefined =>
    testFocus
      ? testCodeLines[testCursor]?.text
      : hunk
        ? anchorLines(hunk)
            .filter((l) => l.kind !== 'del')
            .map((l) => l.text)
            .join('\n')
        : undefined;

  const lineAnchor = (h: Hunk): DraftAnchor | undefined => {
    const lines = anchorLines(h);
    const right = lines.filter((l) => l.newLine !== undefined && l.kind !== 'del');
    const side: 'LEFT' | 'RIGHT' = right.length ? 'RIGHT' : 'LEFT';
    const nums = side === 'RIGHT' ? right.map((l) => l.newLine!) : lines.map((l) => l.oldLine!).filter((n) => n !== undefined);
    if (!nums.length) return undefined;
    const start = Math.min(...nums);
    const end = Math.max(...nums);
    return start === end ? { type: 'line', hunkId: h.id, file: h.file, line: end, side } : { type: 'range', hunkId: h.id, file: h.file, startLine: start, line: end, side };
  };

  const saveDraft = (d: Draft) => {
    const edited = props.drafts.some((x) => x.id === d.id);
    props.saveDraft(d);
    setAnchor(null);
    setOverlay('none');
    setComposer(undefined);
    setFlash(`Draft ${edited ? 'updated' : 'saved'} (${d.label}). Nothing posts until you submit.`);
  };

  const describeAnchor = (d: Draft): string => {
    const a = d.anchor;
    if (a.type === 'line') return `${a.file}:${a.line}`;
    if (a.type === 'range') return `${a.file}:${a.startLine}-${a.line}`;
    if (a.type === 'chapter') return `flow "${chapters.find((c) => c.id === a.chapterId)?.title ?? a.chapterId}"`;
    return `diagram node "${chapter?.diagram?.nodes.find((n) => n.id === a.nodeId)?.label ?? a.nodeId}"`;
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
          const line = testCodeLines[testCursor];
          const side = line?.kind === 'del' ? 'LEFT' : 'RIGHT';
          const lineNo = side === 'LEFT' ? line?.oldLine : line?.newLine;
          const target = Object.values(tour.hunks).find(
            (candidate) =>
              candidate.file === testFile && candidate.lines.some((l) => !l.expanded && (side === 'LEFT' ? l.kind !== 'add' && l.oldLine === lineNo : l.kind !== 'del' && l.newLine === lineNo)),
          );
          if (!target || lineNo === undefined || !testFile) return setFlash('This test line is outside the PR diff, so GitHub cannot attach a line comment.');
          return openComposer(newDraft({ type: 'line', hunkId: target.id, file: testFile, line: lineNo, side }));
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
        if (crossesContext(hunk)) return setFlash('This range crosses dimmed lines outside the PR’s diff: GitHub can’t take one comment across them. Select one side.');
        const a = lineAnchor(hunk);
        if (!a && anchorLines(hunk).length === 0) return setFlash('This is context outside the PR’s diff: GitHub can’t take a comment on it.');
        if (!a) return setFlash('Nothing to anchor a comment to here.');
        return openComposer(newDraft(a));
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
      if (input === 'C' && chapter) return openComposer(newDraft({ type: 'chapter', chapterId: chapter.id }));
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
      if (input === 'o') return props.openInClaude(hunk, chapter);
      if (input === 's') return props.openSubmit();
      if (input === 'h') return setOverlay('help');
      if (input === 'i') {
        if (!chapter?.checklist?.length) return setFlash('No team checklist applies to this chapter (.guided-review.json → checklists).');
        return svc ? setOverlay('checklist') : setFlash('The checklist opens once the checkout is ready.');
      }
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
    if (testFocus)
      return [
        ['n/p', 'test'],
        ['c', 'comment'],
        ['?', 'ask'],
      ];
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
      ['?', 'ask'],
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
  // The hunk row shows only marks; the reasons behind them read here, in full.
  if (hunk && hunk.risk >= 2 && hunk.riskReasons.length) chapterNotes.push(`Risk: ${hunk.riskReasons.join('; ')}`);
  if (hunk && chapter.orphanReasons[hunk.id]) chapterNotes.push(`Why it is here: ${chapter.orphanReasons[hunk.id]}`);

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
          onComment={(nodeId) => openComposer(newDraft({ type: 'node', chapterId: chapter.id, nodeId }))}
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
        target={safe(describeAnchor({ ...pending, anchor: a }))}
        hunk={isLineAnchor(a) ? tour.hunks[a.hunkId] : hunk}
        selectedText={sameAnchor(a, pending.anchor) ? selectedCode() : undefined}
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
        lineIdx={testFocus ? testCursor : hunk ? selRange()[0] : undefined}
        endIdx={testFocus ? testCursor : hunk ? selRange()[1] : undefined}
        target={
          testFocus && testFile
            ? `${testFile}:${askTestLine?.newLine ?? askTestLine?.oldLine ?? ''}`
            : hunk
              ? `${hunk.file}:${hunk.lines[selRange()[0]]?.newLine ?? hunk.lines[selRange()[0]]?.oldLine ?? ''}`
              : `chapter "${chapter.title}"`
        }
        agent={props.agent}
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
        {wide ? <ChapterList tour={tour} chapters={chapters} states={states} ci={ci} width={listWidth} height={height - headerRows - footerRows} /> : null}
        {wide ? <Box width={1} /> : null}
        <Box flexDirection="column" width={mainWidth}>
          {overlayNode ?? (
            <>
              <ChapterTitle chapter={chapter} hunk={hunk} hi={hi} isNew={!!hunk && delta.has(hunk.id)} width={mainWidth} states={states} drawer={testDrawer} />
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
                            ? { afterIdx: selRange()[1], ...inlineComposer(codeWidth - 1, bodyHeight) }
                            : askPanel && !testFocus
                              ? { afterIdx: selRange()[1], node: askPanel, height: askHeight }
                              : undefined
                      }
                      hunk={hunk}
                      cursor={cursor}
                      range={anchor !== null ? selRange() : null}
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
        <DraftLine drafts={props.drafts} hunk={hunk} cursor={cursor} flash={flash} width={width} describe={describeAnchor} />
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
              : [
                  ['b', 'briefing'],
                  ['h', 'all keys'],
                ]
        }
        keys={overlay !== 'none' ? [] : barKeys()}
      />
    </Box>
  );
  // Help floats over the screen, which stays visible around it.
  if (overlay === 'help')
    return (
      <ReviewPopup background={screen} width={width} height={height} maxWidth={HELP_WIDTH} maxHeight={HELP_ROWS.length + 4}>
        {(w, h) => <Help width={w} height={h} />}
      </ReviewPopup>
    );
  return screen;
}

// ---------- pieces ----------

const Header = React.memo(function Header(props: { tour: Tour; prog: ReturnType<typeof progress>; order: ChapterOrder; deltaOnly: boolean; width: number }) {
  const { tour, prog, width } = props;
  const barW = 16;
  const filled = prog.totalLines ? Math.round((prog.readLines / prog.totalLines) * barW) : barW;
  const meter = '█'.repeat(filled) + '░'.repeat(barW - filled);
  const right = `${meter} ${prog.readLines}/${prog.totalLines} lines · ${prog.read + prog.skipped}/${prog.total} hunks${props.deltaOnly ? ' · delta' : ''} · ${ORDER_LABEL[props.order]} order`;
  const repo = `${safe(tour.repo)} `;
  const left = `#${tour.pr} ${safe(tour.title)}`;
  return (
    <Text wrap="truncate">
      <Text color="cyan" bold>
        {repo}
      </Text>
      <Text bold>{pad(left, Math.max(10, width - right.length - repo.length - 1))}</Text> <Text color="green">{meter}</Text>
      <Text dimColor>{right.slice(barW)}</Text>
    </Text>
  );
});

const ChapterList = React.memo(function ChapterList(props: { tour: Tour; chapters: Chapter[]; states: States; ci: number; width: number; height: number }) {
  const { tour, chapters, states, ci, width } = props;
  const start = Math.max(0, Math.min(ci - Math.floor(props.height / 2), chapters.length - props.height));
  return (
    <Box flexDirection="column" width={width}>
      {chapters.slice(start, start + props.height).map((c, k) => {
        const i = start + k;
        const st = stateMark(chapterState(tour, c, states));
        const rk = riskMark(Math.max(0, ...c.hunkIds.map((id) => tour.hunks[id]?.risk ?? 0)));
        const p = progress(tour, states, c.hunkIds);
        return (
          <Text key={c.id} inverse={i === ci} dimColor={c.collapsed && i !== ci}>
            <Text color={st.color}>{st.mark}</Text>
            <Text color={rk.color}>{rk.mark}</Text> {pad(safe(c.title), width - 9)}
            <Text dimColor>{c.optional ? ' opt ' : `${String(p.read + p.skipped).padStart(2)}/${String(p.total).padEnd(2)}`}</Text>
          </Text>
        );
      })}
    </Box>
  );
});

// `drawer`: a hint at the right end of the title row for linked tests that are not on screen.
const ChapterTitle = React.memo(function ChapterTitle(props: { chapter: Chapter; hunk?: Hunk; hi: number; isNew: boolean; width: number; states: States; drawer?: string }) {
  const { chapter, hunk, hi } = props;
  const cov = hunk ? COVERAGE[hunk.coverage] : undefined;
  const st = hunk ? stateMark(stateOf(props.states, hunk)) : undefined;
  // A deleted file's hunk has no new lines: point at where it was.
  const location = hunk ? `${hunk.file}:${hunk.newStart || hunk.oldStart}` : '';
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box width={props.width}>
        <Box flexShrink={1} flexGrow={1}>
          <Text wrap="truncate">
            <Text bold color="cyan">
              {truncate(safe(chapter.title), Math.floor(props.width * 0.6))}
            </Text>
            {chapter.entryPoint ? <Text dimColor> · entry {safe(chapter.entryPoint)}</Text> : null}
            {hunk ? (
              <Text dimColor>
                {' '}
                · hunk {hi + 1}/{chapter.hunkIds.length}
              </Text>
            ) : null}
          </Text>
        </Box>
        {props.drawer ? (
          <Box flexShrink={0}>
            <Text color="cyan">
              {` ${props.drawer} · `}
              <Text bold>t</Text>
            </Text>
          </Box>
        ) : null}
      </Box>
      {hunk ? (
        <Text wrap="truncate">
          {st ? <Text color={st.color}>{st.mark} </Text> : null}
          {props.isNew ? (
            <Text color="black" backgroundColor="yellow">
              {' '}
              NEW{' '}
            </Text>
          ) : null}
          <Text> {safe(location)}</Text>
          {cov && cov.text ? (
            <Text color={cov.color}>
              {'  '}
              {cov.mark} {cov.text}
            </Text>
          ) : null}
          {hunk.importOnly ? <Text dimColor> · imports only · optional</Text> : null}
        </Text>
      ) : (
        <Text dimColor>{chapter.collapsed ? `${chapter.hunkIds.length} hunk(s), collapsed${chapter.optional ? ' · optional: not counted toward progress' : ''}` : ''}</Text>
      )}
    </Box>
  );
});

function threadAt(threads: ExistingThread[], file: string, line?: number, side: 'LEFT' | 'RIGHT' = 'RIGHT') {
  if (line === undefined) return [];
  return threads.filter((t) => t.path === file && (side === 'LEFT' ? t.isOutdated && t.originalLine === line : t.line === line || (t.line === undefined && !t.isOutdated && t.originalLine === line)));
}

// Under the last line of a block moved within the PR: where the block was, or went, and how.
function movedNote(hunk: Hunk, j: number): string | undefined {
  const l = hunk.lines[j];
  // Lines k and k + 1 are one block when both moved, alike, to consecutive lines of one file.
  const joined = (k: number) => {
    const [a, b] = [hunk.lines[k]?.moved, hunk.lines[k + 1]?.moved];
    return !!a && !!b && hunk.lines[k].kind === hunk.lines[k + 1].kind && a.file === b.file && b.line === a.line + 1 && a.kind === b.kind && a.indent === b.indent;
  };
  if (!l.moved || joined(j)) return undefined;
  let first = j;
  while (joined(first - 1)) first--;
  const at = hunk.lines[first].moved!;
  const where = (p: { file: string; line: number }) => (p.file === hunk.file ? `line ${p.line}` : `${safe(p.file)}:${p.line}`);
  const lines = `${j - first + 1} line${j === first ? '' : 's'}`;
  const indent = at.indent ? `indent ${at.indent > 0 ? '+' : '−'}${Math.abs(at.indent)}` : '';
  if (at.kind === 'reindented') return `↔ ${lines} re-indented in place${indent ? ` (${indent})` : ''}, ${l.kind === 'del' ? 'now' : 'was'} ${where(at)}`;
  const also = (side: 'add' | 'del') => {
    const places = at.also.filter((p) => p.side === side);
    if (!places.length) return '';
    const shown = places.slice(0, 2).map(where).join(', ');
    return `; also ${side === 'add' ? 'added' : 'removed'} at ${shown}${places.length > 2 ? ` and ${places.length - 2} more` : ''}`;
  };
  return `↕ ${lines} ${at.kind} ${l.kind === 'del' ? 'to' : 'from'} ${where(at)}${indent ? `, ${indent}` : ''}${also('add')}${also('del')}`;
}

function draftsAt(drafts: Draft[], hunk: Hunk, line?: number, side: 'LEFT' | 'RIGHT' = 'RIGHT') {
  if (line === undefined) return [];
  return drafts.filter((d) => (d.anchor.type === 'line' || d.anchor.type === 'range') && d.anchor.file === hunk.file && d.anchor.line === line && d.anchor.side === side);
}

// Syntax colors, plus a background on the `emphasis` ranges (the words a changed line changed).
// Span and range offsets are into the whole line; `column` is where this chunk of it starts.
function SyntaxText(props: { text: string; spans?: SyntaxSpan[]; column?: number; emphasis?: CharRange[]; emphasisColor?: string }) {
  const { text } = props;
  const column = props.column ?? 0;
  const clip = (x: number) => Math.max(0, Math.min(text.length, x - column));
  const spans = (props.spans ?? []).map((s) => ({ start: clip(s.start), end: clip(s.end), color: s.color })).filter((s) => s.end > s.start);
  const emphasis = (props.emphasis ?? []).map(([s, e]) => [clip(s), clip(e)]).filter(([s, e]) => e > s);
  const cuts = [...new Set([0, text.length, ...spans.flatMap((s) => [s.start, s.end]), ...emphasis.flat()])].sort((a, b) => a - b);
  const parts: React.ReactNode[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const [start, end] = [cuts[k], cuts[k + 1]];
    const color = spans.find((s) => s.start <= start && end <= s.end)?.color;
    const backgroundColor = emphasis.some(([s, e]) => s <= start && end <= e) ? props.emphasisColor : undefined;
    parts.push(
      <Text key={start} color={color} backgroundColor={backgroundColor}>
        {text.slice(start, end)}
      </Text>,
    );
  }
  return <Text>{parts}</Text>;
}

const DIFF_BACKGROUND = { add: '#173B2A', del: '#42262C', ctx: undefined } as const;
const WORD_BACKGROUND = { add: '#2B6B47', del: '#7A3442', ctx: undefined } as const;

const SourcePane = React.memo(function SourcePane(props: {
  inline?: { afterIdx: number; node: React.ReactNode; height: number }; // comment editor under the selected line
  hunk: Hunk;
  cursor: number;
  range: [number, number] | null;
  raw: boolean;
  split: boolean; // old and new side by side
  partner: number[]; // pairChangedLines(hunk.lines)
  hidden: ReadonlyMap<number, Fold>; // removed lines folded into their replacement (foldedLines)
  ignoreWhitespace: boolean;
  scroll: number;
  setScroll: (n: number) => void;
  threads: ExistingThread[];
  drafts: Draft[];
  root?: string;
  headSha: string;
  baseSha: string;
  width: number;
  height: number;
}) {
  const { hunk, cursor, range, width, height } = props;
  // Highlights depend on the hunk's identity and the shas, not on the hunk object: a tour
  // update hands every hunk a new object, and that must not re-read and re-tokenize the file.
  const request = { hunk, root: props.root, headSha: props.headSha, baseSha: props.baseSha };
  const key = hunkHighlightKey(request);
  const [state, setState] = useState<{ key: string; value?: HunkHighlights }>(() => ({ key, value: peekHunkHighlights(request)?.value }));
  const cached = state.key === key ? undefined : peekHunkHighlights(request);
  if (cached && state.key !== key) setState({ key, value: cached.value });
  const highlights = state.key === key ? state.value : undefined;
  const latest = React.useRef(request);
  latest.current = request;
  useEffect(() => {
    let active = true;
    // The previous highlight stays on screen until the new one arrives.
    void highlightHunkCached(latest.current)
      .catch(() => undefined)
      .then((value) => {
        if (active) setState((s) => (s.key === key && s.value === value ? s : { key, value }));
      });
    return () => {
      active = false;
    };
  }, [key]);
  // The changed words of each paired line, as ranges into its displayed (cleaned) text.
  const words = useMemo(() => {
    const out: (CharRange[] | undefined)[] = [];
    props.partner.forEach((p, i) => {
      if (p < i || hunk.lines[i].kind !== 'del') return;
      const diff = wordDiff(clean(hunk.lines[i].text), clean(hunk.lines[p].text));
      out[i] = diff?.a;
      out[p] = diff?.b;
    });
    return out;
  }, [hunk, props.partner]);
  const rows = useMemo(() => {
    const out: { idx: number; node: React.ReactNode }[] = [];
    if (props.raw) {
      out.push({ idx: -1, node: <Text color="cyan">{truncate(hunk.header, width)}</Text> });
      hunk.lines.forEach((l, i) => {
        const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
        codeChunks(l.text, width - 2).forEach((code, part) => {
          out.push({
            idx: i,
            node: (
              <Text backgroundColor={DIFF_BACKGROUND[l.kind]}>
                <Text color={l.kind === 'add' ? 'green' : l.kind === 'del' ? 'red' : undefined}>{part === 0 ? sign : ' '}</Text>
                {code}
              </Text>
            ),
          });
        });
      });
      return out;
    }
    const reindentedOnly = (l: DiffLine, i: number) => l.kind === 'ctx' || props.hidden.get(i) === 'whitespace' || props.hidden.get(props.partner[i]) === 'whitespace';
    if (props.ignoreWhitespace && hunk.lines.every(reindentedOnly)) out.push({ idx: -1, node: <Text dimColor>{truncate('  whitespace-only changes hidden · w to show', width)}</Text> });
    // Review threads, drafts and a moved block's origin under line j, on rows of line i.
    const notesUnder = (j: number, i: number) => {
      const l = hunk.lines[j];
      const line = l.kind === 'del' ? l.oldLine : l.newLine;
      const threads = threadAt(props.threads, hunk.file, line, l.kind === 'del' ? 'LEFT' : 'RIGHT');
      if (threads.length)
        out.push({
          idx: i,
          node: (
            <Text color="cyan">
              {truncate(`         ┊ ${threads.length} review ${threads.length === 1 ? 'thread' : 'threads'} · ${threads.reduce((n, t) => n + t.comments.length, 0)} comments · e to read`, width)}
            </Text>
          ),
        });
      for (const d of draftsAt(props.drafts, hunk, line, l.kind === 'del' ? 'LEFT' : 'RIGHT')) {
        out.push({
          idx: i,
          node: <Text color={LABEL_COLOR[d.label]}>{truncate(`         ✎ [${d.label}]${d.posted ? ' (posted)' : ''} ${clean(d.body).replace(/\s+/g, ' ')}`, width)}</Text>,
        });
      }
      const moved = movedNote(hunk, j);
      if (moved) out.push({ idx: i, node: <Text color="magenta">{truncate(`         ${moved}`, width)}</Text> });
    };
    if (props.split) {
      // Old on the left, new on the right; a removed line shares its replacement's row.
      const half = Math.max(8, Math.floor((width - 2) / 2));
      const codeW = Math.max(1, half - 6);
      const cells = (j: number | undefined, side: 'old' | 'new'): React.ReactNode[] => {
        if (j === undefined) return [];
        const l = hunk.lines[j];
        const reindented = props.hidden.get(l.kind === 'del' ? j : props.partner[j]) === 'whitespace' && l.kind !== 'ctx';
        const no = `${(side === 'old' ? l.oldLine : l.newLine) ?? ''}`.padStart(4);
        const sign = reindented ? '~' : l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
        const color = reindented ? undefined : l.kind === 'add' ? 'green' : l.kind === 'del' ? 'red' : undefined;
        const text = clean(l.text);
        const emphasis = reindented || l.kind === 'ctx' ? undefined : words[j]?.filter(([s, e]) => !props.ignoreWhitespace || text.slice(s, e).trim());
        return codeChunks(l.text, codeW).map((code, part) => (
          <Text key={`${side}${part}`} backgroundColor={reindented ? undefined : DIFF_BACKGROUND[l.kind]} dimColor={l.expanded}>
            <Text dimColor>{part === 0 ? no : '    '} </Text>
            <Text color={color} dimColor={reindented}>
              {part === 0 ? sign : ' '}
            </Text>
            <SyntaxText text={code} spans={highlights?.[j]} column={part * codeW} emphasis={emphasis} emphasisColor={WORD_BACKGROUND[l.kind]} />
            {' '.repeat(Math.max(0, codeW - code.length))}
          </Text>
        ));
      };
      const blank = ' '.repeat(half);
      hunk.lines.forEach((l, i) => {
        if (props.hidden.has(i)) return;
        const beside = l.kind === 'add' && props.hidden.has(props.partner[i]) ? props.partner[i] : undefined;
        const left = cells(l.kind === 'add' ? beside : i, 'old');
        const right = cells(l.kind === 'del' ? undefined : i, 'new');
        for (let k = 0; k < Math.max(left.length, right.length); k++)
          out.push({
            idx: i,
            node: (
              <Text>
                {left[k] ?? blank}
                <Text dimColor>│</Text>
                {right[k] ?? blank}
              </Text>
            ),
          });
        if (beside !== undefined) notesUnder(beside, i);
        notesUnder(i, i);
      });
      return out;
    }
    hunk.lines.forEach((l, i) => {
      if (props.hidden.has(i)) return;
      // An added line whose removed partner is folded into it shows once, on a plain background:
      // marked ~ when only whitespace changed, or + with just the added words in green.
      const fold = props.hidden.get(props.partner[i]);
      const reindented = fold === 'whitespace';
      const kind = fold ? 'ctx' : l.kind;
      const no = `${(fold ? hunk.lines[props.partner[i]].oldLine : l.oldLine) ?? ''}`.padStart(4) + ' ' + `${l.newLine ?? ''}`.padStart(4);
      const sign = reindented ? '~' : l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
      const color = reindented ? undefined : l.kind === 'add' ? 'green' : l.kind === 'del' ? 'red' : undefined;
      const text = clean(l.text);
      const emphasis = reindented || l.kind === 'ctx' ? undefined : words[i]?.filter(([s, e]) => !props.ignoreWhitespace || text.slice(s, e).trim());
      codeChunks(l.text, width - 12).forEach((code, part) =>
        out.push({
          idx: i,
          node: (
            <Text backgroundColor={DIFF_BACKGROUND[kind]} dimColor={l.expanded}>
              <Text dimColor>{part === 0 ? no : ' '.repeat(9)} </Text>
              <Text color={color} dimColor={reindented}>
                {part === 0 ? sign : ' '}
              </Text>
              <SyntaxText text={code} spans={highlights?.[i]} column={part * Math.max(1, width - 12)} emphasis={emphasis} emphasisColor={WORD_BACKGROUND[l.kind]} />
            </Text>
          ),
        }),
      );
      notesUnder(i, i);
    });
    return out;
  }, [hunk, props.raw, props.split, props.partner, props.hidden, props.ignoreWhitespace, words, props.threads, props.drafts, width, highlights]);

  // Keep the cursor in view.
  const cursorRow = rows.findIndex((r) => r.idx === cursor);
  const cursorEnd = rows.findLastIndex((r) => r.idx === cursor);
  let top = props.scroll;
  if (cursorRow < top) top = cursorRow;
  if (cursorEnd >= top + height) top = cursorEnd - height + 1;
  top = Math.max(0, Math.min(top, Math.max(0, rows.length - height)));
  useEffect(() => {
    if (top !== props.scroll) props.setScroll(top);
  });

  const renderRow = (r: (typeof rows)[number], k: number) => {
    const inRange = range && r.idx >= range[0] && r.idx <= range[1];
    const first = rows[k - 1]?.idx !== r.idx;
    const isCursor = r.idx === cursor && first;
    return (
      <Box key={k}>
        <Text color={isCursor ? 'cyan' : inRange ? 'blue' : undefined}>{isCursor ? '▶' : inRange ? '┃' : ' '}</Text>
        {r.node}
      </Box>
    );
  };

  if (props.inline) {
    // Keep the commented line(s) in view with some context above, the editor right under them.
    const avail = Math.max(2, height - props.inline.height);
    const anchorRow = rows.reduce((last, r, i) => (r.idx <= props.inline!.afterIdx ? i : last), 0);
    const start = Math.max(0, anchorRow - Math.max(1, Math.floor(avail * 0.6)) + 1);
    const before = rows.slice(start, anchorRow + 1).map((r, k) => renderRow(r, start + k));
    const after = rows.slice(anchorRow + 1, anchorRow + 1 + Math.max(0, avail - before.length)).map((r, k) => renderRow(r, anchorRow + 1 + k));
    return (
      <Box flexDirection="column" width={width} flexShrink={0} height={height} overflow="hidden">
        {before}
        <Box flexShrink={0} paddingLeft={1}>
          {props.inline.node}
        </Box>
        {after}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} flexShrink={0} height={height} overflow="hidden">
      {rows.slice(top, top + height).map((r, k) => renderRow(r, top + k))}
      {rows.length > top + height ? <Text dimColor>{`  … ${rows.length - top - height} more`}</Text> : null}
    </Box>
  );
});

function TestPane(props: {
  tests: TestLink[];
  covers?: Hunk['covers'];
  idx: number;
  cursor: number;
  scroll: number;
  setScroll: (n: number) => void;
  focused: boolean;
  inline?: { node: React.ReactNode; height: number };
  width: number;
  height: number;
}) {
  const { width, height } = props;
  const covers = props.covers;
  const selected = covers ?? props.tests[props.idx];
  const [highlights, setHighlights] = useState<HunkHighlights>();
  const [diffHighlights, setDiffHighlights] = useState<(HunkHighlights | undefined)[]>();
  // Keyed on the test's file and text, so a tour update with the same test code keeps its highlight.
  const testFileName = covers?.file ?? props.tests[props.idx]?.testFile;
  const highlightKey = selected
    ? `${testFileName}\0${'diffHunks' in selected && selected.diffHunks?.length ? selected.diffHunks.map((d) => d.lines.map((l) => l.kind + l.text).join('\n')).join('\0') : selected.lines.join('\n')}`
    : '';
  const latest = React.useRef({ selected, file: testFileName });
  latest.current = { selected, file: testFileName };
  useEffect(() => {
    let active = true;
    setHighlights(undefined);
    setDiffHighlights(undefined);
    const { selected, file } = latest.current;
    if (selected && file) {
      if ('diffHunks' in selected && selected.diffHunks?.length) {
        void Promise.all(selected.diffHunks.map((diff) => highlightDiffLines(file, diff.lines))).then((result) => {
          if (active) setDiffHighlights(result);
        });
      } else {
        void highlightSourceLines(file, selected.lines).then((result) => {
          if (active) setHighlights(result);
        });
      }
    }
    return () => {
      active = false;
    };
  }, [highlightKey]);
  const lines: React.ReactNode[] = [];
  let codeIndex = 0;
  let cursorRow = -1;
  const marker = () => {
    const selected = props.focused && codeIndex === props.cursor;
    if (selected) cursorRow = lines.length;
    codeIndex++;
    return <Text color={selected ? 'cyan' : undefined}>{selected ? '▶' : ' '}</Text>;
  };
  if (covers) {
    lines.push(
      <Text key="h" bold>
        {truncate(`Covers (unchanged): ${covers.file}${covers.symbol ? ` › ${covers.symbol}` : ''}`, width)}
      </Text>,
    );
    covers.lines.forEach((l, i) => {
      const caret = marker();
      codeChunks(l, width - 6).forEach((code, part) =>
        lines.push(
          <Text key={`c${i}_${part}`}>
            {part === 0 ? caret : ' '}
            <Text dimColor>{part === 0 ? String(covers.startLine + i).padStart(4) : ' '.repeat(4)} </Text>
            <SyntaxText text={code} spans={highlights?.[i]} column={part * Math.max(1, width - 6)} />
          </Text>,
        ),
      );
    });
  } else {
    props.tests.forEach((t: TestLink, ti) => {
      const active = ti === props.idx;
      const guess = t.source === 'naming';
      lines.push(
        <Text key={`t${ti}`} inverse={active && props.focused} bold={active} dimColor={!active}>
          {truncate(`${active ? '▸' : ' '} ${t.testName}`, width - 1)}
        </Text>,
      );
      lines.push(
        <Text key={`m${ti}`}>
          {t.diffHunks?.length ? (
            <Text bold color={t.testChange === 'new' ? 'green' : 'yellow'}>
              {t.testChange === 'new' ? '● new' : '◐ modified'}
            </Text>
          ) : null}
          <Text dimColor italic={guess}>
            {truncate(
              `  ${t.testFile}:${t.startLine} · ${LINK_TEXT[t.source]}${guess ? ' (guess)' : ''} · ${Math.round(t.confidence * 100)}%`,
              width - (t.diffHunks?.length ? (t.testChange === 'new' ? 5 : 10) : 0),
            )}
          </Text>
        </Text>,
      );
      if (active) {
        if (t.diffHunks?.length) {
          t.diffHunks.forEach((diff, di) => {
            if (t.diffHunks!.length > 1)
              lines.push(
                <Text key={`h${ti}_${di}`} color="cyan">
                  {truncate(diff.header, width)}
                </Text>,
              );
            diff.lines.forEach((l, i) => {
              const caret = marker();
              const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
              const color = l.kind === 'add' ? 'green' : l.kind === 'del' ? 'red' : undefined;
              codeChunks(l.text, width - 12).forEach((code, part) =>
                lines.push(
                  <Text key={`d${ti}_${di}_${i}_${part}`}>
                    {part === 0 ? caret : ' '}
                    <Text backgroundColor={DIFF_BACKGROUND[l.kind]}>
                      <Text dimColor>{part === 0 ? `${l.oldLine ?? ''}`.padStart(4) + ' ' + `${l.newLine ?? ''}`.padStart(4) : ' '.repeat(9)} </Text>
                      <Text color={color}>{part === 0 ? sign : ' '}</Text>
                      <SyntaxText text={code} spans={diffHighlights?.[di]?.[i]} column={part * Math.max(1, width - 12)} />
                    </Text>
                  </Text>,
                ),
              );
            });
          });
        } else {
          t.lines.forEach((l, i) => {
            const caret = marker();
            codeChunks(l, width - 6).forEach((code, part) =>
              lines.push(
                <Text key={`l${ti}_${i}_${part}`}>
                  {part === 0 ? caret : ' '}
                  <Text dimColor>{part === 0 ? String(t.startLine + i).padStart(4) : ' '.repeat(4)} </Text>
                  <SyntaxText text={code} spans={highlights?.[i]} column={part * Math.max(1, width - 6)} />
                </Text>,
              ),
            );
          });
        }
      }
    });
  }
  let top = Math.min(props.scroll, Math.max(0, lines.length - height));
  if (cursorRow >= 0 && cursorRow < top) top = cursorRow;
  if (cursorRow >= top + height) top = cursorRow - height + 1;
  useEffect(() => {
    if (top !== props.scroll) props.setScroll(top);
  });
  if (props.inline && cursorRow >= 0) {
    const avail = Math.max(2, height - props.inline.height);
    const start = Math.max(0, cursorRow - Math.max(1, Math.floor(avail * 0.6)) + 1);
    const before = lines.slice(start, cursorRow + 1);
    const after = lines.slice(cursorRow + 1, cursorRow + 1 + Math.max(0, avail - before.length));
    return (
      <Box flexDirection="column" width={width} height={height} overflow="hidden">
        {before}
        <Box flexShrink={0} paddingLeft={1}>
          {props.inline.node}
        </Box>
        {after}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden" borderStyle={undefined}>
      {lines.slice(top, top + height)}
    </Box>
  );
}

// Renders only the visible window of a collapsed chapter, which can hold thousands of generated hunks.
const CollapsedSummary = React.memo(function CollapsedSummary(props: {
  hunks: Tour['hunks'];
  files: Map<string, DiffFile>;
  chapter: Chapter;
  states: States;
  sel: number;
  width: number;
  height: number;
}) {
  const { hunks, files, chapter, states, width } = props;
  const total = chapter.hunkIds.length;
  const top = Math.max(0, Math.min(props.sel - Math.floor(props.height / 2), total - props.height));
  const rows = chapter.hunkIds.slice(top, top + Math.max(0, props.height)).map((id, k) => {
    const i = top + k;
    const h = hunks[id];
    const f = h ? files.get(h.file) : undefined;
    const st = stateMark(stateOf(states, h));
    const summary = f?.summary ?? f?.kindReason ?? '';
    return (
      <Text key={id} inverse={i === props.sel}>
        <Text color={st.color}>{st.mark}</Text> {pad(h?.file ?? id, Math.floor(width * 0.45))}{' '}
        <Text dimColor>{truncate(`${summary} (+${f?.additions ?? 0}/-${f?.deletions ?? 0}, ${h ? changedLineCount(h) : 0} lines)`, Math.floor(width * 0.5))}</Text>
      </Text>
    );
  });
  return (
    <Box flexDirection="column" height={props.height} overflow="hidden">
      {rows}
    </Box>
  );
});

function DraftLine(props: { drafts: Draft[]; hunk?: Hunk; cursor: number; flash: string; width: number; describe: (d: Draft) => string }) {
  const pending = props.drafts.filter((d) => !d.posted);
  if (props.flash)
    return (
      <Text color="yellow" wrap="truncate">
        {truncate(props.flash, props.width)}
      </Text>
    );
  const l = props.hunk?.lines[props.cursor];
  const here = props.hunk && l ? draftsAt(props.drafts, props.hunk, l.kind === 'del' ? l.oldLine : l.newLine, l.kind === 'del' ? 'LEFT' : 'RIGHT') : [];
  const text = here.length ? `✎ ${here.map((d) => `[${d.label}] ${d.body.replace(/\s+/g, ' ')}`).join('  ')}` : `✎ ${pending.length} draft comment(s)`;
  return (
    <Text dimColor={!here.length} wrap="truncate">
      {truncate(text, props.width)}
    </Text>
  );
}

const HELP_ROWS: [string, string][] = [
  ['n / p', 'Next or previous hunk (n marks it read), on into the next chapter'],
  ['j / k, J / K', 'Move by line (or 10 lines) inside the hunk'],
  ['v', 'Start or end a range selection'],
  ['] / [', 'Next or previous chapter'],
  ['c / C', 'Comment on the selected line or range / on the whole flow'],
  ['e', 'Read existing review threads on the selected line inline'],
  ['y', 'Reply to an existing review thread on the selected line'],
  ['E / X', 'Edit or delete your draft on the selected line'],
  ['In a comment', '@ people/code (@callers: @tests: @threads: …)'],
  ['  ^T', 'In a comment: suggest a code change with AI'],
  ['?', 'Ask the agent about the selection'],
  ['t', 'Focus the test pane (narrow terminals: toggle source/tests)'],
  ['T', 'Hide or show the test pane beside the code'],
  ['Focused tests', 'n/p test · j/k line · c comment · ? ask · t/Esc back to source'],
  ['U', 'Expand or collapse possible test gaps in the explanation'],
  ['d', 'Chapter diagram (select a node to jump to its code)'],
  ['r', 'Raw unified diff for the hunk'],
  ['S', 'Split view (old beside new) or inline'],
  ['+ / -', 'Show 10 more or fewer lines of the file around the hunk'],
  ['w', 'Hide or show whitespace-only changes'],
  ['x / z / u', 'Mark the hunk skipped / deferred / unread'],
  ['m', 'Move the hunk to another chapter'],
  ['f', 'Cycle Guided, Risk first, Small first, and File order'],
  ['D', 'Re-review: toggle delta-only (new and changed hunks)'],
  ['o', 'Open the hunk in Claude Code'],
  ['i', 'Team checklist for this chapter'],
  ['b / s', 'Briefing / submit screen'],
  ['q / Q', 'Back to the PR list / quit (progress is saved)'],
];
const HELP_KEY_WIDTH = 15;
const HELP_WIDTH = 2 + 2 + HELP_KEY_WIDTH + Math.max(...HELP_ROWS.map(([, v]) => v.length)); // border, padding, key column

// The key reference, sized to the popup: descriptions truncate, and rows past its height are cut.
function Help(props: { width: number; height: number }) {
  const inner = props.width - 2;
  const rows = HELP_ROWS.slice(0, Math.max(0, props.height - 2));
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Keys</Text>
      {rows.map(([k, v]) => (
        <Text key={k} wrap="truncate">
          <Text bold color="cyan">
            {k.padEnd(HELP_KEY_WIDTH)}
          </Text>
          {truncate(v, Math.max(1, inner - HELP_KEY_WIDTH))}
        </Text>
      ))}
      <Text dimColor>{rows.length < HELP_ROWS.length ? `${HELP_ROWS.length - rows.length} more on a taller terminal · ` : ''}any key to close</Text>
    </Box>
  );
}

type GuideLine = MdLine;

// The guide's text: narration (inferred narration is quieter),
// then notes on the chapter or hunk. All of it is Markdown: the agent writes `code`.
function guideLines(narration: string | undefined, inferred: boolean, notes: string[], width: number, mode: Tour['mode'], hasHunk: boolean): GuideLine[] {
  const out: GuideLine[] = [];
  // Narration and notes are model output; renderMarkdown strips terminal controls.
  if (narration) {
    const md = renderMarkdown(narration, width);
    out.push(...(inferred ? restyle(md, { dim: true, italic: true }) : md));
    if (inferred) out.push(line('(the agent’s inference: not tied to visible code)', { dim: true, italic: true }));
  } else if (hasHunk) {
    out.push(line(mode === 'plain' ? 'Plain mode: no narration.' : 'Narration is still being written…', { dim: true }));
  }
  if (notes.length) {
    out.push([]);
    for (const n of notes) out.push(...restyle(renderMarkdown(n, width), { color: 'yellow' }));
  }
  return out;
}

function noTestHint(hunk: Hunk, nameGuess?: string): string | undefined {
  if (hunk.coverage === 'n/a') return undefined;
  return `No linked test case found for this code.${nameGuess ? ` Nearest test file by name: ${nameGuess}` : ''}`;
}
