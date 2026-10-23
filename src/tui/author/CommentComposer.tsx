import { useEffect, useMemo, useState } from 'react';
import { useInput } from 'ink';
import { Box, Text, useSelected } from '../themed.js';
import { quoteReply, type ConversationSource } from '../../review/feedback.js';
import { TextInput } from '../TextInput.js';
import { KeyBar } from '../KeyBar.js';
import { mentionHighlight } from '../completion.js';
import { truncate } from '../nav.js';
import { age } from '../PickerScreen.js';
import { VERDICT } from './FeedbackBriefing.js';
import { sanitizeTerminal as safe } from '../../util/sanitize.js';

// A comment on the PR's conversation, queued like a thread reply. It starts by choosing what to
// answer, a review summary or someone's comment, which it quotes and mentions; or a new comment.
// Picking another adds its quote to what is already written, so one comment can answer several.
export function CommentComposer(props: {
  sources: ConversationSource[];
  body: string; // the comment already queued, if any
  start: 'pick' | 'edit';
  mentions: string[];
  width: number;
  height: number;
  onSave: (body: string) => void; // an empty body removes the queued comment
  onCancel: () => void;
}) {
  const { sources, width, height } = props;
  const selectedRow = useSelected();
  const [step, setStep] = useState(props.start);
  const [body, setBody] = useState(props.body);
  const [sel, setSel] = useState(0);
  const mentionRules = useMemo(() => [mentionHighlight(props.mentions)].filter((r) => r !== undefined), [props.mentions]);
  const rows = sources.length + 1; // a new comment, then each source
  useEffect(() => setSel((s) => Math.min(s, rows - 1)), [rows]);

  useInput(
    (input, key) => {
      if (key.escape || input === 'q') return props.onCancel();
      if (input === 'j' || key.downArrow) return setSel((s) => Math.min(rows - 1, s + 1));
      if (input === 'k' || key.upArrow) return setSel((s) => Math.max(0, s - 1));
      if (key.return) {
        const src = sources[sel - 1];
        if (src) setBody((b) => quoteReply(src, b));
        return setStep('edit');
      }
    },
    { isActive: step === 'pick' },
  );
  useInput((_input, key) => key.escape && props.onCancel(), { isActive: step === 'edit' });

  const title = (
    <Text bold wrap="truncate">
      Comment on the PR <Text dimColor>· queued, not posted · sends with s</Text>
    </Text>
  );
  if (step === 'edit') {
    return (
      <Box flexDirection="column" paddingX={1} width={width} height={height}>
        {title}
        <Box marginTop={1} flexDirection="column" flexGrow={1}>
          <TextInput
            value={body}
            onChange={setBody}
            onSubmit={(v) => props.onSave(v)}
            width={width - 4}
            maxRows={Math.max(3, height - 5)}
            mentions={props.mentions}
            highlightTokens={mentionRules}
            placeholder="Write a comment for the PR's conversation…"
          />
        </Box>
        <Text dimColor wrap="truncate">
          Enter: queue · Shift+Enter: newline · Esc: cancel · an empty comment removes it
        </Text>
      </Box>
    );
  }

  const listH = Math.max(1, height - 4);
  const top = Math.max(0, Math.min(sel - Math.floor(listH / 2), rows - listH));
  const line = (i: number) => {
    const on = i === sel;
    if (i === 0)
      return (
        <Text key="new" wrap="truncate" {...selectedRow(on)}>
          {props.body.trim() ? '✎ Edit the queued comment' : '+ New comment'}
        </Text>
      );
    const s = sources[i - 1];
    const v = s.state ? (VERDICT[s.state] ?? VERDICT.COMMENTED) : undefined;
    const meta = ` · ${s.kind === 'review' ? 'review' : 'comment'}${v ? ` · ${v.text}` : ''} · ${age(s.at)} `;
    const head = `@${s.author}${meta}`;
    return (
      <Text key={`${s.kind}:${s.url}`} wrap="truncate" {...selectedRow(on)}>
        {safe(`@${s.author}`)}
        <Text color={v?.color} dimColor={!v}>
          {meta}
        </Text>
        <Text dimColor>{truncate(safe(s.body.trim().split('\n')[0]), Math.max(8, width - 4 - head.length))}</Text>
      </Text>
    );
  };
  return (
    <Box flexDirection="column" paddingX={1} width={width} height={height}>
      {title}
      <Text dimColor wrap="truncate">
        {sources.length ? 'Answer a review summary or a comment (it is quoted), or write a new comment.' : 'Nobody else has written a review summary or a comment yet.'}
      </Text>
      <Box marginTop={1} flexDirection="column" height={listH} overflow="hidden">
        {Array.from({ length: Math.min(listH, rows - top) }, (_, k) => line(top + k))}
      </Box>
      <KeyBar
        width={width - 2}
        keys={[
          ['enter', sel ? 'quote and reply' : props.body.trim() ? 'edit' : 'write'],
          ['j/k', 'select'],
          ['esc', 'cancel'],
        ]}
      />
    </Box>
  );
}
