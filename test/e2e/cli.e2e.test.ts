import fs from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureRepo, KEY, runGr, sandbox, startGr, type Sandbox } from './harness.js';

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.cleanup());

describe('gr commands that print and exit', () => {
  it('prints the version and usage for --help', async () => {
    const result = await runGr(box, ['--help']);
    expect(result.code).toBe(0);
    const { version } = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../package.json'), 'utf8')) as { version: string };
    expect(result.stdout).toContain(`Guided Review ${version}: Read a code change the way the code runs`);
    expect(result.stdout).toContain('$ gr review <number|URL>');
    expect(result.stdout).toContain('$ gr feedback [number|URL]');
    expect(result.stdout).toContain('--no-agent');
  });

  it('prints usage and fails for an unknown command', async () => {
    const result = await runGr(box, ['frobnicate']);
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).toContain('Usage');
  });

  it('refuses to start the tour without a terminal, before calling gh', async () => {
    for (const args of [['preview', '--no-agent'], ['review', '12', '--no-agent'], ['review'], ['feedback', '12', '--no-agent'], ['feedback']]) {
      const result = await runGr(box, args, fixtureRepo(box));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('interactive terminal app');
      fs.rmSync(path.join(box.root, 'repo'), { recursive: true, force: true });
    }
    expect(box.ghCalls()).toEqual([]);
  });

  it('refuses to build a tour without a model', async () => {
    const flagged = await runGr(box, ['build', 'o/r#1', '--no-agent']);
    expect(flagged.code).toBe(1);
    expect(flagged.stderr).toContain('--no-agent turns the model off');
    fs.mkdirSync(box.env.GR_HOME!, { recursive: true });
    fs.writeFileSync(path.join(box.env.GR_HOME!, 'config.json'), '{ "provider": "none" }\n');
    const configured = await runGr(box, ['build', 'o/r#1']);
    expect(configured.code).toBe(1);
    expect(configured.stderr).toContain('your config chooses no model');
    expect(box.ghCalls()).toEqual([]);
  });

  it('prints help under the guided-review name', async () => {
    const alias = path.join(box.root, 'bin', 'guided-review');
    fs.symlinkSync(path.resolve(import.meta.dirname, '../../bin/gr.js'), alias);
    const result = await new Promise<{ stdout: string }>((resolve) => {
      execFile(process.execPath, [alias, '--help'], { env: box.env, encoding: 'utf8' }, (_err, stdout) => resolve({ stdout }));
    });
    expect(result.stdout).toContain('$ guided-review review <number|URL>');
  });

  it('prints the stack for errors only with GR_DEBUG=1', async () => {
    fs.mkdirSync(path.join(box.env.HOME!, '.claude', 'commands', 'guided-review.md'), { recursive: true });
    const plain = await runGr(box, ['install-claude-command']);
    expect(plain.code).toBe(1);
    expect(plain.stderr).toContain('not a regular file');
    expect(plain.stderr).not.toContain('    at ');
    const debug = await runGr({ ...box, env: { ...box.env, GR_DEBUG: '1' } }, ['install-claude-command']);
    expect(debug.stderr).toContain('    at ');
  });

  it('cleans up with no worktrees present', async () => {
    const result = await runGr(box, ['cleanup']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Removed 0 PR worktree(s).');
  });

  it('installs the Codex skill once', async () => {
    const first = await runGr(box, ['install-codex-skill']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('Installed');
    expect(fs.existsSync(path.join(box.env.CODEX_HOME!, 'skills', 'guided-review', 'SKILL.md'))).toBe(true);
    const second = await runGr(box, ['install-codex-skill']);
    expect(second.stdout).toContain('already installed');
  });

  it('installs the Claude Code command into HOME', async () => {
    const result = await runGr(box, ['install-claude-command']);
    expect(result.code).toBe(0);
    expect(fs.readFileSync(path.join(box.env.HOME!, '.claude', 'commands', 'guided-review.md'), 'utf8')).toContain('guided-review open --preview');
  });

  it('keeps an edited Claude Code command unless --force is given', async () => {
    const dest = path.join(box.env.HOME!, '.claude', 'commands', 'guided-review.md');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, 'my own command\n');
    const refused = await runGr(box, ['install-claude-command']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('--force');
    expect(fs.readFileSync(dest, 'utf8')).toBe('my own command\n');
    const forced = await runGr(box, ['install-claude-command', '--force']);
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain('Replaced');
    expect(fs.readFileSync(dest, 'utf8')).toContain('guided-review open --preview');
  });
});

describe('gr with a terminal', () => {
  it('opens setup on the first run, and q leaves without saving', async () => {
    const session = startGr(box, ['review', '12'], { cwd: box.root });
    await session.waitFor('turns a pull request into a guided tour');
    session.press('q');
    await session.waitFor('no config saved');
    expect(session.screen()).toContain('--no-agent');
    expect(await session.exited).toBe(1);
    expect(fs.existsSync(path.join(box.env.GR_HOME!, 'config.json'))).toBe(false);
  });

  it('saves the first-run setup and carries on with the command', async () => {
    const session = startGr(box, ['review', '12'], { cwd: box.root });
    await session.waitFor('turns a pull request into a guided tour');
    session.press(KEY.enter);
    await session.waitFor('Color theme');
    session.press(KEY.enter);
    await session.waitFor('Model provider');
    await session.waitFor('Nothing found on this machine');
    // No AI model, after the three recommended providers.
    for (const about of ['OpenAI models', "Cursor's models", 'Static analysis only']) {
      session.press('j');
      await session.waitFor(about);
    }
    session.press(KEY.enter);
    await session.waitFor('Coding agent');
    session.press(KEY.enter);
    // The fake gh runs but isn't signed in, so GitHub access is asked for, starting on gh.
    await session.waitFor('GitHub access');
    await session.waitFor('your gh login');
    session.press(KEY.enter);
    await session.waitFor('Ready to save');
    expect(session.screen()).toContain('Provider: none');
    session.press(KEY.enter);
    // Saved, then review 12 runs and stops at the fake gh.
    await session.waitFor(/Saved .*config\.json/);
    expect(await session.exited).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(box.env.GR_HOME!, 'config.json'), 'utf8'))).toMatchObject({ provider: 'none', chapterOrder: 'guide' });
  });

  it('opens the same setup from gr config, starting from the saved settings', async () => {
    fs.mkdirSync(box.env.GR_HOME!, { recursive: true });
    fs.writeFileSync(path.join(box.env.GR_HOME!, 'config.json'), JSON.stringify({ provider: 'none', chapterOrder: 'risk' }));
    const session = startGr(box, ['config'], { cwd: box.root });
    await session.waitFor('Provider: none');
    session.press(KEY.enter);
    await session.waitFor('Color theme');
    session.press(KEY.enter);
    await session.waitFor('Model provider');
    session.press(KEY.escape);
    await session.waitFor('Color theme');
    session.press(KEY.escape);
    await session.waitFor('walk through setup');
    session.press('q');
    await session.waitFor('Nothing saved');
    expect(await session.exited).toBe(0);
  });

  it('explains a missing PR when the branch has none', async () => {
    const session = startGr(box, ['review', '--no-agent'], { cwd: fixtureRepo(box) });
    await session.waitFor('no PR given');
    expect(await session.exited).toBe(1);
  });

  it('explains a missing PR for feedback when the branch has none', async () => {
    const session = startGr(box, ['feedback', '--no-agent'], { cwd: fixtureRepo(box) });
    await session.waitFor('no PR given');
    await session.waitFor('feedback <number|URL>');
    expect(await session.exited).toBe(1);
  });

  it('fails preview outside a git repository', async () => {
    const session = startGr(box, ['preview', '--no-agent'], { cwd: box.root });
    await session.waitFor('must run inside a git repository');
    expect(await session.exited).toBe(1);
  });
});

describe('gr open', () => {
  // Fake launchers on PATH record their argv, one argument per line.
  function fakeLauncher(name: string): () => string[] {
    const log = path.join(box.root, `${name}.log`);
    fs.writeFileSync(path.join(box.root, 'bin', name), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\n`, { mode: 0o755 });
    return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  }

  it('opens a tmux window running gr review with the PR as one argument', async () => {
    const tmux = fakeLauncher('tmux');
    const repo = fixtureRepo(box);
    const result = await runGr({ ...box, env: { ...box.env, TMUX: '/tmp/fake,1,0' } }, ['open', 'https://github.com/owner/repo/pull/12'], repo);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Opened owner/repo#12 in a new tmux window.');
    const args = tmux();
    expect(args.slice(0, 4)).toEqual(['new-window', '-c', repo, '--']);
    expect(args.slice(-2)).toEqual(['review', 'owner/repo#12']);
    expect(box.ghCalls()).toEqual([]);
  });

  it.runIf(process.platform === 'darwin')('opens Terminal.app through osascript argv', async () => {
    const osascript = fakeLauncher('osascript');
    const result = await runGr(box, ['open', 'owner/repo#7']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('new Terminal window');
    const args = osascript();
    expect(args[0]).toBe('-e');
    expect(args.join('\n')).toContain('on run argv');
    expect(args.slice(-2)).toEqual(['review', 'owner/repo#7']);
  });

  it('rejects anything that is not a PR', async () => {
    const tmux = fakeLauncher('tmux');
    const osascript = fakeLauncher('osascript');
    const result = await runGr({ ...box, env: { ...box.env, TMUX: '/tmp/fake,1,0' } }, ['open', '12"; do shell script "touch /tmp/pwned']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Not a PR number or URL');
    expect([...tmux(), ...osascript()]).toEqual([]);
  });

  it('fails clearly when the branch has no PR', async () => {
    const result = await runGr(box, ['open'], fixtureRepo(box));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no PR given');
  });
});
