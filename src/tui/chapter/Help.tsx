import React from 'react';
import { Box, Text } from '../themed.js';
import { truncate } from '../nav.js';
import { KEYS } from './keys.js';

const HELP = KEYS.flatMap((r) => (r.help ? [{ keys: r.keys, help: r.help, ai: !!r.ai }] : []));
const HELP_KEY_WIDTH = 15;
export const HELP_WIDTH = 2 + 2 + HELP_KEY_WIDTH + Math.max(...HELP.map((r) => r.help.length)); // border, padding, key column
export const HELP_HEIGHT = HELP.length + 4; // border, title, footer

// The key reference, sized to the popup: descriptions truncate, and rows past its height are cut.
// Rows for keys that need the agent are left out when it is absent.
export function Help(props: { width: number; height: number; ai: boolean }) {
  const inner = props.width - 2;
  const all = props.ai ? HELP.map((r): [string, string] => [r.keys, r.help]) : HELP.filter((r) => !r.ai).map((r): [string, string] => [r.keys, r.help.replace(' · ? ask', '')]);
  const rows = all.slice(0, Math.max(0, props.height - 2));
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Keys</Text>
      {rows.map(([k, v]) => (
        <Text key={k} wrap="truncate">
          <Text bold color="cyan">
            {k.padEnd(HELP_KEY_WIDTH)}
          </Text>
          {truncate(v, Math.max(1, inner - HELP_KEY_WIDTH))}
        </Text>
      ))}
      <Text dimColor>{rows.length < all.length ? `${all.length - rows.length} more on a taller terminal · ` : ''}any key to close</Text>
    </Box>
  );
}
