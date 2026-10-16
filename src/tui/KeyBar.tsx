import { Box, Text } from 'ink';

// A key named in a hint, lightly accented so it stands out from the dim text around it. Keep
// it out of a dimColor parent: Ink dims nested text too.
export function Key(props: { k: string }) {
  return (
    <Text color="cyan" bold>
      {props.k}
    </Text>
  );
}

// Key hints, kept left to right while they fit. `status` (modes that are on) and the `end`
// hints sit at the right edge and are never dropped, so help stays reachable on any width.
// `accent` colours the keys the way `Key` does.
export function KeyBar(props: { keys: [string, string][]; end?: [string, string][]; status?: string; width: number; accent?: boolean }) {
  const GAP = '   ';
  const size = ([k, label]: [string, string]) => k.length + 1 + label.length + GAP.length;
  const hint = ([k, label]: [string, string]) => (
    <Text key={k}>
      {props.accent ? <Key k={k} /> : <Text bold>{k}</Text>}
      <Text dimColor>{` ${label}`}</Text>
      {GAP}
    </Text>
  );
  const end = props.end ?? [];
  const endWidth = end.reduce((n, h) => n + size(h), 0) + (props.status ? props.status.length + GAP.length : 0);
  const keys: [string, string][] = [];
  let used = 1 + endWidth; // leading space
  for (const h of props.keys) {
    if (used + size(h) > props.width) break;
    used += size(h);
    keys.push(h);
  }
  return (
    <Box width={props.width}>
      <Text wrap="truncate"> {keys.map(hint)}</Text>
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
