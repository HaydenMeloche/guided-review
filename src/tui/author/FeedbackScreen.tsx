import { useEffect, useMemo, useRef, useState } from 'react';
import { useInput } from '../input.js';
import { Box, Text } from '../themed.js';
import { Confirm } from '../Confirm.js';
import type { DiffLine, Hunk, ReactionContent, ThreadComment, Tour } from '../../types.js';
import { CLASS_LABEL, isBlocking, snippetLines, STATE_LABEL, TRIAGE_CYCLE, TRIAGE_LABEL, type FeedbackChapter, type FeedbackItem, type QueuedReply, type Triage } from '../../review/feedback.js';
import { draftReply, threadContext } from '../../agent/feedback.js';
import type { AgentContext } from '../../agent/types.js';
import { SourcePane } from '../chapter/SourcePane.js';
import { useFolds } from '../chapter/hunkView.js';
import { AskOverlay } from '../AskOverlay.js';
import { TextInput } from '../TextInput.js';
import { Hints, KeyBar, type Hint } from '../KeyBar.js';
import { MdLineView, renderMarkdown, type MdLine } from '../markdown.js';
import { mentionHighlight } from '../completion.js';
import { pad } from '../nav.js';
import { age } from '../PickerScreen.js';
import { STATE_COLOR, chapterMark } from './FeedbackBriefing.js';
import { THREAD_KEYS, threadBar } from './keys.js';
import { HelpPopup } from '../Help.js';
import { helpOf, readsKey } from '../keys.js';
import { sanitizeTerminal as safe } from '../../util/sanitize.js';
import { githubWebHost } from '../../github/auth.js';
import { findFileLinks, type FileLink } from '../../review/fileLinks.js';
import { codeTerms, resolveCodeRefs, type CodeRef } from '../../review/codeRefs.js';
import type { RepoIndex } from '../../analysis/repoIndex.js';
import { plural } from '../plural.js';
import { FilePreview } from '../FilePreview.js';
import { TONE_COLOR, unboundKey, useFlash } from '../flash.js';
import { REGULAR } from '../breakpoints.js';
import { TitleBar } from '../TitleBar.js';

// The file preview needs room beside the thread; narrower terminals keep the thread full width.
const PREVIEW_MIN_WIDTH = REGULAR;

const REACTIONS: { content: ReactionContent; emoji: string }[] = [
  { content: 'THUMBS_UP', emoji: '👍' },
  { content: 'THUMBS_DOWN', emoji: '👎' },
  { content: 'LAUGH', emoji: '😄' },
  { content: 'CONFUSED', emoji: '😕' },
  { content: 'HEART', emoji: '❤️' },
  { content: 'HOORAY', emoji: '🎉' },
  { content: 'ROCKET', emoji: '🚀' },
  { content: 'EYES', emoji: '👀' },
];

const TRIAGE_COLOR: Record<Triage, string> = { will: 'cyan', done: 'green', wont: 'red', discuss: 'blue' };
// The triage picker's choices, by the number that sets each.
const TRIAGE_CHOICES = TRIAGE_CYCLE.filter((t): t is Triage => !!t);

type Mode =
  | { kind: 'browse' }
  | { kind: 'reply' }
  | { kind: 'react' }
  | { kind: 'triage' }
  | { kind: 'resolve' }
  | { kind: 'ask' }
  | { kind: 'help' }
  | { kind: 'ai'; busy: boolean; draft?: { reply: string; notes: string[] }; error?: string }
  | { kind: 'refine'; draft: { reply: string; notes: string[] } };

// The code a thread is on: its tour hunk, or the comment's own diff hunk when its line is no
// longer in the diff. `idx` is the commented line.
export function threadCode(tour: Tour, item: FeedbackItem): { hunk: Hunk; idx: number; snippet: boolean } | undefined {
  const p = item.placement;
  const h = p.hunkId ? tour.hunks[p.hunkId] : undefined;
  if (h) {
    const idx = h.lines.findIndex((l) => (p.side === 'LEFT' ? l.kind === 'del' && l.oldLine === p.line : l.kind !== 'del' && l.newLine === p.line));
    return { hunk: h, idx: Math.max(0, idx), snippet: false };
  }
  const lines = snippetLines(item.thread.diffHunk);
  if (!lines.length) return undefined;
  const first = lines.find((l) => l.newLine !== undefined)?.newLine ?? 1;
  const old = lines.find((l) => l.oldLine !== undefined)?.oldLine ?? 1;
  const hunk: Hunk = {
    id: `snippet-${item.thread.id}`,
    contentHash: '',
    file: p.path,
    header: item.thread.diffHunk?.split('\n')[0] ?? '',
    oldStart: old,
    oldLines: lines.filter((l) => l.kind !== 'add').length,
    newStart: first,
    newLines: lines.filter((l) => l.kind !== 'del').length,
    lines,
    symbols: [],
    risk: 0,
    riskReasons: [],
    tests: [],
    coverage: 'n/a',
  };
  return { hunk, idx: lines.length - 1, snippet: true };
}

const HOW: Record<FeedbackItem['placement']['how'], string> = {
  current: '',
  mapped: 'outdated, followed to the current head',
  nearest: 'outdated, on the nearest surviving line',
  snippet: 'outdated, shown as it was',
  file: 'on the whole file',
};

// One feedback thread at a time: where it is and what state it is in, the code under it, the
// discussion, and the author's queued reply. Replies queue locally; s sends them together.
type Props = {
  tour: Tour;
  groups: FeedbackChapter[];
  pos: { ci: number; ii: number };
  setPos: (pos: { ci: number; ii: number }) => void;
  queued: QueuedReply[];
  root?: string;
  codeIndex?: Pick<RepoIndex, 'symbols' | 'files'>; // looks up code the thread names
  agent?: AgentContext;
  aiOff?: string;
  mentions: string[];
  wantMentions: (open: boolean) => void;
  banner?: string;
  showHidden: boolean;
  width: number;
  height: number;
  active: boolean;
  onTriage: (item: FeedbackItem, triage: Triage | undefined) => void;
  onSaveReply: (threadId: string, body: string, resolve: boolean) => void;
  onResolve: (item: FeedbackItem, resolved: boolean) => Promise<void>;
  onReact: (comment: ThreadComment, content: ReactionContent, remove: boolean) => Promise<void>;
  onHandoff: (item: FeedbackItem, code: DiffLine[]) => void;
  onToggleHidden: () => void;
  onSend: () => void;
  onBriefing: () => void;
  onMerge?: () => void;
  onCopyUrl?: () => Promise<string>; // Y: the PR's link on the clipboard
  onRefresh: () => void;
  onTheme?: () => void;
  onBack?: () => void;
  onQuit: () => void;
};

export function FeedbackScreen(props: Props) {
  const group = props.groups[Math.min(props.pos.ci, props.groups.length - 1)];
  const item = group?.items[Math.min(props.pos.ii, group.items.length - 1)];
  if (!item || !group) return <NoFeedback {...props} />;
  return <ThreadScreen {...props} group={group} item={item} />;
}

function NoFeedback(props: Props) {
  // n, p and Enter have nowhere to go: the message turns yellow so the key is seen to land.
  const [pressed, setPressed] = useState(false);
  useInput(
    (input, key) => {
      if (input === 'n' || input === 'p' || key.return) return setPressed(true);
      if (input === 'H') return props.onToggleHidden();
      if (input === 'b' || input === 'q' || key.escape) return props.onBriefing();
      if (input === 'Q') return props.onQuit();
    },
    { isActive: props.active },
  );
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={pressed ? 'yellow' : undefined}>No feedback to show{props.showHidden ? '' : ' (resolved threads are hidden: H shows them)'}.</Text>
      <Hints
        keys={[
          ['H', 'show resolved'],
          ['esc', 'briefing'],
          ['Q', 'quit'],
        ]}
      />
    </Box>
  );
}

function ThreadScreen(props: Props & { group: FeedbackChapter; item: FeedbackItem }) {
  const { tour, groups, pos, width, height, group, item } = props;
  const queued = props.queued.find((q) => q.threadId === item.thread.id);
  const [mode, setMode] = useState<Mode>({ kind: 'browse' });
  const { flash, show: setFlash, dismiss: dismissFlash } = useFlash();
  const [expanded, setExpanded] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [codeScroll, setCodeScroll] = useState(0);
  const [comment, setComment] = useState(0);
  const [reply, setReply] = useState({ body: '', resolve: false });
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const aiAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => aiAbort.current?.abort(), []);
  const threadId = item.thread.id;
  const [linkIdx, setLinkIdx] = useState(0);
  useEffect(() => {
    setScroll(0);
    setCodeScroll(0);
    setComment(0);
    setLinkIdx(0);
    setMode({ kind: 'browse' });
  }, [threadId]);
  // Code the thread names without linking, found in the checkout once per thread and kept.
  const { codeIndex } = props;
  const [named, setNamed] = useState<Record<string, { link: CodeRef; comment: number }[]>>({});
  const resolved = threadId in named;
  useEffect(() => {
    if (!codeIndex || resolved) return;
    const ac = new AbortController();
    const thread = item.thread;
    const terms = thread.comments.map((c) => codeTerms(c.body));
    const here = { path: thread.path, line: thread.placed?.line ?? thread.line ?? thread.originalLine };
    resolveCodeRefs(codeIndex, terms.flat(), tour.headSha, { here, signal: ac.signal }).then(
      (refs) => {
        // Each name goes with the first comment that wrote it, for Tab to start the preview there.
        const found = refs.map((link) => ({
          link,
          comment: Math.max(
            0,
            terms.findIndex((ts) => ts.some((t) => t.text === link.label)),
          ),
        }));
        setNamed((m) => ({ ...m, [threadId]: found }));
      },
      () => undefined,
    );
    return () => ac.abort();
  }, [codeIndex, resolved, threadId, item.thread, tour.headSha]);
  // Links to files in this repository, in the order the thread mentions them, then the code it
  // names.
  const namedHere = named[threadId];
  const links = useMemo(() => {
    const host = githubWebHost();
    const seen = new Set<string>();
    const out: { link: FileLink & { label?: string }; comment: number }[] = [];
    item.thread.comments.forEach((c, k) => {
      for (const link of findFileLinks(c.body, { host, repo: tour.repo })) {
        if (seen.has(link.url)) continue;
        seen.add(link.url);
        out.push({ link, comment: k });
      }
    });
    // A name whose definition a link already shows adds nothing.
    for (const n of namedHere ?? []) if (!out.some((o) => o.link.path === n.link.path && (!o.link.startLine || o.link.startLine === n.link.startLine))) out.push(n);
    return out;
  }, [item, tour.repo, namedHere]);
  const showPreview = links.length > 0 && width >= PREVIEW_MIN_WIDTH;
  const previewW = showPreview ? Math.min(90, Math.floor(width * 0.45)) : 0;
  const leftW = width - (showPreview ? previewW + 1 : 0);
  const replying = mode.kind === 'reply' || mode.kind === 'ai' || mode.kind === 'refine';
  const wantMentions = useRef(props.wantMentions);
  wantMentions.current = props.wantMentions;
  useEffect(() => wantMentions.current(replying), [replying]);

  const code = useMemo(() => threadCode(tour, item), [tour, item]);
  const { partner, hidden } = useFolds(code?.hunk, false, false);
  const mentionRules = useMemo(() => [mentionHighlight(props.mentions)].filter((r) => r !== undefined), [props.mentions]);

  // ---------- the discussion, as lines ----------
  const inner = leftW - 4;
  const { lines, starts } = useMemo(() => {
    const out: MdLine[] = [];
    const at: number[] = [];
    for (const [k, c] of item.thread.comments.entries()) {
      at.push(out.length);
      const mine = c.author === tour.author;
      out.push([
        { text: k === comment ? '▸ ' : '  ', color: 'cyan' },
        { text: `@${safe(c.author)}`, bold: true, color: mine ? 'cyan' : undefined },
        { text: `${mine ? ' (you)' : ''} · ${age(c.createdAt)}`, dim: true },
      ]);
      out.push(...renderMarkdown(c.body, Math.max(10, inner - 2)).map((l): MdLine => [{ text: '  ' }, ...l]));
      const counts = (c.reactionGroups ?? [])
        .filter((g) => g.reactors.totalCount > 0)
        .map((g) => `${REACTIONS.find((r) => r.content === g.content)?.emoji ?? g.content}${g.reactors.totalCount}${g.viewerHasReacted ? '*' : ''}`);
      if (counts.length) out.push([{ text: `  ${counts.join('  ')}`, dim: true }]);
      out.push([]);
    }
    if (queued && mode.kind !== 'reply') {
      out.push([{ text: `Queued reply${queued.resolve ? ', then resolve' : ''} · sends with s`, bold: true, color: 'cyan' }]);
      out.push(...renderMarkdown(queued.body, Math.max(10, inner - 2)).map((l): MdLine => [{ text: '  ' }, ...l]));
    }
    return { lines: out, starts: at };
  }, [item, comment, queued, mode.kind, inner, tour.author]);

  // ---------- layout ----------
  const headerRows = 3 + (props.banner ? 1 : 0);
  const footerRows = 2;
  const bodyH = Math.max(6, height - headerRows - footerRows);
  const editorRows =
    mode.kind === 'reply' ? 6 : mode.kind === 'ai' || mode.kind === 'refine' ? 9 : mode.kind === 'ask' ? Math.max(6, Math.floor(bodyH * 0.6)) : mode.kind === 'react' || mode.kind === 'triage' ? 2 : 0;
  const codeRows = !code ? 1 : expanded ? 4 : Math.min(code.hunk.lines.length + 1, Math.max(4, Math.floor((bodyH - editorRows) * 0.45)));
  const threadRows = Math.max(3, bodyH - codeRows - editorRows - 1);
  const maxScroll = Math.max(0, lines.length - threadRows);

  // ---------- navigation ----------
  const flat = groups.flatMap((g, ci) => g.items.map((_, ii) => ({ ci, ii })));
  const here = flat.findIndex((p) => p.ci === pos.ci && p.ii === pos.ii);
  const step = (by: number) => {
    const to = flat[here + by];
    if (to) props.setPos(to);
    else setFlash(by > 0 ? 'That was the last thread. s sends your queued replies.' : 'This is the first thread.');
  };
  const chapterStep = (by: number) => {
    const ci = pos.ci + by;
    if (groups[ci]) props.setPos({ ci, ii: 0 });
  };

  const startReply = () => {
    setReply({ body: queued?.body ?? '', resolve: queued?.resolve ?? false });
    setMode({ kind: 'reply' });
  };
  const saveReply = (body: string) => {
    props.onSaveReply(item.thread.id, body, reply.resolve);
    setMode({ kind: 'browse' });
    setFlash(body.trim() ? `Reply queued${reply.resolve ? ' (resolves after sending)' : ''}. Nothing posts until you send (s).` : 'Queued reply removed.', 'info');
  };
  const codeText = code ? code.hunk.lines.map((l) => `${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`).join('\n') : undefined;
  const runDraft = async (previous?: { reply: string; feedback: string }) => {
    if (!props.agent) return setFlash(props.aiOff ?? 'AI is off, so replies can’t be drafted.');
    aiAbort.current?.abort();
    const ac = new AbortController();
    aiAbort.current = ac;
    setMode({ kind: 'ai', busy: true });
    try {
      const d = await draftReply({ ...props.agent, item, author: tour.author, code: codeText, instruction: previous ? undefined : reply.body, previous, signal: ac.signal });
      if (!ac.signal.aborted) setMode({ kind: 'ai', busy: false, draft: d });
    } catch (e) {
      if (!ac.signal.aborted) setMode({ kind: 'ai', busy: false, error: (e as Error).message });
    }
  };
  const react = async (k: number) => {
    const c = item.thread.comments[comment];
    if (!c?.nodeId || busy) return;
    const content = REACTIONS[k].content;
    setBusy(true);
    try {
      await props.onReact(c, content, !!c.reactionGroups?.find((g) => g.content === content)?.viewerHasReacted);
      setMode({ kind: 'browse' });
    } catch (e) {
      setFlash(`Reaction failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const resolve = async () => {
    const to = !item.thread.isResolved;
    setMode({ kind: 'browse' });
    setBusy(true);
    try {
      await props.onResolve(item, to);
      setFlash(to ? 'Resolved on GitHub.' : 'Unresolved on GitHub.', 'info');
    } catch (e) {
      setFlash(`${to ? 'Resolve' : 'Unresolve'} failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  useInput(
    (input, key) => {
      dismissFlash();
      if (mode.kind === 'triage') {
        // 1-4 choose, Space clears, anything else closes the picker.
        const choice = /^[1-4]$/.test(input) ? TRIAGE_CHOICES[Number(input) - 1] : input === ' ' ? null : undefined;
        setMode({ kind: 'browse' });
        if (choice === undefined) return;
        props.onTriage(item, choice ?? undefined);
        if (choice === 'wont' && !queued) setFlash('Won’t do: y to say why. A dismissal without a reason usually brings a second round.');
        return;
      }
      if (mode.kind === 'react') {
        if (key.escape || input === '+') return setMode({ kind: 'browse' });
        if (/^[1-8]$/.test(input)) void react(Number(input) - 1);
        return;
      }
      if (mode.kind === 'resolve') {
        if (input === 'y' || key.return) return void resolve();
        return setMode({ kind: 'browse' });
      }
      if (mode.kind === 'ai') {
        if (key.escape) {
          aiAbort.current?.abort();
          return setMode({ kind: 'reply' });
        }
        if (mode.busy) return;
        if (key.return && mode.draft) {
          setReply((r) => ({ ...r, body: mode.draft!.reply }));
          return setMode({ kind: 'reply' });
        }
        if (input === 'r' && mode.draft) {
          setInstruction('');
          return setMode({ kind: 'refine', draft: mode.draft });
        }
        return;
      }
      if (key.tab && item.thread.comments.length > 1) {
        const n = item.thread.comments.length;
        const next = (comment + (key.shift ? n - 1 : 1)) % n;
        setComment(next);
        const first = links.findIndex((l) => l.comment === next);
        if (first >= 0) setLinkIdx(first);
        return setScroll(Math.min(starts[next] ?? 0, maxScroll));
      }
      if (input === 'n') return step(1);
      if (input === 'p') return step(-1);
      if (input === ']') return chapterStep(1);
      if (input === '[') return chapterStep(-1);
      if (input === 'j' || key.downArrow) return setScroll((s) => Math.min(maxScroll, s + 1));
      if (input === 'k' || key.upArrow) return setScroll((s) => Math.max(0, s - 1));
      if (input === 'J' || key.pageDown) return setScroll((s) => Math.min(maxScroll, s + threadRows));
      if (input === 'K' || key.pageUp) return setScroll((s) => Math.max(0, s - threadRows));
      if (input === 'e') return setExpanded((x) => !x);
      if (input === 'l' && links.length) {
        if (!showPreview) return setFlash(`${plural(links.length, 'linked file')}: widen the terminal to ${PREVIEW_MIN_WIDTH} columns to preview them beside the thread.`);
        return setLinkIdx((i) => (i + 1) % links.length);
      }
      if (input === 'y') return startReply();
      if (input === ' ') return setMode({ kind: 'triage' });
      if (input === 'Z') {
        if (item.thread.isResolved ? item.thread.viewerCanUnresolve === false : item.thread.viewerCanResolve === false) return setFlash('You can’t change whether this thread is resolved.');
        return setMode({ kind: 'resolve' });
      }
      if (input === '+') {
        if (!item.thread.comments[comment]?.nodeId) return setFlash('This comment can’t take reactions.');
        return setMode({ kind: 'react' });
      }
      if (input === 'a') return setMode({ kind: 'ask' });
      if (input === '?' || input === 'h') return setMode({ kind: 'help' });
      if (input === 'o') return props.onHandoff(item, code?.hunk.lines ?? []);
      if (input === 'H') return props.onToggleHidden();
      if (input === 's') return props.onSend();
      if (input === 'M' && props.onMerge) return props.onMerge();
      if (input === 'Y' && props.onCopyUrl) return void props.onCopyUrl().then((m) => setFlash(m, /^Copied|^Asked/.test(m) ? 'info' : undefined));
      if (input === 'R') return props.onRefresh();
      if (input === 'L' && props.onTheme) return props.onTheme();
      if (input === 'b' || input === 'q') return props.onBriefing();
      if (key.escape && mode.kind === 'browse') return props.onBriefing();
      if (input === 'Q') return props.onQuit();
      const none = mode.kind === 'browse' ? unboundKey(input, key) : undefined;
      if (none && !readsKey(THREAD_KEYS, input)) setFlash(none, 'quiet');
    },
    { isActive: props.active && (mode.kind === 'browse' || mode.kind === 'react' || mode.kind === 'triage' || mode.kind === 'resolve' || mode.kind === 'ai') },
  );
  // The reply editor: Enter queues, Esc cancels, ^T drafts with AI, ^R resolves after sending.
  useInput(
    (input, key) => {
      if (key.escape) return setMode({ kind: 'browse' });
      if (key.ctrl && input === 't') return void runDraft();
      if (key.ctrl && input === 'r') return setReply((r) => ({ ...r, resolve: !r.resolve }));
    },
    { isActive: props.active && mode.kind === 'reply' },
  );
  useInput(
    (_input, key) => {
      if (key.escape) setMode(mode.kind === 'refine' ? { kind: 'ai', busy: false, draft: mode.draft } : { kind: 'browse' });
    },
    { isActive: props.active && mode.kind === 'refine' },
  );

  // ---------- render ----------
  const p = item.placement;
  const where = `${p.path}${p.line !== undefined ? `:${p.line}` : ''}`;
  const reviewers = item.reviewers.map((r) => `@${r}`).join(', ');
  const mark = chapterMark(group);
  const editor = (() => {
    if (mode.kind === 'reply')
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} height={editorRows}>
          <Text bold>
            Reply to {safe(reviewers || 'the thread')} <Text dimColor>· queued, not posted · {reply.resolve ? '[x]' : '[ ]'} resolve after sending (^R)</Text>
          </Text>
          <TextInput
            value={reply.body}
            onChange={(v) => setReply((r) => ({ ...r, body: v }))}
            onSubmit={saveReply}
            width={leftW - 6}
            maxRows={editorRows - 3}
            mentions={props.mentions}
            highlightTokens={mentionRules}
            placeholder={props.agent ? 'Write a reply, or ^T to draft one (what you type guides it)…' : 'Write a reply…'}
          />
          <Hints keys={[['enter', 'queue'], ['ctrl+j', 'newline'], ...((props.agent ? [['ctrl+t', 'draft with AI']] : []) as Hint[]), ['ctrl+r', 'resolve after sending'], ['esc', 'cancel']]} />
        </Box>
      );
    if (mode.kind === 'ai' || mode.kind === 'refine') {
      const draft = mode.kind === 'refine' ? mode.draft : mode.draft;
      const shown = draft ? renderMarkdown(draft.reply, leftW - 6).slice(0, editorRows - 4 - (draft.notes.length ? 1 : 0) - (mode.kind === 'refine' ? 1 : 0)) : [];
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} height={editorRows}>
          <Text bold>
            AI reply <Text dimColor>· a proposal, not verified</Text>
          </Text>
          {mode.kind === 'ai' && mode.busy ? <Text dimColor>Drafting…</Text> : null}
          {mode.kind === 'ai' && mode.error ? <Text color="red">{safe(mode.error)}</Text> : null}
          {shown.map((l, i) => (
            <MdLineView key={i} line={l} />
          ))}
          {draft?.notes.length ? (
            <Text color="yellow" wrap="truncate">
              Check: {safe(draft.notes.join(' · '))}
            </Text>
          ) : null}
          <Box flexGrow={1} />
          {mode.kind === 'refine' ? (
            <TextInput
              value={instruction}
              onChange={setInstruction}
              onSubmit={(v) => v.trim() && void runDraft({ reply: mode.draft.reply, feedback: v.trim() })}
              width={leftW - 6}
              maxRows={1}
              placeholder="What should change? e.g. shorter, mention the follow-up issue"
            />
          ) : (
            <Hints
              keys={
                mode.busy
                  ? [['esc', 'stop']]
                  : mode.draft
                    ? [
                        ['enter', 'use it (you can edit before queueing)'],
                        ['r', 'refine'],
                        ['esc', 'discard'],
                      ]
                    : [['esc', 'back']]
              }
            />
          )}
        </Box>
      );
    }
    if (mode.kind === 'ask')
      return (
        <AskOverlay
          hunk={code && !code.snippet ? code.hunk : undefined}
          lineIdx={code && !code.snippet ? code.idx : undefined}
          context={threadContext(item, tour.author)}
          placeholder='e.g. "is this concern valid?" or "what would the change look like?"'
          target={`the thread on ${where}`}
          agent={props.agent}
          aiOff={props.aiOff}
          width={leftW}
          height={editorRows}
          onClose={() => setMode({ kind: 'browse' })}
        />
      );
    if (mode.kind === 'triage')
      return (
        <Box flexDirection="column" height={2}>
          <Text wrap="truncate">Triage this thread · it stays on your machine</Text>
          <Text wrap="truncate">
            {TRIAGE_CHOICES.map((t, k) => (
              <Text key={t}>
                <Text color="cyan" bold>{`${k + 1}`}</Text>
                <Text color={TRIAGE_COLOR[t]} bold={item.triage === t}>{` ${TRIAGE_LABEL[t]}${item.triage === t ? ' ✓' : ''}`}</Text>
                {'   '}
              </Text>
            ))}
            <Text color="cyan" bold>
              space
            </Text>
            <Text dimColor> clear · esc close</Text>
          </Text>
        </Box>
      );
    if (mode.kind === 'react')
      return (
        <Box flexDirection="column" height={2}>
          <Text wrap="truncate">React to @{safe(item.thread.comments[comment]?.author ?? '')} · press 1-8 to toggle · esc to close</Text>
          <Text dimColor wrap="truncate">
            {REACTIONS.map((r, k) => `${k + 1}${r.emoji}`).join(' ')}
          </Text>
        </Box>
      );
    return null;
  })();

  const screen = (
    <Box flexDirection="column" width={width} height={height}>
      <TitleBar
        repo={tour.repo}
        title={`#${tour.pr} ${group.title}`}
        tags={<Text color={mark.color}>{mark.mark}</Text>}
        where={`feedback · thread ${here + 1}/${flat.length} · chapter ${pos.ci + 1}/${groups.length}`}
        width={width}
      />
      {props.banner ? (
        <Text backgroundColor="yellow" color="black">
          {pad(` ${props.banner}`, width)}
        </Text>
      ) : null}
      <Text wrap="truncate">
        {' '}
        <Text color={STATE_COLOR[item.state]}>● {STATE_LABEL[item.state]}</Text>
        <Text color={isBlocking(item) ? 'red' : 'cyan'}>{` · ${CLASS_LABEL[item.cls]}`}</Text>
        {item.clsSource === 'model' ? <Text dimColor> (model)</Text> : null}
        {item.triage ? <Text color={TRIAGE_COLOR[item.triage]}>{` · ${TRIAGE_LABEL[item.triage]}`}</Text> : <Text dimColor> · untriaged</Text>}
        <Text dimColor>{` · ${safe(reviewers)} · ${plural(item.thread.comments.length, 'comment')}`}</Text>
      </Text>
      <Text wrap="truncate" dimColor>
        {` ${safe(where)}${HOW[p.how] ? ` · ${HOW[p.how]}` : ''}${p.note ? ` · ${safe(p.note)}` : ''}${item.addressedReason ? ` · ${safe(item.addressedReason)}` : ''}`}
      </Text>
      <Box flexDirection="row" height={bodyH} overflow="hidden">
        <Box flexDirection="column" width={leftW} height={bodyH} overflow="hidden">
          {code ? (
            <SourcePane
              hunk={code.hunk}
              cursor={code.idx}
              range={null}
              raw={false}
              split={false}
              partner={partner}
              hidden={hidden}
              ignoreWhitespace={false}
              scroll={codeScroll}
              setScroll={setCodeScroll}
              threads={[]}
              drafts={[]}
              root={code.snippet ? undefined : props.root}
              headSha={tour.headSha}
              baseSha={tour.baseSha}
              width={leftW}
              height={codeRows}
            />
          ) : (
            <Text dimColor>{p.how === 'file' ? `  A comment on ${safe(p.path)} as a whole.` : '  No code to show for this thread.'}</Text>
          )}
          <Text dimColor>{'─'.repeat(Math.max(0, leftW))}</Text>
          <Box flexDirection="column" height={threadRows} paddingX={1} overflow="hidden">
            {lines.slice(scroll, scroll + threadRows).map((l, k) => (
              <MdLineView key={scroll + k} line={l} />
            ))}
          </Box>
          {editor}
        </Box>
        {showPreview ? (
          <Box marginLeft={1}>
            <FilePreview links={links.map((l) => l.link)} first={Math.min(linkIdx, links.length - 1)} worktree={props.root} headSha={tour.headSha} width={previewW} height={bodyH} />
          </Box>
        ) : null}
      </Box>
      {mode.kind === 'resolve' ? (
        <Confirm yes={item.thread.isResolved ? 'unresolve' : 'resolve'}>{item.thread.isResolved ? 'Unresolve' : 'Resolve'} this thread on GitHub now?</Confirm>
      ) : flash ? (
        <Text color={TONE_COLOR[flash.tone]} dimColor={flash.tone === 'quiet'} wrap="truncate">
          {' '}
          {safe(flash.text)}
        </Text>
      ) : (
        <Text dimColor wrap="truncate">
          {lines.length > threadRows ? ` ${Math.min(lines.length, scroll + threadRows)}/${lines.length} lines · j/k scroll` : ' '}
          {item.thread.comments.length > 1 ? ' · Tab: next comment' : ''}
          {links.length && !showPreview ? ` · ${plural(links.length, 'linked file')}: l` : ''}
          {busy ? ' · working…' : ''}
        </Text>
      )}
      <KeyBar
        width={width}
        keys={
          mode.kind === 'browse'
            ? threadBar({
                queued: !!queued,
                resolved: item.thread.isResolved,
                queuedCount: props.queued.length,
                agent: !!props.agent,
                expanded,
                showHidden: props.showHidden,
                merge: !!props.onMerge,
                copy: !!props.onCopyUrl,
              })
            : []
        }
        end={
          mode.kind === 'browse'
            ? [
                ['esc', 'briefing'],
                ['Q', 'quit'],
              ]
            : []
        }
      />
    </Box>
  );
  if (mode.kind === 'help' && props.active)
    return <HelpPopup background={screen} width={width} height={height} title="thread" sections={helpOf(THREAD_KEYS)} onClose={() => setMode({ kind: 'browse' })} />;
  return screen;
}
