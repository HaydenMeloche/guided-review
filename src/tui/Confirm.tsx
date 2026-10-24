import type { ReactNode } from 'react';
import { Box, Text } from './themed.js';
import { Key } from './KeyBar.js';

// Every yes-or-no question in gr, in one form: the question in yellow where the key bar was,
// then the keys, which a long question never pushes off the row. y (or Enter) confirms; any
// other key cancels.
export function Confirm(props: { children: ReactNode; yes?: string }) {
  return (
    <Box>
      <Box flexShrink={1}>
        <Text color="yellow" bold wrap="truncate">
          {props.children}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text>
          {'  '}
          <Key k="y" />
          <Text dimColor>{` ${props.yes ?? 'confirm'} · `}</Text>
          <Key k="esc" />
          <Text dimColor> cancel</Text>
        </Text>
      </Box>
    </Box>
  );
}
