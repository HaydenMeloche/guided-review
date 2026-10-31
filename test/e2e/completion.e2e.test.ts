import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import pty from 'node-pty';
import { runGr, sandbox, type Sandbox } from './harness.js';

// The completion scripts, run by the shells they are for. A shell function stands in for gr, so
// PR numbers come from it rather than GitHub. Its first lines are what a gr too old to know
// __complete prints, its help, which must not complete.
const FAKE_GR = `gr() { printf '  Usage\\n    $ gr review <number>\\n12\\tFix the thing\\n34\\tAdd: colons\\n'; }`;

let box: Sandbox;
let repo: string;

beforeEach(() => {
  box = sandbox();
  repo = path.join(box.root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: box.env });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'start');
  git('branch', 'feature-x');
});
afterEach(() => box.cleanup());

async function script(shell: string): Promise<string> {
  const { code, stdout } = await runGr(box, ['completion', shell]);
  expect(code).toBe(0);
  const file = path.join(box.root, `gr.${shell}`);
  fs.writeFileSync(file, stdout);
  return file;
}

const has = (shell: string) => {
  try {
    execFileSync(shell, ['-c', 'exit 0']);
    return true;
  } catch {
    return false;
  }
};

describe('gr completion', () => {
  it('says which shells it knows', async () => {
    const { code, stderr } = await runGr(box, ['completion', 'tcsh']);
    expect(code).toBe(1);
    expect(stderr).toContain('completion zsh|bash|fish');
  });

  it('prints no PRs, quietly, outside a repository', async () => {
    expect(await runGr(box, ['__complete', 'prs'])).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it.skipIf(!has('bash'))('completes commands, flags, PRs and branches in bash', async () => {
    const file = await script('bash');
    const complete = (...words: string[]) =>
      execFileSync('bash', ['-c', `source "$0"; ${FAKE_GR}; COMP_WORDS=("$@"); COMP_CWORD=$(($# - 1)); _gr; echo "\${COMPREPLY[*]}"`, file, ...words], {
        cwd: repo,
        env: box.env,
        encoding: 'utf8',
      }).trim();
    expect(complete('gr', 're')).toBe('review');
    expect(complete('gr', 'review', '')).toBe('12 34');
    expect(complete('gr', 'review', '--')).toBe('--no-agent --fresh');
    expect(complete('gr', 'preview', '--base', 'fea')).toBe('feature-x');
    expect(complete('gr', 'diff', 'main..fe')).toBe('main..feature-x');
    expect(complete('gr', 'diff', 'main...fe')).toBe('main...feature-x');
    expect(complete('gr', 'completion', '')).toBe('zsh bash fish');
  });

  it.skipIf(!has('zsh'))('completes commands, flags with what they do, PRs with their titles, and branches in zsh', async () => {
    const file = await script('zsh');
    const zsh = pty.spawn('zsh', ['-f', '-i'], { cols: 120, rows: 30, cwd: repo, env: { ...box.env, PS1: '$ ' } });
    let out = '';
    zsh.onData((d) => (out += d));
    const waitOut = async (match: RegExp) => {
      const deadline = Date.now() + 10_000;
      while (!match.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    };
    // What the shell prints after typing `line` and Tab, escapes and the echoed line aside.
    const tab = async (line: string, expected: RegExp) => {
      out = '';
      zsh.write(`${line}\t`);
      const deadline = Date.now() + 10_000;
      const plain = () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
      while (!expected.test(plain()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(plain()).toMatch(expected);
      zsh.write('\x03');
      await new Promise((r) => setTimeout(r, 200));
    };
    try {
      // Typed ahead while compinit runs, keys can be lost: wait for the shell to say it's ready
      // (the quotes keep the echoed command from matching).
      zsh.write(`autoload -U compinit && compinit -u; source ${file}; ${FAKE_GR}; echo RE''ADY\r`);
      await waitOut(/READY/);
      await tab('gr rev', /gr review /);
      await tab('gr review ', /12\s+-- Fix the thing[\s\S]*34\s+-- Add: colons/);
      await tab('gr review --', /--fresh\s+-- Rebuild the tour/);
      await tab('gr diff main..fea', /gr diff main\.\.feature-x/);
    } finally {
      zsh.kill();
    }
  });
});
