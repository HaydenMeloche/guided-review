import type { ReactNode } from 'react';
import { Box, Text, useTheme } from './themed.js';
import { SURFACES, ROLES, TERMINAL_THEME } from './theme.js';
import { meter } from './nav.js';
import { Busy } from './Spinner.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';

// The band at the top of every main screen: the repository (quiet: you know which one you are
// in), the PR or the screen's title, and at the right where you are and how far you have read,
// as the terminal tab's title says. It sits on the popup surface; with the terminal's colors,
// which have no surface for it, it is a plain row.
export function TitleBar(props: {
  repo?: string;
  title: string;
  note?: string; // after the title, dim: who and which commit, a count
  where?: string; // "chapter 1/7", "briefing"
  progress?: { done: number; total: number; hunks?: string }; // read lines, and "18/19 hunks"
  busy?: string; // background work, quietly
  tags?: ReactNode; // badges between the busy spinner and where you are
  width: number;
}) {
  const themed = useTheme().name !== TERMINAL_THEME;
  const m = props.progress ? meter(props.progress.done, props.progress.total, 12) : undefined;
  return (
    <Box width={props.width} flexShrink={0} backgroundColor={themed ? SURFACES.popup : undefined}>
      <Box flexShrink={1} flexGrow={1}>
        <Text wrap="truncate">
          {' '}
          {props.repo ? <Text dimColor>{`${safe(props.repo)} `}</Text> : null}
          <Text bold color={ROLES.title}>
            {safe(props.title)}
          </Text>
          {props.note ? <Text dimColor>{`  ${safe(props.note)}`}</Text> : null}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text wrap="truncate">
          {props.busy ? <Busy text={props.busy} /> : null}
          {props.tags ? <Text> {props.tags}</Text> : null}
          {props.where ? <Text dimColor>{`  ${props.where}`}</Text> : null}
          {m ? (
            <>
              <Text dimColor>{props.where ? ' · ' : '  '}</Text>
              <Text color="green">{m.filled}</Text>
              <Text dimColor>{m.rest}</Text>
              <Text bold>{` ${m.percent}%`}</Text>
              {props.progress?.hunks ? <Text dimColor>{` · ${props.progress.hunks}`}</Text> : null}
            </>
          ) : null}{' '}
        </Text>
      </Box>
    </Box>
  );
}
