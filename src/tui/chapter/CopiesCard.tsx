import { useInput } from '../input.js';
import { Box, Text } from '../themed.js';
import { Hints } from '../KeyBar.js';
import { G } from '../glyphs.js';
import { plural } from '../plural.js';
import { truncate } from '../nav.js';
import { clean, safe } from './text.js';
import type { DiffLine } from '../../types.js';

// The lines of the change shown on the card; a longer one ends in "and N more".
export const COPIES_CARD_LINES = 3;

// n on a hunk whose change other unread hunks of the file make too: y reads them all, Enter just
// this one, and any other key stays on it.
export function CopiesCard(props: { file: string; changed: DiffLine[]; unread: number; total: number; width: number; onAll: () => void; onOne: () => void; onClose: () => void }) {
  useInput((input, key) => {
    if (input === 'y') return props.onAll();
    if (key.return) return props.onOne();
    props.onClose();
  });
  const shown = props.changed.slice(0, COPIES_CARD_LINES);
  const more = props.changed.length - shown.length;
  const w = Math.max(10, props.width - 4);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold wrap="truncate">{`${G.copies} The same change, ${props.total} times in ${safe(props.file.split('/').pop() ?? props.file)}`}</Text>
      <Text> </Text>
      {shown.map((l, i) => (
        <Text key={i} color={l.kind === 'add' ? 'green' : 'red'} wrap="truncate">
          {truncate(`${l.kind === 'add' ? '+' : '-'} ${clean(l.text).trim()}`, w)}
        </Text>
      ))}
      {more ? <Text dimColor>{`  and ${plural(more, 'more line')}`}</Text> : null}
      <Text> </Text>
      <Text wrap="truncate">{`${plural(props.unread, 'other hunk')} making it ${props.unread === 1 ? 'is' : 'are'} still unread.`}</Text>
      <Text> </Text>
      <Hints
        keys={[
          ['y', `read all ${props.unread + 1}`],
          ['enter', 'just this one'],
          ['esc', 'stay'],
        ]}
      />
    </Box>
  );
}
