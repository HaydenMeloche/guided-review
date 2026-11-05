import { useState } from 'react';
import { Box, Text } from './themed.js';
import { Key } from './KeyBar.js';
import { useInput } from './input.js';
import { GR_REPO } from '../github/gh.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';

// Reviews posted before gr asks, once, whether the reviewer would star it on GitHub.
export const STAR_AFTER = 5;

export const STAR_URL = `https://github.com/${GR_REPO}`;

// The one-time ask to star gr, over the PR list after a review is posted. Only y stars it, through
// the GitHub API, since the popup can open under a key meant for the list; n or Esc closes it for
// good. `onDone` gets the line the PR list shows after.
export function StarPrompt(props: { star: () => Promise<void>; onDone: (notice?: string) => void; onQuit: () => void }) {
  const [starring, setStarring] = useState(false);
  useInput((input, key) => {
    if (input === 'Q') return props.onQuit();
    if (starring) return;
    if (input === 'y') {
      setStarring(true);
      props.star().then(
        () => props.onDone(`Starred ${GR_REPO}. Thank you!`),
        (e: unknown) => props.onDone(`Couldn't star it (${safe((e as Error).message ?? String(e)).split('\n')[0]}). You can star it at ${STAR_URL}`),
      );
      return;
    }
    if (input === 'n' || input === 'q' || key.escape) props.onDone();
  });
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>You've posted {STAR_AFTER} reviews with Guided Review.</Text>
      <Text> </Text>
      <Text wrap="wrap">If it's been useful, would you star it on GitHub? It helps other people find it.</Text>
      <Text dimColor wrap="truncate">
        {STAR_URL}
      </Text>
      <Text> </Text>
      {starring ? (
        <Text color="cyan">Starring…</Text>
      ) : (
        <Text>
          <Key k="y" />
          <Text dimColor> star it · </Text>
          <Key k="n" />
          <Text dimColor> no thanks</Text>
        </Text>
      )}
    </Box>
  );
}
