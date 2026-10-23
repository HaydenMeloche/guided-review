import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp, useInput, useWindowSize } from 'ink';
import { Box, PreviewingContext, Text, ThemeContext, useThemePreview } from './themed.js';
import { terminalPalette, themeList, type Palette, type ThemeInfo } from './theme.js';
import { ThemePicker } from './ThemePicker.js';
import { spawnSync } from 'node:child_process';
import type { Chapter, ChapterOrder, Draft, ExistingThread, Hunk, PRInfo, ReactionContent, ReadState, ThreadComment, Tour } from '../types.js';
import { Store } from '../store/db.js';
import { fetchHeadSha, fetchMergeStatus, fetchPR, fetchThreads, getMentionUsers, replyToThread, setCommentReaction, viewerLogin } from '../github/gh.js';
import { ensureWorktree } from '../git/worktree.js';
import { runPipeline } from '../pipeline.js';
import type { AgentRole, AgentRouting } from '../agent/types.js';
import type { ViewSetting } from '../config.js';
import { fileOrderChapters } from '../analysis/flows.js';
import { applyMoves, ORDER_SEQUENCE, positionAfterOrderChange, sortChapters, stateOf, type States } from './nav.js';
import { hunkKeys } from '../review/hunkState.js';
import { ChapterScreen, type Services } from './ChapterScreen.js';
import { BriefingScreen } from './BriefingScreen.js';
import { SubmitScreen } from './SubmitScreen.js';
import { ReviewPopup } from './ReviewPopup.js';
import { CommentEditor } from './CommentEditor.js';
import { aiChromeRows } from './AiSuggestion.js';
import { initComposer, type ComposerEnv, type ComposerState, type ReferenceServices } from './composer.js';
import { pushRecent, type RecentLocation } from './references.js';
import { RepoIndex } from '../analysis/repoIndex.js';
import { githubWebHost } from '../github/auth.js';
import { generateSuggestion } from '../agent/suggest.js';
import { PickerScreen, keyFor, type DownloadJob, type Target as PickTarget } from './PickerScreen.js';
import { TourIntro, type IntroLine } from './TourIntro.js';
import { useTerminalStatus, type TerminalProgress } from './terminalStatus.js';
import { sanitizeTerminal } from '../util/sanitize.js';
import { codingAgentLaunch, type CodingAgentSetting } from '../codingAgent.js';
import { AuthorMode } from './author/AuthorMode.js';
import { ChecksPopup, MergePopup, ReviewersPopup } from './prPopups.js';
import { mergeReadiness, type Readiness } from '../review/merge.js';
import { placedThreads } from '../review/feedback.js';
import { loadThreadDiffs } from '../review/threadDiffs.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Target {
  repo: string;
  number: number;
}

// review: the reviewer's tour. author: the feedback on your own PR (gr feedback).
export type Mode = 'review' | 'author';

export interface AppOptions {
  target?: Target; // undefined: pick from PRs awaiting your review
  mode?: Mode; // what a target opens in; review when unset, which asks first on your own PR
  localRepo?: string;
  agent?: AgentRouting;
  chapterOrder?: ChapterOrder; // the user's default; a PR's saved order wins
  hideWhitespace?: boolean; // the user's saved w setting; on when unset
  splitDiff?: boolean; // the user's saved S setting; off when unset
  saveViewSetting?: (key: ViewSetting, value: boolean) => void; // records a w or S toggle for next time
  noAgent?: boolean;
  fresh?: boolean;
  preview?: { pr: PRInfo; diff: string; worktree: string }; // gr preview: a tour of a local branch
  palette?: Palette; // the saved theme, loaded before the first frame; the terminal's colors when unset
  saveTheme?: (name: string) => void; // records a theme chosen in the picker; unset when there is no config file
  codingAgent?: CodingAgentSetting; // the agent o opens; Claude Code when unset
}

// The theme picker as the screens see it: L opens it over the picker, briefing, or chapter.
interface ThemeControl {
  open: boolean;
  show: () => void;
  popup: (width: number, height: number) => ReactNode;
}

type Phase = 'pick' | 'load' | 'own' | 'briefing' | 'chapter' | 'submit' | 'edit' | 'author' | 'error';

interface Step {
  name: string;
  done: boolean;
}

const HEAD_POLL_MS = 60_000;
// Tours downloaded at once from the picker. Each runs its own pipeline (and agent calls).
export const PREDOWNLOAD_CONCURRENCY = 3;

// A counting semaphore: downloads started at different times share the same slots.
function slots(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    acquire: () => (active < limit ? (active++, Promise.resolve()) : new Promise<void>((resolve) => waiting.push(resolve))),
    release: () => {
      const next = waiting.shift();
      if (next) next();
      else active--;
    },
  };
}

// Where the reviewer is, for the window title.
function titleSpot(phase: Phase, hasTour: boolean, ci: number, chapterCount: number): string {
  if (phase === 'pick') return 'reviews';
  if (phase === 'error') return 'error';
  if (phase === 'own') return 'your PR';
  if (phase === 'author') return hasTour ? 'feedback' : 'loading';
  if (phase === 'load' || !hasTour) return 'loading';
  if (phase === 'briefing') return 'briefing';
  if (phase === 'submit' || phase === 'edit') return 'submit';
  return chapterCount ? `chapter ${Math.min(ci + 1, chapterCount)}/${chapterCount}` : 'tour';
}

// The tab's progress indicator: the tour build, then narration still running behind the briefing.
function tabProgress(phase: Phase, narration: { done: number; total: number } | undefined): TerminalProgress {
  if (phase === 'error') return { state: 'error' };
  if (narration?.total) return { state: 'value', percent: (100 * narration.done) / narration.total };
  if (phase === 'load') return { state: 'busy' };
  return { state: 'none' };
}

function chaptersForOrder(tour: Tour, order: ChapterOrder, moves: Record<string, string>, deltaOnly: boolean): Chapter[] {
  const base = order === 'file' ? fileOrderChapters(tour.files, tour.hunks) : tour.chapters;
  // Sorted before the delta filter, so a re-review lists chapters in the same order as the whole tour.
  const chapters = sortChapters(applyMoves(base, tour, moves), tour, order);
  if (!deltaOnly || !tour.rereview) return chapters;
  const delta = new Set(tour.rereview.newHunkIds);
  return chapters.map((c) => ({ ...c, hunkIds: c.hunkIds.filter((id) => delta.has(id)) })).filter((c) => c.hunkIds.length);
}

// Holds the theme, so changing it never remounts the screens (and loses their state).
export function App(opts: AppOptions) {
  const { columns, rows } = useWindowSize();
  const { palette, preview } = useThemePreview(opts.palette ?? terminalPalette);
  const [themes, setThemes] = useState<ThemeInfo[] | undefined>(); // the picker is open while set
  // The theme last chosen, by name: the palette may still be loading when the picker reopens.
  const committed = useRef(palette.name);
  const opened = useRef(palette.name); // restored when the picker is cancelled
  const theme: ThemeControl = {
    open: !!themes,
    show: () => {
      opened.current = committed.current;
      void themeList().then(setThemes);
    },
    popup: (width, height) =>
      themes ? (
        <ThemePicker
          themes={themes}
          current={opened.current}
          width={width}
          height={height}
          note={opts.saveTheme ? 'enter saves the theme to your config' : 'no config file: enter uses the theme until you quit (gr config saves one)'}
          onPreview={preview}
          onDone={(name) => {
            setThemes(undefined);
            const chosen = name ?? opened.current;
            committed.current = chosen;
            preview(chosen);
            if (name) opts.saveTheme?.(name);
          }}
        />
      ) : null,
  };
  return (
    <ThemeContext value={palette}>
      <PreviewingContext value={!!themes && palette.name !== committed.current}>
        <Box flexDirection="column" width={palette.bg ? columns : undefined} height={palette.bg ? rows : undefined} backgroundColor={palette.bg}>
          <Screens {...opts} theme={theme} />
        </Box>
      </PreviewingContext>
    </ThemeContext>
  );
}

function Screens(opts: AppOptions & { theme: ThemeControl }) {
  const { theme } = opts;
  const { exit, suspendTerminal } = useApp();
  const { columns, rows } = useWindowSize();
  const store = useMemo(() => new Store(), []);
  const [phase, setPhase] = useState<Phase>(opts.target || opts.preview ? 'load' : 'pick');
  const [submitFrom, setSubmitFrom] = useState<'briefing' | 'chapter'>('chapter');
  const [target, setTarget] = useState<Target | undefined>(opts.target ?? (opts.preview ? { repo: opts.preview.pr.repo, number: opts.preview.pr.number } : undefined));
  const [worktree, setWorktree] = useState<string>('');
  const [tour, setTour] = useState<Tour | undefined>();
  const [steps, setSteps] = useState<Step[]>([]);
  const [analyzing, setAnalyzing] = useState<string | undefined>();
  const [narration, setNarration] = useState<{ done: number; total: number }>();
  const [error, setError] = useState('');
  const [states, setStates] = useState<States>({});
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [moves, setMoves] = useState<Record<string, string>>({});
  const [order, setOrder] = useState<ChapterOrder>(opts.chapterOrder ?? 'flow');
  const [hideWhitespace, setHideWhitespace] = useState(opts.hideWhitespace ?? true);
  const [splitDiff, setSplitDiff] = useState(opts.splitDiff ?? false);
  const [hideTestPane, setHideTestPane] = useState(false);
  const [deltaOnly, setDeltaOnly] = useState(false);
  const [pos, setPosState] = useState({ ci: 0, hi: 0 });
  const [banner, setBanner] = useState<string | undefined>();
  const [pickerNotice, setPickerNotice] = useState<string | undefined>();
  const [newHead, setNewHead] = useState<string | undefined>();
  const [editing, setEditing] = useState<Draft | undefined>();
  const [editState, setEditState] = useState<ComposerState>();
  // Recent locations for this PR's session feed @ completion and its recent: filter. A ref:
  // noting a place must not re-render.
  const recent = useRef<RecentLocation[]>([]);
  const repoIndex = useRef<{ key: string; index: RepoIndex } | undefined>(undefined);
  const [confirms, setConfirms] = useState<Record<string, boolean>>({});
  const [prTitle, setPrTitle] = useState<string | undefined>();
  const [mode, setMode] = useState<Mode>(opts.mode ?? 'review');
  // PRs whose "this is your PR" question was answered, so it is asked once per PR.
  const askedOwn = useRef(new Set<string>());
  // PRs merged from here, kept off the picker: GitHub's search can list them for a while after.
  const [merged, setMerged] = useState<ReadonlySet<string>>(new Set());
  const [readiness, setReadiness] = useState<Readiness>();
  const [merging, setMerging] = useState<Target>();
  const [checking, setChecking] = useState<Target>(); // the checks popup, over the picker or the briefing
  const [askingReviewers, setAskingReviewers] = useState<Target>(); // the reviewers popup, over the picker
  const [pickerReload, setPickerReload] = useState(0);
  // Diffs from each outdated thread's commit to the head, so the tour shows it on its line now.
  const threadDiffs = useRef<Awaited<ReturnType<typeof loadThreadDiffs>>>(new Map());
  const loadGen = useRef(0);
  const agentSessions = useRef<Partial<Record<AgentRole, string>>>({});
  // The in-flight tour build: aborted when a new load starts (R rebase, retry, a new pick) and on quit.
  const loadAbort = useRef<AbortController | undefined>(undefined);
  const predownloadAbort = useRef<AbortController | undefined>(undefined);
  // Tour downloads started from the picker, by PR. Kept here so they keep running
  // (and stay visible) while a tour is open.
  const [downloads, setDownloads] = useState<Record<string, DownloadJob>>({});
  const downloadSlots = useRef(slots(PREDOWNLOAD_CONCURRENCY));
  const downloading = useRef(new Set<string>());
  // Checkouts for one repo share its clone, so they run one at a time even while
  // several tours download in parallel.
  const checkouts = useRef(new Map<string, Promise<unknown>>());

  useEffect(() => () => store.close(), [store]);
  useEffect(
    () => () => {
      loadAbort.current?.abort();
      predownloadAbort.current?.abort();
    },
    [],
  );

  // ---------- loading ----------
  const onProgress = useCallback((name: string, done?: boolean, count?: { done: number; total: number }) => {
    setSteps((s) => {
      const base = name.replace(/ \d+\/\d+$/, '');
      const i = s.findIndex((x) => x.name.replace(/ \d+\/\d+$/, '') === base);
      if (i < 0) return [...s, { name, done: !!done }];
      const copy = [...s];
      copy[i] = { name, done: !!done };
      return copy;
    });
    if (name.startsWith('Narrating')) {
      setAnalyzing(done ? undefined : name);
      setNarration(done ? undefined : count);
    }
  }, []);

  // Drafts written against an older head whose hunk no longer exists are flagged, not lost.
  const flagDraftsOnChangedLines = useCallback(
    (t: Tour) => {
      const flagged: Draft[] = [];
      for (const d of store.listDrafts(t.repo, t.pr)) {
        if (d.posted || d.headSha === t.headSha) continue;
        if ((d.anchor.type === 'line' || d.anchor.type === 'range') && !t.hunks[d.anchor.hunkId]) {
          const note = `written on ${d.headSha.slice(0, 8)}; the code changed since`;
          if (d.note !== note) flagged.push({ ...d, note });
        }
      }
      if (flagged.length) store.saveDrafts(flagged);
      setDrafts(store.listDrafts(t.repo, t.pr));
    },
    [store],
  );

  // The feedback screen's load: it needs the tour's chapters and summary, not narration of the
  // author's own code. Returns once the tour is in (or the load was superseded).
  const loadAuthor = useCallback(
    async (info: PRInfo, wt: string, gen: number, signal: AbortSignal, fresh: boolean | undefined) => {
      setMoves(store.getMoves(info.repo, info.number));
      setOrder(store.getPosition(info.repo, info.number)?.order ?? opts.chapterOrder ?? 'flow');
      setDeltaOnly(false);
      // The feedback needs the tour's chapters and summary, not narration of the author's own
      // code. A tour already built for this head (by gr review or CI) is used as it is; else
      // the static tour opens at once and, with a model, the briefing is written behind it.
      const saved = fresh ? undefined : store.loadTour(info.repo, info.number, info.headSha);
      const withModel = !!opts.agent && !opts.noAgent;
      if (saved && (saved.mode === 'agent' || !withModel)) {
        setTour(saved);
        setPhase('author');
        return;
      }
      const final = await runPipeline({
        pr: info,
        worktree: wt,
        store,
        agent: opts.agent,
        noAgent: !withModel,
        briefingOnly: true,
        fresh,
        signal,
        onProgress,
        onTour: (tr) => {
          if (gen !== loadGen.current) return;
          setTour(tr);
          setPhase('author');
        },
      });
      if (gen !== loadGen.current) return;
      setTour(final);
      setPhase('author');
    },
    [opts, store, onProgress],
  );

  const load = useCallback(
    async (t: Target, fresh = opts.fresh, as: Mode = opts.mode ?? 'review') => {
      const gen = ++loadGen.current;
      loadAbort.current?.abort();
      const abort = new AbortController();
      loadAbort.current = abort;
      const { signal } = abort;
      agentSessions.current = {};
      recent.current = [];
      setPhase('load');
      setPrTitle(undefined);
      setSteps([]);
      setAnalyzing(undefined);
      setNarration(undefined);
      setError('');
      setBanner(undefined);
      setNewHead(undefined);
      setReadiness(undefined);
      threadDiffs.current = new Map();
      try {
        let info: PRInfo;
        let wt: string;
        if (opts.preview) {
          info = opts.preview.pr;
          wt = opts.preview.worktree;
        } else {
          onProgress(`Fetching ${t.repo}#${t.number}`);
          info = await fetchPR(t.repo, t.number, signal);
          onProgress(`Fetching ${t.repo}#${t.number}`, true);
          onProgress('Checking out head in a worktree');
          wt = await ensureWorktree(info, { localRepo: opts.localRepo });
          onProgress('Checking out head in a worktree', true);
        }
        if (gen !== loadGen.current) return;
        setPrTitle(info.title);
        setWorktree(wt);
        // Your own PR from gr review: ask whether you want its feedback or its tour.
        if (!opts.preview && as === 'review' && !askedOwn.current.has(keyFor(t))) {
          const viewer = await viewerLogin(signal).catch(() => undefined);
          if (gen !== loadGen.current) return;
          if (viewer && viewer === info.author) {
            askedOwn.current.add(keyFor(t));
            setPhase('own');
            return;
          }
        }
        setMode(as);
        if (as === 'author') return await loadAuthor(info, wt, gen, signal, fresh); // awaited, so a failure reaches the catch below
        setStates(store.getReadStates(info.repo, info.number));
        setDrafts(store.listDrafts(info.repo, info.number));
        setMoves(store.getMoves(info.repo, info.number));
        setConfirms(store.getChecklistConfirms(info.repo, info.number));
        // Q&A sessions are stored on their own, keyed to this head, and resumed from there.
        agentSessions.current = store.loadSessions(info.repo, info.number, info.headSha);
        const saved = store.getPosition(info.repo, info.number);
        setOrder(saved?.order ?? opts.chapterOrder ?? 'flow');

        let shown = false;
        const final = await runPipeline({
          pr: info,
          worktree: wt,
          store,
          agent: opts.agent,
          noAgent: opts.noAgent,
          fresh,
          diffOverride: opts.preview?.diff,
          signal,
          onProgress,
          onTour: (tr) => {
            if (gen !== loadGen.current) return;
            // Sessions in the session table win over any a cached tour carried.
            agentSessions.current = { ...tr.agentSessions, ...agentSessions.current };
            setTour({ ...tr, agentSessions: { ...agentSessions.current } });
            // Show the briefing as soon as it is written; chapters keep narrating behind it.
            const briefingReady = tr.mode === 'agent' || tr.complete || opts.noAgent;
            if (!shown && briefingReady) {
              shown = true;
              setDeltaOnly(!!tr.rereview?.newHunkIds.length);
              setPhase('briefing');
            }
          },
        });
        if (gen !== loadGen.current) return;
        // The pipeline saves the tour itself; Q&A sessions are saved to their own table.
        agentSessions.current = { ...final.agentSessions, ...agentSessions.current };
        setTour({ ...final, agentSessions: { ...agentSessions.current } });
        setAnalyzing(undefined);
        setNarration(undefined);
        flagDraftsOnChangedLines(final);
        if (!opts.preview && final.existingThreads.some((th) => th.isOutdated && !th.isResolved)) {
          loadThreadDiffs(wt, final.headSha, final.existingThreads, { signal }).then(
            (diffs) => {
              if (gen !== loadGen.current) return;
              threadDiffs.current = diffs;
              setTour((cur) => (cur ? { ...cur, existingThreads: placedThreads(cur, cur.existingThreads, diffs) } : cur));
            },
            () => undefined,
          );
        }
        if (!shown) {
          setDeltaOnly(!!final.rereview?.newHunkIds.length);
          setPhase('briefing');
        }
      } catch (e) {
        if (gen !== loadGen.current || signal.aborted) return;
        setError((e as Error).message);
        setPhase('error');
      }
    },
    [opts, store, onProgress, flagDraftsOnChangedLines, loadAuthor],
  );

  // Mount only: later loads come from explicit actions, and `load` changes identity with opts.
  useEffect(() => {
    if (target && phase === 'load' && !steps.length) void load(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Author pushes mid-review: poll the head and offer to rebase the tour.
  const pollRepo = tour?.repo;
  const pollPr = tour?.pr;
  const pollHead = tour?.headSha;
  const preview = !!opts.preview;
  useEffect(() => {
    if (!pollRepo || pollPr === undefined || !pollHead || preview) return;
    const check = async () => {
      try {
        const head = await fetchHeadSha(pollRepo, pollPr);
        if (head && head !== pollHead) {
          setNewHead(head);
          setBanner(`The author pushed ${head.slice(0, 8)}. Press R to rebase the tour onto the new head (drafts are kept).`);
        }
      } catch {
        /* offline: keep going */
      }
    };
    const timer = setInterval(() => void check(), HEAD_POLL_MS);
    return () => clearInterval(timer);
  }, [pollRepo, pollPr, pollHead, preview]);

  // Whether the PR can merge, for the review briefing. Author mode reads its own.
  useEffect(() => {
    if (!pollRepo || pollPr === undefined || preview || mode !== 'review') return;
    let live = true;
    fetchMergeStatus(pollRepo, pollPr).then(
      (s) => live && setReadiness(mergeReadiness(s)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [pollRepo, pollPr, pollHead, preview, mode, newHead]);

  // ---------- derived ----------
  const chapters: Chapter[] = useMemo(() => {
    if (!tour) return [];
    return chaptersForOrder(tour, order, moves, deltaOnly);
  }, [tour, order, moves, deltaOnly]);
  // The whole tour, so a re-review can show the chapters it leaves out, greyed.
  const allChapters: Chapter[] = useMemo(() => {
    if (!tour) return [];
    return deltaOnly ? chaptersForOrder(tour, order, moves, false) : chapters;
  }, [tour, order, moves, deltaOnly, chapters]);

  // The window title names the PR and where you are in it.
  const subject = opts.preview ? `preview ${opts.preview.pr.repo}` : target ? `${target.repo}#${target.number}` : undefined;
  const title = ['gr', phase === 'pick' ? undefined : subject, titleSpot(phase, !!tour, pos.ci, chapters.length)].filter(Boolean).join(' · ');
  const rewriteTerminalStatus = useTerminalStatus(title, tabProgress(phase, narration));

  // Switch between the new or changed hunks and the whole tour, keeping the current hunk when it is in both.
  const toggleDelta = () => {
    if (!tour?.rereview) return;
    const nextChapters = chaptersForOrder(tour, order, moves, !deltaOnly);
    setDeltaOnly(!deltaOnly);
    setPosState(positionAfterOrderChange(chapters, pos, nextChapters));
  };

  const cycleOrder = () => {
    if (!tour) return;
    const next = ORDER_SEQUENCE[(ORDER_SEQUENCE.indexOf(order) + 1) % ORDER_SEQUENCE.length];
    const nextChapters = chaptersForOrder(tour, next, moves, deltaOnly);
    const { ci, hi } = positionAfterOrderChange(chapters, pos, nextChapters);
    const chapter = nextChapters[ci];
    setOrder(next);
    setPosState({ ci, hi });
    if (tour && chapter) store.setPosition(tour.repo, tour.pr, { chapterId: chapter.id, hunkId: hi >= 0 ? chapter.hunkIds[hi] : undefined, order: next });
  };

  const services: Services | undefined =
    tour && worktree
      ? {
          root: worktree,
          confirms,
          setConfirm: (id, v) => {
            store.setChecklistConfirm(tour.repo, tour.pr, id, v);
            setConfirms(store.getChecklistConfirms(tour.repo, tour.pr));
          },
          loadMentionUsers: opts.preview ? undefined : () => getMentionUsers(tour.repo),
        }
      : undefined;

  const setPos = (ci: number, hi: number) => {
    setPosState({ ci, hi });
    const c = chapters[ci];
    if (tour && c) store.setPosition(tour.repo, tour.pr, { chapterId: c.id, hunkId: hi >= 0 ? c.hunkIds[hi] : undefined, order });
  };

  const resume = (ci?: number) => {
    if (!tour) return;
    if (ci !== undefined) {
      setPos(ci, chapters[ci]?.collapsed ? -1 : 0);
      return setPhase('chapter');
    }
    const saved = store.getPosition(tour.repo, tour.pr);
    const sc = saved ? chapters.findIndex((c) => c.id === saved.chapterId) : -1;
    if (saved && sc >= 0) {
      const hi = saved.hunkId ? chapters[sc].hunkIds.indexOf(saved.hunkId) : -1;
      setPos(sc, hi >= 0 ? hi : chapters[sc].collapsed ? -1 : 0);
    } else {
      // First unread hunk in reading order.
      let found = false;
      for (let c = 0; c < chapters.length && !found; c++) {
        if (chapters[c].optional) continue;
        const i = chapters[c].hunkIds.findIndex((id) => tour.hunks[id] && !tour.hunks[id].importOnly && stateOf(states, tour.hunks[id]) === 'unread');
        if (i >= 0) {
          setPos(c, chapters[c].collapsed ? -1 : i);
          found = true;
        }
      }
      if (!found) setPos(0, chapters[0]?.collapsed ? -1 : 0);
    }
    setPhase('chapter');
  };

  const setHunkState = (h: Hunk, s: ReadState) => {
    if (!tour) return;
    const keys = hunkKeys(h);
    for (const k of keys) store.setReadState(tour.repo, tour.pr, k, s);
    setStates((prev) => ({ ...prev, ...Object.fromEntries(keys.map((k) => [k, s])) }));
  };

  const saveDraft = (d: Draft) => {
    store.saveDraft(d);
    setDrafts(store.listDrafts(d.repo, d.pr));
  };

  const sendThreadReply = async (thread: ExistingThread, body: string) => {
    if (!tour) return;
    const id = thread.comments[0]?.id;
    if (!id) throw new Error('This thread has no GitHub comment ID to reply to.');
    await replyToThread(tour.repo, tour.pr, id, body);
    const threads = await fetchThreads(tour.repo, tour.pr).catch(() => undefined);
    setTour((current) =>
      current
        ? {
            ...current,
            existingThreads: threads
              ? placedThreads(current, threads, threadDiffs.current)
              : current.existingThreads.map((t) => (t.id === thread.id ? { ...t, comments: [...t.comments, { author: 'you', body, createdAt: new Date().toISOString() }] } : t)),
          }
        : current,
    );
  };

  const reactToComment = async (comment: ThreadComment, content: ReactionContent, remove: boolean) => {
    if (!tour || !comment.nodeId) throw new Error('This comment cannot receive reactions.');
    const reactionGroups = await setCommentReaction(comment.nodeId, content, remove);
    setTour((current) =>
      current
        ? {
            ...current,
            existingThreads: current.existingThreads.map((thread) => ({
              ...thread,
              comments: thread.comments.map((entry) => (entry.nodeId === comment.nodeId ? { ...entry, reactionGroups } : entry)),
            })),
          }
        : current,
    );
  };

  const openInAgent = async (h: Hunk | undefined, c: Chapter) => {
    if (!tour) return;
    const related = drafts.filter((d) => !d.posted && (d.anchor.type === 'line' || d.anchor.type === 'range') && h && d.anchor.file === h.file);
    const threads = tour.existingThreads.filter((t) => h && t.path === h.file);
    const hunkText = h ? `${h.file} ${h.header}\n${h.lines.map((l) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text).join('\n')}` : '';
    const prompt = [
      `I'm reviewing ${tour.repo}#${tour.pr} (${tour.url}) at ${tour.headSha.slice(0, 8)}, chapter "${c.title}".`,
      h ? `Here is the hunk:\n\`\`\`diff\n${hunkText}\n\`\`\`` : '',
      related.length ? `My draft comments:\n${related.map((d) => `- [${d.label}] line ${(d.anchor as { line: number }).line}: ${d.body}`).join('\n')}` : '',
      threads.length ? `Existing review threads:\n${threads.map((t) => `- line ${t.line ?? t.originalLine}: ${t.comments.map((x) => `@${x.author}: ${x.body}`).join(' / ')}`).join('\n')}` : '',
      'Help me dig into this.',
    ]
      .filter(Boolean)
      .join('\n\n');
    // A NUL byte from the PR would make spawnSync throw rather than start the agent.
    const agent = codingAgentLaunch(opts.codingAgent, prompt.replaceAll('\0', ''));
    await suspendTerminal(() => {
      // spawnSync throws on arguments it can't pass at all; report those like a failed start.
      try {
        const r = spawnSync(agent.command, agent.args, { stdio: 'inherit', cwd: worktree || process.cwd() });
        if (r.error) process.stderr.write(`Could not start ${agent.command}: ${r.error.message}\n`);
      } catch (e) {
        process.stderr.write(`Could not start ${agent.command}: ${(e as Error).message}\n`);
      }
    });
    // The agent sets its own title; put gr's back.
    rewriteTerminalStatus();
  };

  const toggleView = (key: ViewSetting, value: boolean, set: (v: boolean) => void) => {
    set(!value);
    try {
      opts.saveViewSetting?.(key, !value);
    } catch {
      // An unwritable or broken config keeps the setting for this session only.
    }
  };

  const checkout = (info: PRInfo): Promise<string> => {
    const previous = checkouts.current.get(info.repo) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => ensureWorktree(info, { localRepo: opts.localRepo }));
    checkouts.current.set(info.repo, run);
    return run;
  };

  const startDownloads = (targets: PickTarget[]) => {
    const signal = (predownloadAbort.current ??= new AbortController()).signal;
    const setJob = (key: string, job: DownloadJob) => setDownloads((d) => ({ ...d, [key]: job }));
    for (const target of targets) {
      const key = keyFor(target);
      if (downloading.current.has(key)) continue;
      downloading.current.add(key);
      setJob(key, { state: 'queued' });
      void (async () => {
        await downloadSlots.current.acquire();
        try {
          if (signal.aborted) return;
          setJob(key, { state: 'running', step: 'Fetching the PR' });
          const info = await fetchPR(target.repo, target.number, signal);
          setJob(key, { state: 'running', step: 'Checking out' });
          const wt = await checkout(info);
          if (signal.aborted) return;
          // The pipeline saves the finished tour (a cached tour is already saved).
          const result = await runPipeline({
            pr: info,
            worktree: wt,
            store,
            agent: opts.agent,
            noAgent: opts.noAgent,
            fresh: opts.fresh,
            signal,
            onProgress: (name, done) => {
              if (!done && !signal.aborted) setJob(key, { state: 'running', step: name });
            },
            onTour: () => {},
          });
          setJob(key, result.complete ? { state: 'done' } : { state: 'failed', error: 'tour incomplete' });
        } catch (error) {
          if (!signal.aborted) setJob(key, { state: 'failed', error: (error as Error).message });
        } finally {
          downloading.current.delete(key);
          downloadSlots.current.release();
        }
      })();
    }
  };

  const quit = () => {
    loadAbort.current?.abort();
    predownloadAbort.current?.abort();
    exit();
  };

  // q while reviewing: drop the open tour and return to the PR list. A preview has no list,
  // so there q quits.
  const back = opts.preview
    ? undefined
    : () => {
        loadGen.current++;
        loadAbort.current?.abort();
        setTour(undefined);
        setSteps([]);
        setBanner(undefined);
        setNewHead(undefined);
        setAnalyzing(undefined);
        setNarration(undefined);
        setPhase('pick');
      };
  // After a merge the PR is done: back to the list, saying so.
  const showMerged = (notice: string) => {
    setPickerNotice(notice);
    if (back) back();
    else setBanner(notice);
  };

  // ---------- screens ----------
  const width = columns;
  const height = rows;

  // A screen with the theme picker over it while open. The element tree is the same either way,
  // so opening the picker never remounts the screen and loses its state.
  const withThemePicker = (screen: (active: boolean) => ReactNode) => (
    <ReviewPopup background={screen(!theme.open)} width={width} height={height} maxWidth={100} maxHeight={30}>
      {theme.open ? theme.popup : undefined}
    </ReviewPopup>
  );

  // A merge started from the picker has no checkout: a model drafting its message gets an empty
  // directory to work in, and the PR's own text in the prompt.
  const mergeAgent = (cwd?: string) => (opts.agent && !opts.noAgent ? { cwd: cwd ?? emptyDir(), ...opts.agent } : undefined);
  const mergePopup = (background: ReactNode, t: Target, withTour?: Tour) => (
    <MergePopup
      background={background}
      width={columns}
      height={rows}
      repo={t.repo}
      number={t.number}
      tour={withTour}
      agent={mergeAgent(withTour ? worktree || undefined : undefined)}
      onCancel={() => setMerging(undefined)}
      onDone={(notice) => {
        setMerging(undefined);
        setMerged((m) => new Set(m).add(keyFor(t)));
        showMerged(notice);
      }}
    />
  );
  const checksPopup = (background: ReactNode, t: Target) => (
    <ChecksPopup background={background} width={columns} height={rows} repo={t.repo} number={t.number} onClose={() => setChecking(undefined)} />
  );
  if (phase === 'pick') {
    const picker = (active: boolean) => (
      <PickerScreen
        store={store}
        notice={pickerNotice}
        width={width}
        height={height}
        active={active}
        onPick={(t, as) => {
          setPickerNotice(undefined);
          setTarget(t);
          void load(t, opts.fresh, as ?? 'review');
        }}
        onMerge={setMerging}
        onChecks={setChecking}
        onReviewers={setAskingReviewers}
        reload={pickerReload}
        merged={merged}
        downloads={downloads}
        onDownload={startDownloads}
        onTheme={theme.show}
        onQuit={quit}
      />
    );
    if (merging) return mergePopup(picker(false), merging);
    if (checking) return checksPopup(picker(false), checking);
    if (askingReviewers)
      return (
        <ReviewersPopup
          background={picker(false)}
          width={columns}
          height={rows}
          repo={askingReviewers.repo}
          number={askingReviewers.number}
          onClose={(changed) => {
            setAskingReviewers(undefined);
            if (changed) setPickerReload((n) => n + 1);
          }}
        />
      );
    return withThemePicker(picker);
  }
  if (phase === 'error') {
    return <ErrorScreen message={error} onRetry={() => target && void load(target, true, mode)} onBack={back} onQuit={quit} />;
  }
  if (phase === 'own' && target) {
    return <OwnPrompt target={target} title={prTitle} onFeedback={() => void load(target, opts.fresh, 'author')} onTour={() => void load(target, opts.fresh, 'review')} onBack={back} onQuit={quit} />;
  }
  const introLines = (spinner: string): IntroLine[] => {
    const shown: IntroLine[] = steps
      .slice(-INTRO_STEPS)
      .map((s) => [s.done ? { text: '✓', color: 'green' } : { text: spinner, color: 'cyan' }, { text: ` ${s.name}`, color: s.done ? 'gray' : 'white' }]);
    return [
      target ? `${target.repo}#${target.number}` : 'Preparing the tour',
      tour?.title ?? prTitle ?? ' ',
      ' ',
      ...shown,
      ...Array.from({ length: INTRO_STEPS - shown.length }, () => ' '),
      ' ',
      [{ text: `The briefing opens as soon as it is written · ${back ? 'q for the PR list · Q to quit' : 'q to quit'}`, dim: true }],
    ];
  };
  if (phase === 'load' || !tour) {
    return <TourIntro width={width} height={height} lines={introLines} onBack={back} onQuit={quit} />;
  }
  const agent =
    tour.mode === 'agent' && worktree
      ? {
          cwd: worktree,
          ...opts.agent,
          sessions: agentSessions.current,
          // Writes one small row; the tour itself is not rewritten.
          rememberSession: (role: AgentRole, sessionId: string) => {
            agentSessions.current[role] = sessionId;
            store.saveSession(tour.repo, tour.pr, tour.headSha, role, sessionId);
          },
        }
      : undefined;
  // Why AI features are off, said in their place.
  const aiOff = agent
    ? undefined
    : opts.noAgent
      ? 'AI is off for this review (no model in gr config, or --no-agent), so questions are off.'
      : 'The model is unavailable for this tour, so questions are off. The briefing says why.';

  if (phase === 'author') {
    // Author mode reads its tour statically, so its model use goes by the config, not the tour.
    const authorAgent =
      opts.agent && !opts.noAgent && worktree
        ? {
            cwd: worktree,
            ...opts.agent,
            sessions: agentSessions.current,
            rememberSession: (role: AgentRole, sessionId: string) => {
              agentSessions.current[role] = sessionId;
              store.saveSession(tour.repo, tour.pr, tour.headSha, role, sessionId);
            },
          }
        : undefined;
    return withThemePicker((active) => (
      <AuthorMode
        key={`${tour.repo}#${tour.pr}@${tour.headSha}`}
        tour={tour}
        chapters={allChapters}
        worktree={worktree}
        store={store}
        agent={authorAgent}
        aiOff={authorAgent ? undefined : 'AI is off (no model in gr config, or --no-agent), so questions and drafted replies are off.'}
        newHead={newHead}
        writing={steps.some((st) => st.name === 'Writing briefing' && !st.done) ? 'Writing the summary and chapter titles…' : undefined}
        width={width}
        height={height}
        active={active}
        onReload={() => target && void load(target, false, 'author')}
        onFullTour={() => {
          if (!target) return;
          askedOwn.current.add(keyFor(target));
          void load(target, opts.fresh, 'review');
        }}
        onMerged={showMerged}
        onTheme={theme.show}
        onBack={back}
        onQuit={quit}
      />
    ));
  }

  // One index per checkout and head; its caches never invalidate, so preview mode, where the
  // working tree changes under it, gets a fresh one for each composer.
  const indexFor = (): RepoIndex | undefined => {
    if (!worktree) return undefined;
    const make = () => new RepoIndex({ root: worktree, headSha: tour.headSha, changedFiles: tour.files.map((f) => f.path) });
    if (opts.preview) return make();
    const key = `${worktree}\0${tour.headSha}`;
    if (repoIndex.current?.key !== key) repoIndex.current = { key, index: make() };
    return repoIndex.current.index;
  };
  const references: ReferenceServices = {
    host: githubWebHost(),
    repoIndex: indexFor,
    recent: () => recent.current,
    noteRecent: (loc) => {
      recent.current = pushRecent(recent.current, loc);
    },
  };
  const composerEnv: ComposerEnv = {
    tour,
    root: worktree || undefined,
    host: references.host,
    agent,
    generate: generateSuggestion,
    recent: references.recent,
    noteRecent: references.noteRecent,
    repoIndex: indexFor,
  };

  const briefingScreen = (active: boolean) => (
    <BriefingScreen
      tour={tour}
      chapters={chapters}
      allChapters={allChapters}
      order={order}
      cycleOrder={cycleOrder}
      deltaOnly={deltaOnly}
      toggleDelta={toggleDelta}
      states={states}
      analyzing={analyzing}
      agent={agent}
      aiOff={aiOff}
      width={width}
      height={height}
      active={active}
      onTheme={theme.show}
      onStart={resume}
      onSubmit={() => {
        setSubmitFrom('briefing');
        setPhase('submit');
      }}
      readiness={readiness}
      onMerge={!opts.preview && readiness && readiness.level !== 'merged' && readiness.level !== 'closed' ? () => target && setMerging(target) : undefined}
      // Your own PR: t goes back to its feedback, as t on the feedback briefing opens this tour.
      onChecks={!opts.preview && target ? () => setChecking(target) : undefined}
      onFeedback={!opts.preview && target && tour.viewer && tour.viewer === tour.author ? () => void load(target, false, 'author') : undefined}
      onBack={back}
      onQuit={quit}
    />
  );
  const chapterScreen = (active: boolean) => (
    <ChapterScreen
      tour={tour}
      services={services}
      references={references}
      chapters={chapters}
      allChapters={allChapters}
      states={states}
      drafts={drafts}
      ci={Math.min(pos.ci, Math.max(0, chapters.length - 1))}
      hi={pos.hi}
      order={order}
      deltaOnly={deltaOnly}
      banner={banner ?? (analyzing ? `⟳ ${analyzing}` : undefined)}
      agent={agent}
      aiOff={aiOff}
      width={width}
      height={height}
      active={active}
      setPos={setPos}
      setState={setHunkState}
      saveDraft={saveDraft}
      deleteDraft={(d) => {
        store.deleteDraft(d.id);
        setDrafts(store.listDrafts(d.repo, d.pr));
      }}
      replyToThread={opts.preview ? undefined : sendThreadReply}
      reactToComment={opts.preview ? undefined : reactToComment}
      moveHunk={(h, chapterId) => {
        for (const k of hunkKeys(h)) store.setMove(tour.repo, tour.pr, k, chapterId);
        setMoves(store.getMoves(tour.repo, tour.pr));
      }}
      toggleOrder={cycleOrder}
      hideWhitespace={hideWhitespace}
      toggleWhitespace={() => toggleView('hideWhitespace', hideWhitespace, setHideWhitespace)}
      splitDiff={splitDiff}
      toggleSplit={() => toggleView('splitDiff', splitDiff, setSplitDiff)}
      hideTestPane={hideTestPane}
      toggleTestPane={() => setHideTestPane((h) => !h)}
      toggleDelta={toggleDelta}
      openSubmit={() => {
        setSubmitFrom('chapter');
        setPhase('submit');
      }}
      openBriefing={() => setPhase('briefing')}
      openInAgent={(h, c) => void openInAgent(h, c)}
      rebase={newHead && target ? () => void load(target, false, 'review') : undefined}
      onTheme={theme.show}
      back={back}
      quit={quit}
    />
  );
  const submitBackground = () => (submitFrom === 'briefing' ? briefingScreen(false) : chapterScreen(false));
  if (phase === 'briefing' && merging) return mergePopup(briefingScreen(false), merging, tour);
  if (phase === 'briefing' && checking) return checksPopup(briefingScreen(false), checking);
  if (phase === 'briefing') return withThemePicker(briefingScreen);
  if (phase === 'edit' && editing && editState) {
    return (
      <ReviewPopup background={submitBackground()} width={width} height={height} maxWidth={96} maxHeight={editState.ai ? 30 : 16}>
        {(dialogWidth, dialogHeight) => (
          <CommentEditor
            draft={editing}
            target={editing.anchor.type === 'line' || editing.anchor.type === 'range' ? `${editing.anchor.file}:${editing.anchor.line}` : 'flow'}
            hunk={editing.anchor.type === 'line' || editing.anchor.type === 'range' ? tour.hunks[editing.anchor.hunkId] : undefined}
            width={dialogWidth}
            aiRows={editState.ai ? Math.max(4, dialogHeight - aiChromeRows(editState, dialogWidth)) : undefined}
            env={composerEnv}
            state={editState}
            setState={(f) => setEditState((s) => (s ? f(s) : s))}
            onCancel={() => setPhase('submit')}
            onSave={(d) => {
              saveDraft(d);
              setPhase('submit');
            }}
          />
        )}
      </ReviewPopup>
    );
  }
  if (phase === 'submit') {
    if (opts.preview) {
      return (
        <ReviewPopup background={submitBackground()} width={width} height={height} maxWidth={76} maxHeight={9}>
          {() => <PreviewSubmit onBack={() => setPhase(submitFrom)} />}
        </ReviewPopup>
      );
    }
    return (
      <ReviewPopup background={submitBackground()} width={width} height={height} maxWidth={104} maxHeight={34}>
        {(dialogWidth, dialogHeight) => (
          <SubmitScreen
            tour={tour}
            checklist={chapters.flatMap((c) => c.checklist ?? [])}
            confirms={confirms}
            chapters={chapters}
            states={states}
            drafts={drafts}
            width={dialogWidth}
            height={dialogHeight}
            onEdit={(d) => {
              setEditing(d);
              setEditState(initComposer(d, { index: indexFor() }));
              setPhase('edit');
            }}
            onDelete={(d) => {
              store.deleteDraft(d.id);
              setDrafts(store.listDrafts(tour.repo, tour.pr));
            }}
            onPosted={(ids, review, moved) => {
              store.markPosted(ids);
              setDrafts(store.listDrafts(tour.repo, tour.pr));
              setPickerNotice(`Posted review for ${tour.repo}#${tour.pr}: ${review.url}${moved.length ? ` · ${moved.length} comment(s) re-anchored` : ''}`);
              setPhase('pick');
            }}
            onBack={() => setPhase(submitFrom)}
          />
        )}
      </ReviewPopup>
    );
  }
  return withThemePicker(chapterScreen);
}

// ---------- small screens ----------

const INTRO_STEPS = 6;

let scratch: string | undefined;
// An empty directory, made once, for a model call that has no checkout to read. It is removed
// when the process exits, however the app was quit.
function emptyDir(): string {
  if (!scratch) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-merge-'));
    scratch = dir;
    process.once('exit', () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    });
  }
  return scratch;
}

function OwnPrompt(props: { target: Target; title?: string; onFeedback: () => void; onTour: () => void; onBack?: () => void; onQuit: () => void }) {
  useInput((input, key) => {
    if (key.return || input === 'f') props.onFeedback();
    if (input === 't') props.onTour();
    if (input === 'q' || key.escape) (props.onBack ?? props.onQuit)();
    if (input === 'Q') props.onQuit();
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>
        {props.target.repo}#{props.target.number} {props.title ? sanitizeTerminal(props.title) : ''}
      </Text>
      <Text>This is your PR. Open the feedback on it (Enter) or the full tour (t)?</Text>
      <Text dimColor>The feedback lists the review threads to answer, in order; gr feedback opens it directly. {props.onBack ? 'q: PR list · Q: quit' : 'q: quit'}</Text>
    </Box>
  );
}

function ErrorScreen(props: { message: string; onRetry: () => void; onBack?: () => void; onQuit: () => void }) {
  useInput((input) => {
    if (input === 'r') props.onRetry();
    if (input === 'q') (props.onBack ?? props.onQuit)();
    if (input === 'Q') props.onQuit();
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="red" bold>
        Could not open the tour
      </Text>
      <Text>{props.message}</Text>
      <Text dimColor>r: retry · {props.onBack ? 'q: PR list · Q: quit' : 'q: quit'}</Text>
    </Box>
  );
}

function PreviewSubmit(props: { onBack: () => void }) {
  useInput(() => props.onBack());
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Author preview</Text>
      <Text>This tour is a preview of your branch: there is no PR to post to yet. Flagged gaps and drafts stay local.</Text>
      <Text dimColor>any key to go back</Text>
    </Box>
  );
}
