import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planOpen, TERMINAL_SCRIPT, targetArg } from '../src/open.js';
import { installClaudeCommand } from '../src/codexSkill.js';

const gr = ['/usr/local/bin/node', '/opt/gr/bin/gr.js'];
const target = { repo: 'owner/repo', number: 12 };

describe('gr open', () => {
  it('opens a tmux window with argv, never a shell string', () => {
    expect(planOpen({ target, cwd: '/w s', env: { TMUX: '/tmp/tmux' }, platform: 'darwin', gr })).toEqual({
      kind: 'tmux',
      command: 'tmux',
      args: ['new-window', '-c', '/w s', '--', ...gr, 'review', 'owner/repo#12'],
    });
  });

  it('passes values to Terminal.app through AppleScript argv', () => {
    const plan = planOpen({ target, cwd: '/w"; do shell script "x', env: {}, platform: 'darwin', gr });
    expect(plan).toEqual({
      kind: 'terminal',
      command: 'osascript',
      args: ['-e', TERMINAL_SCRIPT, '/w"; do shell script "x', ...gr, 'review', 'owner/repo#12'],
    });
    // The script is constant; argv is shell-quoted inside it.
    expect(TERMINAL_SCRIPT).toContain('on run argv');
    expect(TERMINAL_SCRIPT).toContain('quoted form of');
  });

  it('prints the command elsewhere', () => {
    expect(planOpen({ target, cwd: '/w', env: {}, platform: 'linux', gr })).toEqual({ kind: 'print', commandLine: 'gr review owner/repo#12' });
  });

  it('rejects targets that are not a plain owner/name#N', () => {
    expect(() => targetArg({ repo: 'o/r"; rm -rf ~', number: 1 })).toThrow('Not a PR');
    expect(() => targetArg({ repo: 'o/r', number: -1 })).toThrow('Not a PR');
    expect(targetArg({ repo: 'my.org/re-po_1', number: 3 })).toBe('my.org/re-po_1#3');
  });
});

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('gr install-claude-command', () => {
  it('installs once, refuses to overwrite a changed file, and replaces it with force', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-claude-cmd-'));
    homes.push(home);
    const first = installClaudeCommand({ home });
    expect(first).toEqual({ path: path.join(home, '.claude', 'commands', 'guided-review.md'), status: 'installed' });
    const shipped = fs.readFileSync(first.path, 'utf8');
    expect(shipped).toContain('allowed-tools: Bash(guided-review open:*)');
    expect(shipped).not.toMatch(/osascript|Bash\(open/);
    expect(installClaudeCommand({ home }).status).toBe('already-installed');

    fs.writeFileSync(first.path, 'my edits\n');
    expect(() => installClaudeCommand({ home })).toThrow('--force');
    expect(fs.readFileSync(first.path, 'utf8')).toBe('my edits\n');

    expect(installClaudeCommand({ home, force: true }).status).toBe('replaced');
    expect(fs.readFileSync(first.path, 'utf8')).toBe(shipped);
  });
});
