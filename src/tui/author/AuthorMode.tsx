import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useInput } from 'ink';
import { Box, Text } from '../themed.js';
import type { Chapter, DiffLine, ExistingReview, ExistingThread, IssueComment, ReactionContent, ThreadComment, Tour } from '../../types.js';
import type { Store } from '../../store/db.js';
import {
  fetchIssueComments,
  fetchMergeStatus,
  fetchPendingReviewers,
  fetchReviews,
  fetchThreads,
  getMentionUsers,
  setCommentReaction,
  setThreadResolved,
  viewerLogin,
  type MergeStatus,
  type PendingReviewers,
} from '../../github/gh.js';
import { isSharedTourComment } from '../../github/sharedTour.js';
import {
  CONVERSATION,
  buildFeedback,
  conversationSources,
  groupFeedback,
  handoffPrompt,
  rerequestByDefault,
  rerequestCandidates,
  reviewerStatus,
  silentWontDo,
  type FeedbackItem,
  type QueuedReply,
  type ThreadDiffs,
  type Triage,
} from '../../review/feedback.js';
import { loadThreadDiffs } from '../../review/threadDiffs.js';
import { mergeReadiness } from '../../review/merge.js';
import { analyzeFeedback, type FeedbackAnalysis } from '../../agent/feedback.js';
import type { AgentContext } from '../../agent/types.js';
import { sha1 } from '../../util/hash.js';
import { FeedbackBriefing } from './FeedbackBriefing.js';
import { FeedbackScreen } from './FeedbackScreen.js';
import { SendScreen } from './SendScreen.js';
import { CommentComposer } from './CommentComposer.js';
import { ChecksPopup, MergePopup, ReviewersPopup } from '../prPopups.js';
import { CHECK_POLL_MS } from '../ChecksScreen.js';
import { ReviewPopup } from '../ReviewPopup.js';
import { useMentions } from '../chapter/mentions.js';
import { renderMarkdown, MdLineView } from '../markdown.js';
import { sanitizeTerminal as safe } from '../../util/sanitize.js';
import { writeClipboard } from '../../util/clipboard.js';
import { plural } from '../plural.js';
import { RepoIndex } from '../../analysis/repoIndex.js';
import { Hints, type Hint } from '../KeyBar.js';

interface Live {
  threads: ExistingThread[];
  reviews: ExistingReview[];
  comments: IssueComment[];
  viewer?: string;
  merge?: MergeStatus;
  pending?: PendingReviewers; // who is asked to review and has not answered
  diffs: ThreadDiffs;
  diffsReady: boolean; // the diffs that follow outdated threads to the head have been read
  gen: number; // the load this came from
}

type Screen = 'briefing' | 'threads' | 'send';
type Handoff = { prompt: string };

// Author mode: the feedback on the author's own PR as a work list. App loads the tour (a static
// one is enough) and hands it over; this reads the live threads, reviews and merge state, and
// owns everything from the feedback briefing to sending replies.
export function AuthorMode(props: {
  tour: Tour;
  chapters: Chapter[];
  worktree: string;
  store: Store;
  agent?: AgentContext;
  aiOff?: string;
  newHead?: string;
  writing?: string; // the briefing is still being written
  width: number;
  height: number;
  active: boolean;
  onReload: () => void; // rebuild on the PR's current head
  onFullTour: () => void;
  copy?: (text: string) => Promise<'tool' | 'terminal'>; // tests stub the clipboard
  onMerged: (notice: string) => void;
  onTheme?: () => void;
  onBack?: () => void;
  onQuit: () => void;
}) {
  const { tour, store, width, height } = props;
  const [live, setLive] = useState<Live>();
  const [error, setError] = useState('');
  const [screen, setScreen] = useState<Screen>('briefing');
  const [sendFrom, setSendFrom] = useState<Exclude<Screen, 'send'>>('briefing'); // where Esc on the send screen returns
  const [merging, setMerging] = useState(false);
  const [reviewersOpen, setReviewersOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const [checksRefreshing, setChecksRefreshing] = useState(false);
  const [handoff, setHandoff] = useState<Handoff>();
  const [showHidden, setShowHidden] = useState(false);
  const [triage, setTriageState] = useState<Record<string, Triage>>(() => store.getTriage(tour.repo, tour.pr));
  const [queued, setQueued] = useState<QueuedReply[]>(() => store.listReplies(tour.repo, tour.pr));
  const [analysis, setAnalysis] = useState<FeedbackAnalysis>();
  const [analyzing, setAnalyzing] = useState<string>();
  const [since, setSince] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pos, setPos] = useState({ ci: 0, ii: 0 });
  const [mentionsWanted, setMentionsWanted] = useState(false);
  // The conversation comment's composer.
  const [composing, setComposing] = useState<{ start: 'pick' | 'edit' }>(); // the send screen stays under it while open
  useEffect(() => {
    if (composing) setMentionsWanted(true);
  }, [composing]);
  const loadGen = useRef(0);

  const load = useCallback(async () => {
    const gen = ++loadGen.current;
    setError('');
    try {
      const [threads, reviews, comments, viewer, merge, pending] = await Promise.all([
        fetchThreads(tour.repo, tour.pr),
        fetchReviews(tour.repo, tour.pr),
        fetchIssueComments(tour.repo, tour.pr).catch(() => [] as IssueComment[]),
        viewerLogin().catch(() => undefined),
        fetchMergeStatus(tour.repo, tour.pr).catch(() => undefined),
        fetchPendingReviewers(tour.repo, tour.pr).catch(() => undefined),
      ]);
      if (gen !== loadGen.current) return;
      // Show the feedback now: reading the thread diffs can fetch commits one by one. Until they
      // are in, an outdated thread falls back to its own snippet.
      setLive({ threads, reviews, comments: comments.filter((c) => !isSharedTourComment(c.body)), viewer, merge, pending, diffs: new Map(), diffsReady: false, gen });
      const diffs = await loadThreadDiffs(props.worktree, tour.headSha, threads, { all: true }).catch(() => new Map() as ThreadDiffs);
      if (gen !== loadGen.current) return;
      setLive((l) => (l && l.gen === gen ? { ...l, diffs, diffsReady: true } : l));
    } catch (e) {
      if (gen === loadGen.current) setError((e as Error).message);
    }
  }, [tour.repo, tour.pr, tour.headSha, props.worktree]);
  useEffect(() => {
    void load();
  }, [load]);

  // Who is asked to review, read again after the reviewers popup changed it.
  const refreshPending = useCallback(() => {
    fetchPendingReviewers(tour.repo, tour.pr).then(
      (pending) => setLive((l) => (l ? { ...l, pending } : l)),
      () => undefined,
    );
  }, [tour.repo, tour.pr]);

  // Checks alone, read again while any is running, and on R in the checks popup.
  const refreshChecks = useCallback(() => {
    setChecksRefreshing(true);
    fetchMergeStatus(tour.repo, tour.pr)
      .then(
        (merge) => setLive((l) => (l ? { ...l, merge } : l)),
        () => undefined,
      )
      .finally(() => setChecksRefreshing(false));
  }, [tour.repo, tour.pr]);
  const running = !!live?.merge?.checks.pending;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(refreshChecks, CHECK_POLL_MS);
    return () => clearInterval(t);
  }, [running, refreshChecks]);

  const items = useMemo(
    () => (live ? buildFeedback(tour, live.threads, { author: tour.author, diffs: live.diffs, latestCommitAt: live.merge?.headCommittedAt, triage, classes: analysis?.classes }) : []),
    [live, tour, triage, analysis],
  );
  const groups = useMemo(() => groupFeedback(items, props.chapters, { showHidden }), [items, props.chapters, showHidden]);
  const reviewers = useMemo(() => (live ? reviewerStatus(live.reviews, tour.author, live.merge?.headCommittedAt) : []), [live, tour.author]);
  const readiness = live?.merge && mergeReadiness(live.merge);
  const silent = useMemo(() => silentWontDo(items, queued), [items, queued]);

  // "Since your last visit", worked out once per load, once the thread diffs are in (which
  // threads are probably addressed depends on them), then this visit is remembered.
  const visited = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!live?.diffsReady || visited.current === live.gen) return;
    visited.current = live.gen;
    const prev = store.getVisit(tour.repo, tour.pr);
    const addressed = items.filter((i) => i.state === 'addressed').map((i) => i.thread.id);
    const others = live.threads.flatMap((t) => t.comments).filter((c) => c.author !== tour.author);
    if (prev) {
      const newlyAddressed = addressed.filter((id) => !prev.addressed.includes(id)).length;
      const fresh = others.filter((c) => c.createdAt > prev.at);
      const by = [...new Set(fresh.map((c) => `@${c.author}`))];
      const parts = [
        newlyAddressed ? `${plural(newlyAddressed, 'thread')} probably addressed by your commits` : '',
        fresh.length ? `${plural(fresh.length, 'new comment')} from ${by.slice(0, 3).join(', ')}${by.length > 3 ? ` and ${by.length - 3} more` : ''}` : '',
      ].filter(Boolean);
      setSince(parts.length ? `Since your last visit: ${parts.join(', ')}.` : prev.head !== tour.headSha ? 'Since your last visit: you pushed, and no new comments.' : undefined);
    }
    store.setVisit(tour.repo, tour.pr, { head: tour.headSha, at: new Date().toISOString(), addressed, comments: others.length });
  }, [live, items, store, tour.repo, tour.pr, tour.headSha, tour.author]);

  // The model's themes and classes, kept while the threads stay the same.
  const agent = props.agent;
  useEffect(() => {
    if (!live || !agent) return;
    const open = items.filter((i) => i.state !== 'resolved');
    if (!open.length) return;
    const key = sha1(open.map((i) => `${i.thread.id}:${i.thread.comments.length}`).join('\n'));
    const cached = store.getFeedbackModel<FeedbackAnalysis>(tour.repo, tour.pr, key);
    if (cached) return setAnalysis(cached);
    const ac = new AbortController();
    setAnalyzing('Reading the feedback for themes…');
    analyzeFeedback(tour, open, agent, ac.signal).then(
      (r) => {
        if (ac.signal.aborted) return;
        store.setFeedbackModel(tour.repo, tour.pr, key, r.value);
        setAnalysis(r.value);
        setAnalyzing(undefined);
      },
      (e: unknown) => {
        if (!ac.signal.aborted) setAnalyzing(`Themes unavailable: ${(e as Error).message.slice(0, 120)}`);
      },
    );
    return () => ac.abort();
    // Only a new load (or a different model) starts this again, not triage or class changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.gen, agent]);

  // Keep the selection on the same thread when the lists change under it.
  const current = groups[pos.ci]?.items[pos.ii]?.thread.id;
  const keep = useRef<string | undefined>(undefined);
  keep.current = current ?? keep.current;
  useEffect(() => {
    const id = keep.current;
    if (!id) return;
    for (const [ci, g] of groups.entries()) {
      const ii = g.items.findIndex((i) => i.thread.id === id);
      if (ii >= 0) return setPos({ ci, ii });
    }
    setPos((p) => ({ ci: Math.min(p.ci, Math.max(0, groups.length - 1)), ii: 0 }));
  }, [groups]);

  const mentionTour = useMemo(() => (live ? { ...tour, existingThreads: live.threads, existingReviews: live.reviews } : tour), [live, tour]);
  const mentions = useMentions(mentionTour, mentionsWanted, () => getMentionUsers(tour.repo));

  const setTriage = (item: FeedbackItem, t: Triage | undefined) => {
    store.setTriage(tour.repo, tour.pr, item.thread.id, t);
    setTriageState(store.getTriage(tour.repo, tour.pr));
  };
  const saveReply = (threadId: string, body: string, resolve: boolean) => {
    store.saveReply(tour.repo, tour.pr, { threadId, body, resolve });
    setQueued(store.listReplies(tour.repo, tour.pr));
  };
  const updateThreads = (f: (t: ExistingThread) => ExistingThread) => setLive((l) => (l ? { ...l, threads: l.threads.map(f) } : l));
  const resolve = async (item: FeedbackItem, resolved: boolean) => {
    const now = await setThreadResolved(item.thread.id, resolved);
    updateThreads((t) => (t.id === item.thread.id ? { ...t, isResolved: now } : t));
  };
  const react = async (comment: ThreadComment, content: ReactionContent, remove: boolean) => {
    if (!comment.nodeId) throw new Error('This comment cannot receive reactions.');
    const reactionGroups = await setCommentReaction(comment.nodeId, content, remove);
    updateThreads((t) => ({ ...t, comments: t.comments.map((c) => (c.nodeId === comment.nodeId ? { ...c, reactionGroups } : c)) }));
  };
  // o: the prompt for the author's own coding agent, shown and copied, never run from here:
  // gr's PR worktree is a detached copy, so a fix made there would not be on the branch.
  const startHandoff = (item: FeedbackItem, code: DiffLine[]) => setHandoff({ prompt: handoffPrompt(tour, item, code) });
  // Puts `text` on the clipboard and says what happened: `shown` names it on success, `name` on failure.
  const copyText = (text: string, shown: string, name: string): Promise<string> =>
    (props.copy ?? writeClipboard)(text).then(
      (how) => (how === 'tool' ? `Copied ${shown}` : `Asked your terminal to copy ${shown}`),
      (e: unknown) => `Couldn't copy ${name}: ${(e as Error).message}`,
    );

  // Finds the code a thread names: one per checkout and head, its caches kept across threads.
  const codeIndex = useMemo(
    () => (props.worktree ? new RepoIndex({ root: props.worktree, headSha: tour.headSha, changedFiles: tour.files.map((f) => f.path) }) : undefined),
    [props.worktree, tour.headSha, tour.files],
  );
  const banner = props.newHead ? `You pushed ${props.newHead.slice(0, 8)}. Press R to refresh onto it (triage and queued replies are kept).` : notice;
  const refresh = () => {
    setNotice(undefined);
    if (props.newHead) return props.onReload();
    setLive(undefined);
    void load();
  };
  const notes: string[] = [];
  if (live?.viewer && live.viewer !== tour.author) notes.push(`This is @${tour.author}'s PR: replies you send come from you (@${live.viewer}).`);

  useInput(
    (input, key) => {
      if (input === 'r' || input === 'R') return refresh();
      if (key.escape) return props.onBack?.();
      if (input === 'q') return (props.onBack ?? props.onQuit)();
      if (input === 'Q') return props.onQuit();
    },
    { isActive: props.active && !live },
  );
  if (!live) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>
          {safe(tour.repo)}#{tour.pr} · feedback
        </Text>
        {error ? <Text color="red">Could not read the feedback: {safe(error)}</Text> : <Text dimColor>Reading review threads, reviews and merge status…</Text>}
        <Hints keys={[...((error ? [['R', 'retry']] : []) as Hint[]), ['q', 'back'], ['Q', 'quit']]} />
      </Box>
    );
  }

  const onMerge = readiness && readiness.level !== 'merged' && readiness.level !== 'closed' ? () => setMerging(true) : undefined;
  // Y: the PR's link on the clipboard. Says what happened, for the screen to show.
  const copyUrl = (): Promise<string> => copyText(tour.url, tour.url, 'the link');
  const base = (active: boolean): ReactNode => {
    if (screen === 'threads')
      return (
        <FeedbackScreen
          tour={tour}
          groups={groups}
          pos={pos}
          setPos={setPos}
          queued={queued}
          root={props.worktree}
          codeIndex={codeIndex}
          agent={agent}
          aiOff={props.aiOff}
          mentions={mentions}
          wantMentions={setMentionsWanted}
          banner={banner}
          showHidden={showHidden}
          width={width}
          height={height}
          active={active}
          onTriage={setTriage}
          onSaveReply={saveReply}
          onResolve={resolve}
          onReact={react}
          onHandoff={startHandoff}
          onToggleHidden={() => setShowHidden((h) => !h)}
          onSend={() => {
            setSendFrom('threads');
            setScreen('send');
          }}
          onBriefing={() => setScreen('briefing')}
          onMerge={onMerge}
          onCopyUrl={copyUrl}
          onRefresh={refresh}
          onTheme={props.onTheme}
          onBack={props.onBack}
          onQuit={props.onQuit}
        />
      );
    return (
      <FeedbackBriefing
        tour={tour}
        items={items}
        groups={groups}
        reviewers={reviewers}
        reviews={live.reviews}
        comments={live.comments}
        readiness={readiness}
        checks={live.merge?.checks}
        onChecks={() => setChecksOpen(true)}
        onReviewers={() => setReviewersOpen(true)}
        pending={live.pending}
        since={since}
        themes={analysis?.themes}
        analyzing={analyzing}
        following={!live.diffsReady}
        queued={queued.length}
        commentQueued={queued.some((q) => q.threadId === CONVERSATION)}
        showHidden={showHidden}
        silent={silent.length}
        notes={notes}
        writing={props.writing}
        banner={banner}
        width={width}
        height={height}
        active={active}
        onStart={(ci) => {
          if (ci !== undefined) setPos({ ci, ii: 0 });
          setScreen('threads');
        }}
        onSend={() => {
          setSendFrom('briefing');
          setScreen('send');
        }}
        onComment={() => setComposing({ start: 'pick' })}
        onMerge={onMerge}
        onCopyUrl={copyUrl}
        onToggleHidden={() => setShowHidden((h) => !h)}
        onFullTour={props.onFullTour}
        onRefresh={refresh}
        onTheme={props.onTheme}
        onBack={props.onBack}
        onQuit={props.onQuit}
      />
    );
  };

  const popupOpen = merging || checksOpen || reviewersOpen || !!handoff || !!composing || screen === 'send';
  const background = base(props.active && !popupOpen);
  if (reviewersOpen) {
    return (
      <ReviewersPopup
        background={background}
        width={width}
        height={height}
        repo={tour.repo}
        number={tour.pr}
        onQuit={props.onQuit}
        onClose={(changed) => {
          setReviewersOpen(false);
          if (changed) refreshPending();
        }}
      />
    );
  }
  if (checksOpen) {
    return (
      <ChecksPopup
        background={background}
        width={width}
        height={height}
        repo={tour.repo}
        number={tour.pr}
        loaded={{ headSha: live.merge?.headSha ?? tour.headSha, checks: live.merge?.checks.items ?? [], refreshing: checksRefreshing, onRefresh: refreshChecks }}
        onClose={() => setChecksOpen(false)}
        onQuit={props.onQuit}
      />
    );
  }
  if (merging) {
    return (
      <MergePopup
        background={background}
        width={width}
        height={height}
        repo={tour.repo}
        number={tour.pr}
        tour={tour}
        agent={agent}
        onCancel={() => setMerging(false)}
        onQuit={props.onQuit}
        onDone={(n) => {
          setMerging(false);
          props.onMerged(n);
        }}
      />
    );
  }
  if (handoff) {
    return (
      <ReviewPopup background={background} width={width} height={height} maxWidth={110} maxHeight={34}>
        {(w, h) => (
          <HandoffPreview
            handoff={handoff}
            width={w}
            height={h}
            onCopy={() => copyText(handoff.prompt, 'the prompt: paste it into your coding agent in a checkout of the branch', 'the prompt')}
            onClose={() => setHandoff(undefined)}
          />
        )}
      </ReviewPopup>
    );
  }
  if (composing) {
    const done = () => {
      setComposing(undefined);
      setMentionsWanted(false);
    };
    return (
      <ReviewPopup background={background} width={width} height={height} maxWidth={100} maxHeight={24}>
        {(w, h) => (
          <CommentComposer
            sources={conversationSources(live.reviews, live.comments, tour.author)}
            body={queued.find((q) => q.threadId === CONVERSATION)?.body ?? ''}
            start={composing.start}
            mentions={mentions}
            width={w}
            height={h}
            onSave={(body) => {
              saveReply(CONVERSATION, body, false);
              setNotice(body.trim() ? 'Comment queued. Nothing posts until you send (s).' : 'Queued comment removed.');
              done();
            }}
            onCancel={done}
          />
        )}
      </ReviewPopup>
    );
  }
  if (screen === 'send') {
    const candidates = rerequestCandidates(reviewers);
    return (
      <ReviewPopup background={background} width={width} height={height} maxWidth={104} maxHeight={30}>
        {(w, h) => (
          <SendScreen
            tour={tour}
            headSha={live.merge?.headSha ?? tour.headSha}
            newHead={props.newHead}
            items={items}
            queued={queued}
            candidates={candidates}
            rerequestDefault={rerequestByDefault(items, queued)}
            silent={silent}
            width={w}
            height={h}
            onEdit={(id) => {
              if (id === CONVERSATION) return setComposing({ start: 'edit' });
              for (const [ci, g] of groupFeedback(items, props.chapters, { showHidden: true }).entries()) {
                const ii = g.items.findIndex((i) => i.thread.id === id);
                if (ii < 0) continue;
                setShowHidden(true);
                keep.current = id;
                setPos({ ci, ii });
                break;
              }
              setScreen('threads');
            }}
            onToggleResolve={(q) => saveReply(q.threadId, q.body, !q.resolve)}
            onDelete={(q) => {
              store.deleteReplies(tour.repo, tour.pr, [q.threadId]);
              setQueued(store.listReplies(tour.repo, tour.pr));
            }}
            onSent={(n, ids) => {
              store.deleteReplies(tour.repo, tour.pr, ids);
              setQueued(store.listReplies(tour.repo, tour.pr));
              setNotice(n);
              setScreen('briefing');
              void load();
            }}
            onBack={() => setScreen(sendFrom)}
            onQuit={props.onQuit}
          />
        )}
      </ReviewPopup>
    );
  }
  return background;
}

// The prompt for the author's coding agent, to copy: it carries reviewer text, so it is read first.
function HandoffPreview(props: { handoff: Handoff; width: number; height: number; onCopy: () => Promise<string>; onClose: () => void }) {
  const { handoff: h, width } = props;
  const [top, setTop] = useState(0);
  const [flash, setFlash] = useState('');
  const lines = useMemo(() => renderMarkdown(h.prompt, width - 2), [h.prompt, width]);
  const room = Math.max(3, props.height - 5);
  useInput((input, key) => {
    if (key.escape || input === 'q') return props.onClose();
    if (key.return || input === 'c') return void props.onCopy().then(setFlash);
    if (input === 'j' || key.downArrow) setTop((t) => Math.min(Math.max(0, lines.length - room), t + 1));
    if (input === 'k' || key.upArrow) setTop((t) => Math.max(0, t - 1));
  });
  return (
    <Box flexDirection="column" paddingX={1} width={width} height={props.height}>
      <Text bold wrap="truncate">
        Prompt for your coding agent <Text dimColor>· run it yourself, in a checkout of the PR's branch</Text>
      </Text>
      <Text dimColor wrap="truncate">
        The reviewer's text is quoted in it as untrusted: read the prompt before you give it to an agent that can edit files.
      </Text>
      <Box flexDirection="column" height={room} overflow="hidden" marginTop={1}>
        {lines.slice(top, top + room).map((l, i) => (
          <MdLineView key={top + i} line={l} />
        ))}
      </Box>
      {flash ? (
        <Text color="yellow" wrap="truncate">
          {safe(flash)}
        </Text>
      ) : (
        <Hints
          keys={[
            ['enter', 'copy the prompt'],
            ['j/k', 'scroll'],
            ['esc', 'close'],
          ]}
        />
      )}
    </Box>
  );
}
