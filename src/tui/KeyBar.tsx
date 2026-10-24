import { Box, Text, useTheme } from './themed.js';
import { SURFACES, TERMINAL_THEME } from './theme.js';

// A key named in a hint, lightly accented so it stands out from the dim text around it. Keep
// it out of a dimColor parent: Ink dims nested text too.
export function Key(props: { k: string }) {
  return (
    <Text color="cyan" bold>
      {props.k}
    </Text>
  );
}

// A key in a bar, drawn as a keycap on the popup surface; with the terminal's colors, which
// have no surface to draw it on, bold cyan.
function Cap(props: { k: string; themed: boolean }) {
  return props.themed ? (
    <Text backgroundColor={SURFACES.popup} color="cyan" bold>
      {` ${props.k} `}
    </Text>
  ) : (
    <Text color="cyan" bold>
      {props.k}
    </Text>
  );
}

const useCaps = () => useTheme().name !== TERMINAL_THEME;

// One hint: the key, what it does, and optionally the group it belongs to. A dim rule separates
// groups, so the eye finds moving, commenting, and viewing at a glance.
export type Hint = [key: string, label: string, group?: string];

const GAP = '   ';
const SEP = '│' + GAP;
const size = ([k, label]: Hint, cap = 0) => k.length + cap + 1 + label.length + GAP.length;
const more = (n: number) => `+${n} more`;

// The hints that fit in `room` columns, left to right, with a separator wherever the group
// changes, and how many were left out.
export function fitHints(hints: Hint[], room: number, cap = 0): { shown: (Hint | 'sep')[]; dropped: number } {
  const lay = (budget: number) => {
    const shown: (Hint | 'sep')[] = [];
    let used = 0;
    let count = 0;
    for (const h of hints) {
      const last = shown.at(-1);
      const sep = last && last !== 'sep' && h[2] !== last[2] ? SEP.length : 0;
      if (used + sep + size(h, cap) > budget) break;
      if (sep) shown.push('sep');
      shown.push(h);
      used += sep + size(h, cap);
      count++;
    }
    return { shown, dropped: hints.length - count };
  };
  const all = lay(room);
  // Not all fit: make room for the count of the rest, so the bar never pretends to be complete.
  return all.dropped ? lay(room - more(hints.length).length - GAP.length) : all;
}

// A short line of key hints inside a panel or popup, in the key bar's style, cut at the panel's
// edge. `note` (a state, a percentage) follows in dim text.
export function Hints(props: { keys: Hint[]; note?: string }) {
  const themed = useCaps();
  return (
    <Text wrap="truncate">
      {props.keys.map(([k, label], i) => (
        <Text key={`${k}:${i}`}>
          {i ? GAP : ''}
          <Cap k={k} themed={themed} />
          <Text>{` ${label}`}</Text>
        </Text>
      ))}
      {props.note ? <Text dimColor>{`${GAP}${props.note}`}</Text> : null}
    </Text>
  );
}

// Key hints, kept left to right while they fit, then `+N more`. `status` (modes that are on)
// and the `end` hints sit at the right edge and are never dropped, so help stays reachable on
// any width. Every bar draws its keys the same way; `accent` is kept for callers that pass it.
export function KeyBar(props: { keys: Hint[]; end?: Hint[]; status?: string; width: number; accent?: boolean }) {
  const themed = useCaps();
  const cap = themed ? 2 : 0;
  const hint = ([k, label]: Hint, i: number) => (
    <Text key={`${k}:${i}`}>
      <Cap k={k} themed={themed} />
      <Text>{` ${label}`}</Text>
      {GAP}
    </Text>
  );
  const end = props.end ?? [];
  const endWidth = end.reduce((n, h) => n + size(h, cap), 0) + (props.status ? props.status.length + GAP.length : 0);
  const { shown, dropped } = fitHints(props.keys, props.width - 1 - endWidth, cap);
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
