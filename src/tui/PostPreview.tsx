import { useMemo, useState } from 'react';
import { useInput } from './input.js';
import { Box, Text } from './themed.js';
import type { Draft, Tour } from '../types.js';
import { buildReviewPayload } from '../review/submit.js';
import { KeyBar } from './KeyBar.js';
import { truncate, wrap } from './nav.js';
import { sanitizeTerminal } from '../util/sanitize.js';

// One draft exactly as the review would post it: the submit screen's p. It is built by buildReviewPayload with only this draft, so any relocation or
// demoted suggestion shows here before anything is posted.
export function PostPreview(props: { draft: Draft; tour: Tour; host: string; stillApplies?: (d: Draft) => boolean; width: number; height: number; onClose: () => void }) {
  const { draft, tour, width } = props;
  const [scroll, setScroll] = useState(0);
  const { host, stillApplies } = props;
  const built = useMemo(() => buildReviewPayload(tour, [draft], 'COMMENT', '', { host, suggestionStillApplies: stillApplies }), [tour, draft, host, stillApplies]);
  const comment = built.payload.comments[0];
  const where = comment ? `${comment.path}:${comment.start_line ? `${comment.start_line}-` : ''}${comment.line} ${comment.side}` : 'the review body';
  const body = comment?.body ?? built.payload.body;
  const lines = body.split('\n').flatMap((l) => wrap(sanitizeTerminal(l), Math.max(10, width)));
  const room = Math.max(1, props.height - 2 - built.moved.length);
  const max = Math.max(0, lines.length - room);
  useInput((input, key) => {
    if (key.escape || input === 'q' || input === 'p') return props.onClose();
    if (key.downArrow || input === 'j') setScroll((s) => Math.min(max, s + 1));
    if (key.upArrow || input === 'k') setScroll((s) => Math.max(0, s - 1));
    if (key.pageDown || input === 'J') setScroll((s) => Math.min(max, s + room));
    if (key.pageUp || input === 'K') setScroll((s) => Math.max(0, s - room));
  });
  return (
    <Box flexDirection="column" width={width} height={props.height}>
      <Text bold wrap="truncate">
        {truncate(`As posted on ${where}`, width)}
      </Text>
      {built.moved.map((m, i) => (
        <Text key={i} color="yellow" wrap="truncate">
          {truncate(`⚠ ${m.note}`, width)}
        </Text>
      ))}
      {lines.slice(scroll, scroll + room).map((l, i) => (
        <Text key={i}>{l || ' '}</Text>
      ))}
      <Box flexGrow={1} />
      <KeyBar
        width={width}
        keys={[
          ['j/k', 'scroll'],
          ['esc', 'back'],
        ]}
      />
    </Box>
  );
}
