import { use, useEffect } from 'react';
import { Box, Text, useTheme } from './themed.js';
import { SURFACES, TERMINAL_THEME } from './theme.js';
import { AnchorContext, EmphasizedKey, InAnchor } from './tutor/anchors.js';

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
function Cap(props: { k: string; themed: boolean; emphasized?: boolean }) {
  // The key the tutor asks for, inverted so it is found at a glance.
  if (props.emphasized)
    return (
      <Text color="cyan" bold inverse>
        {props.themed ? ` ${props.k} ` : props.k}
      </Text>
    );
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

// Whether a hint shows the key the tutor asks for: itself, or one of a pair such as n/p.
const lit = (k: string, emph: string | undefined) => !!emph && (k === emph || k.split('/').includes(emph));

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

// The columns `extraEnd` leaves for the keys at the least.
const KEYS_ROOM = 24;

// Key hints, kept left to right while they fit, then `+N more`. `status` (modes that are on)
// and the `end` hints sit at the right edge and are never dropped, so help stays reachable on
// any width. `extraEnd` goes just before `end` when that leaves the keys room, and is dropped
// first otherwise. Every bar draws its keys the same way; `accent` is kept for callers that pass it.
export function KeyBar(props: { keys: Hint[]; end?: Hint[]; extraEnd?: Hint[]; status?: string; width: number; accent?: boolean }) {
  const themed = useCaps();
  const cap = themed ? 2 : 0;
  // In the tutor, the screen's own bar (not a popup's) inverts the key it asks for, and says
  // which column that key is in, for the tutor's arrow.
  const own = use(InAnchor) === 'keybar';
  const emphasized = use(EmphasizedKey);
  const registry = use(AnchorContext);
  const emph = own ? emphasized : undefined;
  const hint = ([k, label]: Hint, i: number) => (
    <Text key={`${k}:${i}`}>
      <Cap k={k} themed={themed} emphasized={lit(k, emph)} />
      <Text>{` ${label}`}</Text>
      {GAP}
    </Text>
  );
  const widthOf = (hints: Hint[]) => hints.reduce((n, h) => n + size(h, cap), 0);
  const fixed = widthOf(props.end ?? []) + (props.status ? props.status.length + GAP.length : 0);
  const extra = props.extraEnd ?? [];
  const end = extra.length && props.width - 1 - fixed - widthOf(extra) >= KEYS_ROOM ? [...extra, ...(props.end ?? [])] : (props.end ?? []);
  const endWidth = widthOf(end) + (props.status ? props.status.length + GAP.length : 0);
  const room = props.width - 1 - endWidth;
  let { shown, dropped } = fitHints(props.keys, room, cap);
  // The key the tutor asks for stays on the bar: when it would be under +N more, it goes first.
  if (emph && !shown.some((h) => h !== 'sep' && lit(h[0], emph))) {
    const asked = props.keys.filter((h) => lit(h[0], emph));
    if (asked.length) ({ shown, dropped } = fitHints([...asked, ...props.keys.filter((h) => !asked.includes(h))], room, cap));
  }
  // The emphasized key's column: one space, then the hints and separators before it.
  let column: number | undefined;
  if (emph) {
    let x = 1;
    for (const h of shown) {
      if (h !== 'sep' && lit(h[0], emph)) {
        column = x + (themed ? 1 : 0);
        break;
      }
      x += h === 'sep' ? SEP.length : size(h, cap);
    }
  }
  // Or among the hints at the right end, which end at the bar's edge.
  if (emph && column === undefined) {
    let x = props.width - widthOf(end);
    for (const h of end) {
      if (lit(h[0], emph)) {
        column = x + (themed ? 1 : 0);
        break;
      }
      x += size(h, cap);
    }
  }
  useEffect(() => {
    if (own) registry?.column('keybar', column);
  }, [own, registry, column]);
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
