import { Box, Text } from './themed.js';

// A key named in a hint, lightly accented so it stands out from the dim text around it. Keep
// it out of a dimColor parent: Ink dims nested text too.
export function Key(props: { k: string }) {
  return (
    <Text color="cyan" bold>
      {props.k}
    </Text>
  );
}

// One hint: the key, what it does, and optionally the group it belongs to. A dim rule separates
// groups, so the eye finds moving, commenting, and viewing at a glance.
export type Hint = [key: string, label: string, group?: string];

const GAP = '   ';
const SEP = '│' + GAP;
const size = ([k, label]: Hint) => k.length + 1 + label.length + GAP.length;
const more = (n: number) => `+${n} more`;

// The hints that fit in `room` columns, left to right, with a separator wherever the group
// changes, and how many were left out.
export function fitHints(hints: Hint[], room: number): { shown: (Hint | 'sep')[]; dropped: number } {
  const lay = (budget: number) => {
    const shown: (Hint | 'sep')[] = [];
    let used = 0;
    let count = 0;
    for (const h of hints) {
      const last = shown.at(-1);
      const sep = last && last !== 'sep' && h[2] !== last[2] ? SEP.length : 0;
      if (used + sep + size(h) > budget) break;
      if (sep) shown.push('sep');
      shown.push(h);
      used += sep + size(h);
      count++;
    }
    return { shown, dropped: hints.length - count };
  };
  const all = lay(room);
  // Not all fit: make room for the count of the rest, so the bar never pretends to be complete.
  return all.dropped ? lay(room - more(hints.length).length - GAP.length) : all;
}

// Key hints, kept left to right while they fit, then `+N more`. `status` (modes that are on)
// and the `end` hints sit at the right edge and are never dropped, so help stays reachable on
// any width. `accent` colours the keys the way `Key` does.
export function KeyBar(props: { keys: Hint[]; end?: Hint[]; status?: string; width: number; accent?: boolean }) {
  const hint = ([k, label]: Hint, i: number) => (
    <Text key={`${k}:${i}`}>
      {props.accent ? <Key k={k} /> : <Text bold>{k}</Text>}
      <Text dimColor>{` ${label}`}</Text>
      {GAP}
    </Text>
  );
  const end = props.end ?? [];
  const endWidth = end.reduce((n, h) => n + size(h), 0) + (props.status ? props.status.length + GAP.length : 0);
  const { shown, dropped } = fitHints(props.keys, props.width - 1 - endWidth);
  return (
    <Box width={props.width}>
      <Text wrap="truncate">
        {' '}
        {shown.map((h, i) =>
          h === 'sep' ? (
            <Text key={`sep${i}`} dimColor>
              {SEP}
            </Text>
          ) : (
            hint(h, i)
          ),
        )}
        {dropped ? <Text dimColor>{more(dropped)}</Text> : null}
      </Text>
      <Box flexGrow={1} />
      {props.status ? (
        <Text color="yellow">
          {props.status}
          {GAP}
        </Text>
      ) : null}
      <Text wrap="truncate">{end.map(hint)}</Text>
    </Box>
  );
}
