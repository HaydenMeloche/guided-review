import { run, type RunOptions } from '../util/exec.js';
import { escapeRe } from '../util/regex.js';
import { githubWebHost } from '../github/auth.js';

// Every git call that wants text stdout goes through here (blobs.ts spawns its own for binary
// output). Rejects with an ExecError.
export function git(cwd: string, args: string[], opts: Omit<RunOptions, 'cwd'> = {}): Promise<string> {
  return run('git', args, { ...opts, cwd });
}

// owner/name from a remote URL on the GitHub host in any of its spellings: https, scp-style
// ssh, or ssh:// with a port.
export function repoFromRemote(url: string, host = githubWebHost()): string | undefined {
  const m = url.trim().match(new RegExp(`(?:^|[@/])${escapeRe(host)}(?::\\d+)?[:/]([^/]+\\/[^/]+?)(?:\\.git)?\\/?$`, 'i'));
  return m?.[1];
}
