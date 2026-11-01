import { run, type RunOptions } from '../util/exec.js';
import { escapeRe } from '../util/regex.js';
import { gitAuthEnv, githubWebHost } from '../github/auth.js';

// Every git call that wants text stdout goes through here (blobs.ts spawns its own for binary
// output, and never fetches). Rejects with an ExecError. Every call carries gitAuthEnv, since
// reading a blob a blobless clone lacks fetches it.
export function git(cwd: string, args: string[], opts: Omit<RunOptions, 'cwd'> = {}): Promise<string> {
  return run('git', args, { ...opts, cwd, env: { ...gitAuthEnv(), ...opts.env } });
}

// owner/name from a remote URL on the GitHub host in any of its spellings: https, scp-style
// ssh, or ssh:// with a port.
export function repoFromRemote(url: string, host = githubWebHost()): string | undefined {
  const m = url.trim().match(new RegExp(`(?:^|[@/])${escapeRe(host)}(?::\\d+)?[:/]([^/]+\\/[^/]+?)(?:\\.git)?\\/?$`, 'i'));
  return m?.[1];
}
