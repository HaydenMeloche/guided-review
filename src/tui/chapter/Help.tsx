import React from 'react';
import { Box, Text } from '../themed.js';
import { truncate } from '../nav.js';

export const HELP_ROWS: [string, string][] = [
  ['n / p', 'Next or previous hunk (n marks it read), on into the next chapter'],
  ['j / k, J / K', 'Move by line (or 10 lines) inside the hunk'],
  ['v', 'Start or end a range selection'],
  ['] / [', 'Next or previous chapter'],
  ['c / C', 'Comment on the selected line or range / on the whole flow'],
  ['e', 'Read existing review threads on the selected line inline'],
  ['y', 'Reply to an existing review thread on the selected line'],
  ['E / X', 'Edit or delete your draft on the selected line'],
  ['In a comment', '@ people/code (@callers: @tests: @threads: …)'],
  ['  ^T', 'In a comment: suggest a code change with AI'],
  ['?', 'Ask the agent about the selection'],
  ['t', 'Focus the test pane (narrow terminals: toggle source/tests)'],
  ['T', 'Hide or show the test pane beside the code'],
  ['Focused tests', 'n/p test · j/k line · c comment · ? ask · t/Esc back to source'],
  ['U', 'Expand or collapse possible test gaps in the explanation'],
  ['d', 'Chapter diagram (select a node to jump to its code)'],
  ['r', 'Raw unified diff for the hunk'],
  ['S', 'Split view (old beside new) or inline'],
  ['+ / -', 'Show 10 more or fewer lines of the file around the hunk'],
  ['w', 'Hide or show whitespace-only changes'],
  ['x / z / u', 'Mark the hunk skipped / deferred / unread'],
  ['m', 'Move the hunk to another chapter'],
  ['f', 'Cycle Guided, Risk first, Small first, and File order'],
  ['D', 'Re-review: switch between only new and changed hunks and the full review'],
  ['o', 'Open the hunk in your coding agent (set in gr config)'],
  ['i', 'Team checklist for this chapter'],
  ['b / s', 'Briefing / submit screen'],
  ['L', 'Color theme (previews as you move through the list)'],
  ['q / Q', 'Back to the PR list / quit (progress is saved)'],
];
const HELP_KEY_WIDTH = 15;
export const HELP_WIDTH = 2 + 2 + HELP_KEY_WIDTH + Math.max(...HELP_ROWS.map(([, v]) => v.length)); // border, padding, key column

// Rows for keys that need the agent; left out when it is absent.
const AI_HELP_KEYS = new Set(['  ^T', '?']);

// The key reference, sized to the popup: descriptions truncate, and rows past its height are cut.
export function Help(props: { width: number; height: number; ai: boolean }) {
  const inner = props.width - 2;
  const all = props.ai ? HELP_ROWS : HELP_ROWS.filter(([k]) => !AI_HELP_KEYS.has(k)).map(([k, v]): [string, string] => [k, v.replace(' · ? ask', '')]);
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
