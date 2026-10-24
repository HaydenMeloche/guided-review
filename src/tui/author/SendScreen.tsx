import { useMemo, useState } from 'react';
import { useInput } from '../input.js';
import { Box, Text } from '../themed.js';
import { Confirm } from '../Confirm.js';
import type { Tour } from '../../types.js';
import { CONVERSATION, rerequestFirst, sendPlan, type FeedbackItem, type QueuedReply, type ReviewerStatus } from '../../review/feedback.js';
import { PartialSendError, UncertainSendError, postIssueComment, postThreadReplies, requestReviewers, setThreadResolved } from '../../github/gh.js';
import { KeyBar } from '../KeyBar.js';
import { SEND_KEYS, sendBar } from './keys.js';
import { Help } from '../Help.js';
import { helpOf } from '../keys.js';
import { truncate } from '../nav.js';
import { VERDICT } from './FeedbackBriefing.js';
import { plural } from '../plural.js';
import { sanitizeTerminal as safe } from '../../util/sanitize.js';
import { G } from '../glyphs.js';
import { Working } from '../Spinner.js';

// Everything author mode sends, in one place: the queued replies (posted together as one
// review, so reviewers get one notification), a comment on the PR's conversation, the threads to
// resolve after them, and the re-request for review. Nothing goes to GitHub before P and its confirmation.
export function SendScreen(props: {
  tour: Tour;
  headSha: string; // the PR's head as last read: the batched review is attached to it
  newHead?: string; // a push gr noticed since: nothing sends until the feedback is read again
  items: FeedbackItem[];
  queued: QueuedReply[];
  candidates: ReviewerStatus[]; // reviewers who can be asked again
  rerequestDefault: boolean; // tick the reviewers who asked for changes to begin with
  silent: FeedbackItem[]; // won't-do threads with no reply
  width: number;
  height: number;
  onEdit: (threadId: string) => void;
  onToggleResolve: (q: QueuedReply) => void;
  onDelete: (q: QueuedReply) => void;
  onSent: (notice: string, sentThreadIds: string[]) => void;
  onBack: () => void;
  onQuit?: () => void; // Q
}) {
  const { tour, width } = props;
  const byId = useMemo(() => new Map(props.items.map((i) => [i.thread.id, i])), [props.items]);
  // The conversation comment first, then the thread replies.
  const comment = props.queued.find((q) => q.threadId === CONVERSATION);
  const rows = [...(comment ? [comment] : []), ...props.queued.filter((q) => byId.has(q.threadId))];
  const stale = props.queued.length - rows.length;
  // The cursor runs down the replies, then the reviewers.
  const [sel, setSel] = useState(0);
  const [rerequest, setRerequest] = useState<Set<string>>(() => new Set(props.rerequestDefault ? rerequestFirst(props.candidates) : []));
  const onReply = sel < rows.length;
  const reviewerAt = sel - rows.length;
  const [mode, setMode] = useState<'list' | 'confirm' | 'sending' | 'confirm-delete' | 'help'>('list');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const plan = sendPlan(props.items, rows, [...rerequest]);
  const nothing = !plan.replies.length && !plan.comment && !plan.rerequest.length;

  const send = async () => {
    setMode('sending');
    setError('');
    const done: string[] = [];
    try {
      let review = '';
      if (plan.replies.length) {
        setProgress(`Posting ${plan.replies.length} repl${plan.replies.length === 1 ? 'y' : 'ies'}…`);
        const r = await postThreadReplies(tour.repo, tour.pr, props.headSha, plan.replies);
        done.push(...plan.replies.map((x) => x.threadId));
        review = r.batched ? ` as one review${r.url ? ` (${r.url})` : ''}` : r.fallbackReason ? ` one by one (batching failed: ${r.fallbackReason})` : ' one by one';
      }
      let commentUrl = '';
      if (plan.comment) {
        setProgress('Posting the comment…');
        commentUrl = (await postIssueComment(tour.repo, tour.pr, plan.comment)).url;
        done.push(CONVERSATION);
      }
      const failed: string[] = [];
      for (const id of plan.resolves) {
        setProgress('Resolving threads…');
        await setThreadResolved(id, true).catch(() => failed.push(id));
      }
      if (plan.rerequest.length) {
        setProgress('Requesting review…');
        await requestReviewers(tour.repo, tour.pr, plan.rerequest);
      }
      const parts = [
        plan.replies.length ? `Sent ${plan.replies.length} repl${plan.replies.length === 1 ? 'y' : 'ies'}${review}` : '',
        plan.comment ? `posted a comment${commentUrl ? ` (${commentUrl})` : ''}` : '',
        plan.resolves.length ? `resolved ${plural(plan.resolves.length - failed.length, 'thread')}${failed.length ? ` (${failed.length} failed)` : ''}` : '',
        plan.rerequest.length ? `asked ${plan.rerequest.map((l) => `@${l}`).join(', ')} to review again` : '',
      ].filter(Boolean);
      props.onSent(`${parts.join(' · ')}.`, done);
    } catch (e) {
      // The batch probably posted but GitHub's answer was lost: the replies stay queued, nothing
      // is sent again, and the author checks the PR (Y copies its link) before trying once more.
      if (e instanceof UncertainSendError) {
        setError(e.message);
        setMode('list');
        return;
      }
      // Replies already posted are not queued again; the rest stay for another try.
      if (e instanceof PartialSendError) done.push(...e.posted);
      if (e instanceof PartialSendError && done.length) {
        props.onSent(`Posted ${done.length} of ${plan.replies.length} replies, then it failed: ${e.message}. The rest are still queued; P tries them again.`, done);
      } else if (done.length) props.onSent(`Replies sent, then: ${(e as Error).message}`, done);
      else {
        setError(`Send failed: ${(e as Error).message}`);
        setMode('list');
      }
    }
  };

  useInput(
    (input, key) => {
      if (mode === 'confirm') {
        if (input === 'y' || key.return) return void send();
        return setMode('list');
      }
      if (mode === 'confirm-delete') {
        if ((input === 'y' || key.return) && rows[sel]) props.onDelete(rows[sel]);
        return setMode('list');
      }
      if (key.escape || input === 'q') return props.onBack();
      if (input === 'Q') return props.onQuit?.();
      if (input === '?' || input === 'h') return setMode('help');
      if (input === 'j' || key.downArrow) return setSel((s) => Math.min(Math.max(0, rows.length + props.candidates.length - 1), s + 1));
      if (input === 'k' || key.upArrow) return setSel((s) => Math.max(0, s - 1));
      if (input === 'e' && onReply && rows[sel]) return props.onEdit(rows[sel].threadId);
      if (input === 'z' && onReply && rows[sel] && rows[sel] !== comment) return props.onToggleResolve(rows[sel]);
      if (input === 'x' && onReply && rows[sel]) return setMode('confirm-delete');
      if (input === 'r' && props.candidates.length) {
        // On a reviewer, that one; elsewhere, all of them or none.
        const one = props.candidates[reviewerAt]?.login;
        if (one) return setRerequest((s) => (s.has(one) ? new Set([...s].filter((l) => l !== one)) : new Set([...s, one])));
        return setRerequest((s) => (s.size ? new Set() : new Set(props.candidates.map((c) => c.login))));
      }
      if (input === 'P') {
        if (props.newHead) return setError(`You pushed ${props.newHead.slice(0, 8)}: press R to refresh before sending.`);
        if (nothing) return setError('Nothing to send: queue a reply (y on a thread), a comment (y on the briefing), or tick re-request (r).');
        return setMode('confirm');
      }
    },
    { isActive: mode !== 'sending' && mode !== 'help' },
  );

  const listRoom = Math.max(3, props.height - 11 - Math.max(1, props.candidates.length) - (props.silent.length ? 2 : 0));
  const top = Math.max(0, Math.min((onReply ? sel : rows.length - 1) - Math.floor(listRoom / 2), rows.length - listRoom));
  if (mode === 'help') return <Help title="send" sections={helpOf(SEND_KEYS)} width={width} height={props.height} onClose={() => setMode('list')} />;
  return (
    <Box flexDirection="column" width={width} height={props.height} paddingX={1}>
      <Text bold wrap="truncate">
        Send · <Text color="cyan">{safe(tour.repo)}</Text> #{tour.pr} {truncate(safe(tour.title), width - 24)}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>
          Replies ({rows.length}) <Text dimColor>· posted together as one comment review, then the threads marked resolve are resolved</Text>
        </Text>
        {!rows.length ? <Text dimColor>No replies queued. Press y on a thread to write one, or on the briefing for a comment on the PR.</Text> : null}
        {rows.slice(top, top + listRoom).map((q, k) => {
          const i = top + k;
          const item = byId.get(q.threadId);
          const where = item ? `${item.placement.path}${item.placement.line !== undefined ? `:${item.placement.line}` : ''}` : 'PR conversation';
          return (
            <Text key={q.threadId} wrap="truncate" inverse={onReply && i === sel}>
              <Text color={q.resolve ? 'green' : 'gray'}>{q.resolve ? '✓ resolve ' : '          '}</Text>
              {truncate(safe(`${where} → ${q.body.replace(/\s+/g, ' ')}`), width - 14)}
            </Text>
          );
        })}
        {stale ? (
          <Text dimColor>
            {stale} queued repl{stale === 1 ? 'y is' : 'ies are'} for threads no longer on the PR and will not be sent.
          </Text>
        ) : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>
          Re-request review <Text dimColor>· r ticks a reviewer, or all of them</Text>
        </Text>
        {!props.candidates.length ? <Text dimColor>Nobody has reviewed yet, so there is no one to ask again.</Text> : null}
        {props.candidates.map((c, k) => {
          const v = VERDICT[c.verdict] ?? VERDICT.COMMENTED;
          return (
            <Text key={c.login} wrap="truncate" inverse={!onReply && k === reviewerAt}>
              {rerequest.has(c.login) ? '[x] ' : '[ ] '}
              {safe(`@${c.login}`)} <Text color={v.color}>{v.text}</Text>
            </Text>
          );
        })}
      </Box>
      {props.silent.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow" wrap="truncate">
            {G.flag} {plural(props.silent.length, 'thread')} marked won’t do {props.silent.length === 1 ? 'has' : 'have'} no reply: {safe(props.silent.map((i) => i.placement.path).join(', '))}
          </Text>
        </Box>
      ) : null}
      <Box flexGrow={1} />
      {error ? <Text color="red">{safe(error)}</Text> : null}
      {mode === 'confirm' ? (
        <Confirm yes="send">
          {[
            plan.replies.length ? `Post ${plan.replies.length} repl${plan.replies.length === 1 ? 'y' : 'ies'}` : '',
            plan.comment ? `${plan.replies.length ? 'a' : 'Post a'} comment` : '',
            plan.resolves.length ? `resolve ${plural(plan.resolves.length, 'thread')}` : '',
            plan.rerequest.length ? `re-request ${plural(plan.rerequest.length, 'reviewer')}` : '',
          ]
            .filter(Boolean)
            .join(', ')}{' '}
          on {safe(tour.repo)}#{tour.pr}?
        </Confirm>
      ) : mode === 'confirm-delete' ? (
        <Confirm yes="delete">Delete this queued {rows[sel] === comment ? 'comment' : 'reply'}?</Confirm>
      ) : mode === 'sending' ? (
        <Working label={progress || 'sending'} color="yellow" />
      ) : (
        <KeyBar width={width - 2} keys={sendBar({ candidates: props.candidates.length > 0 })} end={[['?', 'keys']]} />
      )}
    </Box>
  );
}
