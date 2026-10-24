import { useInput } from 'ink';
import { Box, Text } from '../themed.js';
import { Hints, type Hint } from '../KeyBar.js';
import { G } from '../glyphs.js';
import { plural } from '../plural.js';

// The end of the tour, as good as its start: what you read, your drafts, the verdict they
// suggest, and s to submit. Q quits; any other key keeps reading.
export function EndCard(props: {
  read: number;
  skipped: number;
  deferred: number;
  unread: number;
  drafts: number;
  verdict: string;
  reasons: string[];
  optional: boolean;
  onSubmit: () => void;
  onOptional: () => void;
  onClose: () => void;
  onQuit: () => void;
}) {
  useInput((input) => {
    if (input === 's') return props.onSubmit();
    if (input === 'Q') return props.onQuit();
    if (input === ']' && props.optional) return props.onOptional();
    props.onClose();
  });
  const left = props.unread + props.deferred;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>End of the tour</Text>
      <Text> </Text>
      <Text wrap="truncate">
        <Text color="green">{`${G.read} ${props.read} read`}</Text>
        {props.skipped ? <Text dimColor>{`   ${G.skipped} ${props.skipped} skipped`}</Text> : null}
        {left ? <Text color="yellow">{`   ${G.deferred} ${plural(left, 'hunk')} still to read`}</Text> : null}
        <Text>{`   ${G.draft} ${plural(props.drafts, 'draft')}`}</Text>
      </Text>
      <Text wrap="truncate">
        Suggested verdict: <Text bold>{props.verdict}</Text>
      </Text>
      {props.reasons.map((r) => (
        <Text key={r} dimColor wrap="truncate">
          {`  · ${r}`}
        </Text>
      ))}
      {props.optional ? <Text dimColor>Import-only changes are optional; ] opens them.</Text> : null}
      <Text> </Text>
      <Hints keys={[['s', 'review drafts and submit'], ...((props.optional ? [[']', 'optional chapter']] : []) as Hint[]), ['esc', 'keep reading']]} />
    </Box>
  );
}
