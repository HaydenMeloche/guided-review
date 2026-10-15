import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { spawnSync } from 'node:child_process';
import type { Chapter, ChapterOrder, Draft, ExistingThread, Hunk, PRInfo, ReactionContent, ReadState, ThreadComment, Tour } from '../types.js';
import { Store } from '../store/db.js';
import { fetchHeadSha, fetchPR, fetchThreads, getMentionUsers, replyToThread, setCommentReaction } from '../github/gh.js';
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
import { PickerScreen, keyFor, type DownloadJob, type Target as PickTarget } from './PickerScreen.js';
import { TourIntro, type IntroLine } from './TourIntro.js';

export interface Target {
  repo: string;
  number: number;
}

export interface AppOptions {
  target?: Target; // undefined: pick from PRs awaiting your review
  localRepo?: string;
  agent?: AgentRouting;
  chapterOrder?: ChapterOrder; // the user's default; a PR's saved order wins
  hideWhitespace?: boolean; // the user's saved w setting; on when unset
  splitDiff?: boolean; // the user's saved S setting; off when unset
  saveViewSetting?: (key: ViewSetting, value: boolean) => void; // records a w or S toggle for next time
  noAgent?: boolean;
  fresh?: boolean;
  preview?: { pr: PRInfo; diff: string; worktree: string }; // author mode on a local branch
}

type Phase = 'pick' | 'load' | 'briefing' | 'chapter' | 'submit' | 'edit' | 'error';

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

function chaptersForOrder(tour: Tour, order: ChapterOrder, moves: Record<string, string>, deltaOnly: boolean): Chapter[] {
  const base = order === 'file' ? fileOrderChapters(tour.files, tour.hunks) : tour.chapters;
  let chapters = applyMoves(base, tour, moves);
  if (deltaOnly && tour.rereview) {
    const delta = new Set(tour.rereview.newHunkIds);
    chapters = chapters.map((c) => ({ ...c, hunkIds: c.hunkIds.filter((id) => delta.has(id)) })).filter((c) => c.hunkIds.length);
  }
  return sortChapters(chapters, tour, order);
}

export function App(opts: AppOptions) {
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
  const [confirms, setConfirms] = useState<Record<string, boolean>>({});
  const [prTitle, setPrTitle] = useState<string | undefined>();
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
  const onProgress = useCallback((name: string, done?: boolean) => {
    setSteps((s) => {
      const base = name.replace(/ \d+\/\d+$/, '');
      const i = s.findIndex((x) => x.name.replace(/ \d+\/\d+$/, '') === base);
      if (i < 0) return [...s, { name, done: !!done }];
      const copy = [...s];
      copy[i] = { name, done: !!done };
      return copy;
    });
    if (name.startsWith('Narrating')) setAnalyzing(done ? undefined : name);
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

  const load = useCallback(
    async (t: Target, fresh = opts.fresh) => {
      const gen = ++loadGen.current;
      loadAbort.current?.abort();
      const abort = new AbortController();
      loadAbort.current = abort;
      const { signal } = abort;
      agentSessions.current = {};
      setPhase('load');
      setPrTitle(undefined);
      setSteps([]);
      setError('');
      setBanner(undefined);
      setNewHead(undefined);
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
        flagDraftsOnChangedLines(final);
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
    [opts, store, onProgress, flagDraftsOnChangedLines],
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

  // ---------- derived ----------
  const chapters: Chapter[] = useMemo(() => {
    if (!tour) return [];
    return chaptersForOrder(tour, order, moves, deltaOnly);
  }, [tour, order, moves, deltaOnly]);

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
            existingThreads:
              threads ?? current.existingThreads.map((t) => (t.id === thread.id ? { ...t, comments: [...t.comments, { author: 'you', body, createdAt: new Date().toISOString() }] } : t)),
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

  const openInClaude = async (h: Hunk | undefined, c: Chapter) => {
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
    await suspendTerminal(() => {
      const r = spawnSync('claude', [prompt], { stdio: 'inherit', cwd: worktree || process.cwd() });
      if (r.error) process.stderr.write(`Could not start claude: ${r.error.message}\n`);
    });
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

  // ---------- screens ----------
  const width = columns;
  const height = rows;

  if (phase === 'pick') {
    return (
      <PickerScreen
        store={store}
        notice={pickerNotice}
        width={width}
        height={height}
        onPick={(t) => {
          setPickerNotice(undefined);
          setTarget(t);
          void load(t);
        }}
        downloads={downloads}
        onDownload={startDownloads}
        onQuit={quit}
      />
    );
  }
  if (phase === 'error') {
    return <ErrorScreen message={error} onRetry={() => target && void load(target, true)} onQuit={quit} />;
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
      [{ text: 'The briefing opens as soon as it is written · q to quit', dim: true }],
    ];
  };
  if (phase === 'load' || !tour) {
    return <TourIntro width={width} height={height} lines={introLines} onQuit={quit} />;
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

  const briefingScreen = (active: boolean) => (
    <BriefingScreen
      tour={tour}
      chapters={chapters}
      order={order}
      cycleOrder={cycleOrder}
      states={states}
      analyzing={analyzing}
      agent={agent}
      width={width}
      height={height}
      active={active}
      onStart={resume}
      onSubmit={() => {
        setSubmitFrom('briefing');
        setPhase('submit');
      }}
      onQuit={quit}
    />
  );
  const chapterScreen = (active: boolean) => (
    <ChapterScreen
      tour={tour}
      services={services}
      chapters={chapters}
      states={states}
      drafts={drafts}
      ci={Math.min(pos.ci, Math.max(0, chapters.length - 1))}
      hi={pos.hi}
      order={order}
      deltaOnly={deltaOnly}
      banner={banner ?? (analyzing ? `⟳ ${analyzing}` : undefined)}
      agent={agent}
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
      toggleDelta={() => {
        setDeltaOnly((d) => !d);
        setPosState({ ci: 0, hi: 0 });
      }}
      openSubmit={() => {
        setSubmitFrom('chapter');
        setPhase('submit');
      }}
      openBriefing={() => setPhase('briefing')}
      openInClaude={(h, c) => void openInClaude(h, c)}
      rebase={newHead && target ? () => void load(target, false) : undefined}
      quit={quit}
    />
  );
  const submitBackground = () => (submitFrom === 'briefing' ? briefingScreen(false) : chapterScreen(false));
  if (phase === 'briefing') return <ReviewPopup background={briefingScreen(true)} width={width} height={height} maxWidth={104} maxHeight={34} />;
  if (phase === 'edit' && editing) {
    return (
      <ReviewPopup background={submitBackground()} width={width} height={height} maxWidth={96} maxHeight={16}>
        {(dialogWidth) => (
          <CommentEditor
            draft={editing}
            target={editing.anchor.type === 'line' || editing.anchor.type === 'range' ? `${editing.anchor.file}:${editing.anchor.line}` : 'flow'}
            hunk={editing.anchor.type === 'line' || editing.anchor.type === 'range' ? tour.hunks[editing.anchor.hunkId] : undefined}
            width={dialogWidth}
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
  return <ReviewPopup background={chapterScreen(true)} width={width} height={height} maxWidth={104} maxHeight={34} />;
}

// ---------- small screens ----------

const INTRO_STEPS = 6;

function ErrorScreen(props: { message: string; onRetry: () => void; onQuit: () => void }) {
  useInput((input) => {
    if (input === 'r') props.onRetry();
    if (input === 'q') props.onQuit();
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="red" bold>
        Could not open the tour
      </Text>
      <Text>{props.message}</Text>
      <Text dimColor>r: retry · q: quit</Text>
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
