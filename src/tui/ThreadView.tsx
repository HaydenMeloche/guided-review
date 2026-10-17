import { useMemo, useState } from 'react';
import { useInput } from 'ink';
import { Box, Text } from './themed.js';
import type { ExistingThread, ReactionContent, ThreadComment } from '../types.js';
import { MdLineView, renderMarkdown, type MdLine } from './markdown.js';
import { TextInput } from './TextInput.js';
import { mentionHighlight } from './completion.js';
import { sanitizeTerminal } from '../util/sanitize.js';

const safe = sanitizeTerminal;
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

export function ThreadView(props: {
  threads: ExistingThread[];
  width: number;
  height: number;
  mentions: string[];
  startReply?: boolean;
  onReply?: (thread: ExistingThread, body: string) => Promise<void>;
  onReact?: (comment: ThreadComment, content: ReactionContent, remove: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const [selectedComment, setSelectedComment] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [composing, setComposing] = useState(!!props.startReply && props.threads.length === 1);
  const [reactionMenu, setReactionMenu] = useState(false);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [completing, setCompleting] = useState(false); // the mention list owns Esc while open
  const [error, setError] = useState('');
  const thread = props.threads[selected];
  // Known @mentions in the reply read as usernames.
  const mentionRules = useMemo(() => [mentionHighlight(props.mentions)].filter((r) => r !== undefined), [props.mentions]);
  const { lines, commentStarts } = useMemo(() => {
    const out: MdLine[] = [];
    const starts: number[] = [];
    out.push([{ text: `Thread ${selected + 1}${thread.isResolved ? ' · resolved' : thread.isOutdated ? ' · outdated' : ''}`, bold: true, color: 'cyan' }]);
    for (const [index, comment] of thread.comments.entries()) {
      starts.push(out.length);
      out.push([{ text: `${index === selectedComment ? '▸ ' : '  '}@${safe(comment.author)}`, bold: true, color: index === selectedComment ? 'cyan' : undefined }]);
      out.push(...renderMarkdown(safe(comment.body), Math.max(10, props.width - 6)));
      const counts = (comment.reactionGroups ?? [])
        .filter((group) => group.reactors.totalCount > 0)
        .map((group) => `${REACTIONS.find((reaction) => reaction.content === group.content)?.emoji ?? group.content}${group.reactors.totalCount}${group.viewerHasReacted ? '*' : ''}`);
      if (counts.length) out.push([{ text: `  ${counts.join('  ')}`, color: 'magenta' }]);
      out.push([]);
    }
    return { lines: out, commentStarts: starts };
  }, [thread, selected, selectedComment, props.width]);
  const inputRows = Math.max(1, Math.min(4, props.height - 8));
  const visible = Math.max(1, props.height - 5 - (composing ? inputRows + 2 : reactionMenu ? 1 : 0) - (error ? 1 : 0));
  const maxScroll = Math.max(0, lines.length - visible);

  const react = async (choice: number) => {
    const comment = thread.comments[selectedComment];
    if (!comment?.nodeId || !props.onReact || busy) return;
    const content = REACTIONS[choice].content;
    const remove = !!comment.reactionGroups?.find((group) => group.content === content)?.viewerHasReacted;
    setBusy(true);
    setError('');
    try {
      await props.onReact(comment, content, remove);
      setReactionMenu(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (composing) {
      if (key.escape && !busy && !completing) setComposing(false);
      if (key.pageDown) setScroll((n) => Math.min(maxScroll, n + visible));
      if (key.pageUp) setScroll((n) => Math.max(0, n - visible));
      return;
    }
    if (reactionMenu) {
      if (key.escape || input === 'a') return setReactionMenu(false);
      if (/^[1-8]$/.test(input)) void react(Number(input) - 1);
      return;
    }
    if (key.escape || input === 'e') return props.onClose();
    if (input === 'y' && props.onReply) return setComposing(true);
    if (input === 'a' && props.onReact && thread.comments[selectedComment]?.nodeId) return setReactionMenu(true);
    if (key.tab && thread.comments.length > 1) {
      const next = (selectedComment + (key.shift ? thread.comments.length - 1 : 1)) % thread.comments.length;
      setSelectedComment(next);
      return setScroll(Math.min(commentStarts[next], maxScroll));
    }
    if (props.threads.length > 1 && (input === '[' || input === ']')) {
      setSelected((n) => (n + (input === ']' ? 1 : props.threads.length - 1)) % props.threads.length);
      setSelectedComment(0);
      return setScroll(0);
    }
    if (input === 'j' || key.downArrow) return setScroll((n) => Math.min(maxScroll, n + 1));
    if (input === 'k' || key.upArrow) return setScroll((n) => Math.max(0, n - 1));
    if (input === 'J' || key.pageDown) return setScroll((n) => Math.min(maxScroll, n + visible));
    if (input === 'K' || key.pageUp) return setScroll((n) => Math.max(0, n - visible));
  });

  const send = async () => {
    if (!body.trim() || busy || !props.onReply) return;
    setBusy(true);
    setError('');
    try {
      await props.onReply(thread, body.trim());
      props.onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={props.width} height={props.height} overflow="hidden">
      <Text bold>
        {composing ? 'Reply to review thread' : 'Review thread'} {props.threads.length > 1 ? `${selected + 1}/${props.threads.length} · ` : '· '}
        {Math.min(lines.length, scroll + visible)}/{lines.length} lines
      </Text>
      {lines.slice(scroll, scroll + visible).map((line, i) => (
        <MdLineView key={scroll + i} line={line} />
      ))}
      {composing ? (
        <>
          <Box marginTop={1} height={inputRows} overflow="hidden">
            <TextInput
              value={body}
              onChange={setBody}
              onSubmit={() => void send()}
              width={props.width - 4}
              maxRows={inputRows}
              mentions={props.mentions}
              highlightTokens={mentionRules}
              onCompleting={setCompleting}
              placeholder="Write a reply…"
              active={!busy}
            />
          </Box>
          <Text dimColor wrap="truncate">
            Enter: post · Shift+Enter: newline · PgUp/PgDn: read · Esc: cancel
          </Text>
        </>
      ) : reactionMenu ? (
        <>
          <Text wrap="truncate">React to @{safe(thread.comments[selectedComment]?.author ?? 'unknown')} · press 1-8 to toggle</Text>
          <Text dimColor wrap="truncate">
            {REACTIONS.map((reaction, index) => `${index + 1}${reaction.emoji}`).join(' ')}
          </Text>
        </>
      ) : (
        <Text dimColor wrap="truncate">
          j/k: scroll · Tab: comment · {props.threads.length > 1 ? '[/]: thread · ' : ''}
          {props.onReact ? 'a: react · ' : ''}
          {props.onReply ? 'y: reply · ' : ''}e/Esc: close
        </Text>
      )}
      {error ? <Text color="red">{safe(error)}</Text> : null}
    </Box>
  );
}
