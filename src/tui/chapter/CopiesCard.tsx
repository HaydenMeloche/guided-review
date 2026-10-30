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

// The files named on the card when the copies span more than one; more end in "and N more".
export const COPIES_CARD_FILES = 6;

const listed = (n: number, max: number) => Math.min(n, max) + (n > max ? 1 : 0);

// The card's height: its change lines, and the files when the copies span more than one.
export const copiesCardHeight = (changed: number, files: number) => 8 + listed(changed, COPIES_CARD_LINES) + (files > 1 ? listed(files, COPIES_CARD_FILES) : 0);

const base = (file: string) => file.split('/').pop() ?? file;

// n on a hunk whose change other unread hunks make too, in this file or others: y reads them all,
// Enter just this one, and any other key stays on it. files: where the copies are, this one's first.
export function CopiesCard(props: { files: string[]; changed: DiffLine[]; unread: number; total: number; width: number; onAll: () => void; onOne: () => void; onClose: () => void }) {
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
      <Text bold wrap="truncate">{`${G.copies} The same change, ${props.total} times in ${props.files.length > 1 ? plural(props.files.length, 'file') : safe(base(props.files[0]))}`}</Text>
      {props.files.length > 1
        ? props.files.slice(0, COPIES_CARD_FILES).map((f) => (
            <Text key={f} dimColor>
              {truncate(safe(base(f)), w)}
            </Text>
          ))
        : null}
      {props.files.length > COPIES_CARD_FILES ? <Text dimColor>{`and ${plural(props.files.length - COPIES_CARD_FILES, 'more file')}`}</Text> : null}
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
