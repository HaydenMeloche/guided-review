import { Box, Text } from './themed.js';
import { Key } from './KeyBar.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';

// A failure, in gr's words: what went wrong, the raw message under it (dim), and what to do next.
// The PR list and the error screen show the same block.

export interface Problem {
  title: string;
  next: string; // the step to take, written out
  command?: string; // a command to run for it
}

// The common failures by their message, so the next step fits; anything else says what failed.
export function classifyError(message: string, failed: string): Problem {
  if (/not installed or not on PATH/i.test(message)) return { title: 'The GitHub CLI (gh) is not installed', next: 'Install gh, or use a personal access token:', command: 'gr config' };
  if (/gh auth login|not logged in|HTTP 401|authentication|bad credentials/i.test(message))
    return { title: 'gh is not signed in to GitHub', next: 'Sign in, then press r to retry:', command: 'gh auth login' };
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|could not resolve host|dial tcp|network is unreachable|socket hang up/i.test(message))
    return { title: 'GitHub could not be reached', next: 'Check your connection, then press r to retry.' };
  if (/could not resolve to a pullrequest|HTTP 404|not found/i.test(message))
    return { title: 'That PR was not found', next: 'Check the number and the repository, or give both:', command: 'gr review owner/repo#1234' };
  return { title: failed, next: 'Press r to retry.' };
}

export function ErrorBlock(props: { message: string; failed: string; width: number }) {
  const p = classifyError(props.message, props.failed);
  return (
    <Box flexDirection="column" width={props.width}>
      <Text color="red" bold wrap="truncate">
        {p.title}
      </Text>
      <Text dimColor wrap="wrap">
        {safe(props.message)}
      </Text>
      <Text wrap="truncate">
        {p.next}
        {p.command ? (
          <>
            {' '}
            <Key k={p.command} />
          </>
        ) : null}
      </Text>
    </Box>
  );
}
