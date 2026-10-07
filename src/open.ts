import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// `gr open` starts `gr review <pr>` in a new terminal window, so tools like the
// Claude Code slash command never need osascript or open themselves. Every
// argument travels as an argv entry; nothing is spliced into a shell or
// AppleScript string.

// Terminal.app only runs shell command strings, so the script builds one from
// argv with `quoted form of`, which single-quotes each item for the shell.
export const TERMINAL_SCRIPT = `on run argv
  set cmd to "cd " & quoted form of (item 1 of argv) & " &&"
  repeat with i from 2 to count of argv
    set cmd to cmd & " " & quoted form of (item i of argv)
  end repeat
  tell application "Terminal"
    activate
    do script cmd
  end tell
end run`;

export interface OpenTarget {
  repo: string;
  number: number;
}

export type OpenPlan = { kind: 'tmux' | 'terminal'; command: string; args: string[] } | { kind: 'print'; commandLine: string };

const REPO = /^[\w.-]+\/[\w.-]+$/;

// The canonical owner/name#N form; it holds no shell metacharacters.
export function targetArg(target: OpenTarget): string {
  if (!REPO.test(target.repo) || !Number.isSafeInteger(target.number) || target.number <= 0) {
    throw new Error(`Not a PR: ${target.repo}#${target.number}`);
  }
  return `${target.repo}#${target.number}`;
}

export function defaultGrCommand(): string[] {
  // Run this install's bin/gr.js with this node, so a shell alias for `gr`
  // (Oh My Zsh defines `alias gr='git remote'`) cannot shadow it.
  return [process.execPath, fileURLToPath(new URL('../bin/gr.js', import.meta.url))];
}

export function planOpen(opts: { target: OpenTarget; cwd: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; gr?: string[] }): OpenPlan {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const gr = opts.gr ?? defaultGrCommand();
  const review = [...gr, 'review', targetArg(opts.target)];
  if (env.TMUX) {
    // With more than one argument, tmux runs the command directly, without a shell.
    return { kind: 'tmux', command: 'tmux', args: ['new-window', '-c', opts.cwd, '--', ...review] };
  }
  if (platform === 'darwin') {
    return { kind: 'terminal', command: 'osascript', args: ['-e', TERMINAL_SCRIPT, opts.cwd, ...review] };
  }
  return { kind: 'print', commandLine: `gr review ${targetArg(opts.target)}` };
}

export function runOpen(plan: OpenPlan): void {
  if (plan.kind === 'print') return;
  const result = spawnSync(plan.command, plan.args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(plan.command)} failed${result.stderr ? `: ${result.stderr.trim()}` : ` with exit code ${result.status}`}`);
  }
}
