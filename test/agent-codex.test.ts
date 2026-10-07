import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODEX_PROFILE, codexArgs, codexReadableRoots, liveCodexProcesses, runCodex } from '../src/agent/codex.js';

const originalPath = process.env.PATH;
const roots: string[] = [];

afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

// A fake `codex` on PATH that records its pid, then hangs until killed.
function hangingCodex(): { cwd: string; pidFile: string } {
  const root = tempDir('gr-codex-hang-');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const pidFile = path.join(root, 'pid');
  fs.writeFileSync(
    path.join(bin, 'codex'),
    `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
  return { cwd: root, pidFile };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('Codex confinement', () => {
  it('runs under a read-only permission profile instead of sandbox_mode', () => {
    const worktree = tempDir('gr-codex-wt-');
    const args = codexArgs({ cwd: worktree, model: 'm' }, undefined, undefined);
    expect(args.join(' ')).not.toContain('sandbox_mode');
    expect(args).toContain('--strict-config');
    expect(args).toContain(`default_permissions="${CODEX_PROFILE}"`);
    const profile = args.find((a) => a.startsWith(`permissions.${CODEX_PROFILE}.filesystem=`))!;
    expect(profile).toContain(`":minimal"="read"`);
    expect(profile).toContain(`${JSON.stringify(worktree)}="read"`);
    expect(profile).not.toMatch(/"write"/);
    expect(args).toContain('shell_environment_policy.set={GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1"}');
    expect(args.slice(-3)).toEqual(['-C', worktree, '-']);
    expect(codexArgs({ cwd: worktree }, 'thread-1', undefined).slice(-3)).toEqual(['resume', 'thread-1', '-']);
  });

  it('makes a linked worktree and its git directory readable, never the home directory', () => {
    const repo = tempDir('gr-codex-repo-');
    const common = path.join(repo, '.git');
    const gitDir = path.join(common, 'worktrees', 'pr-1');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
    const worktree = tempDir('gr-codex-wt-');
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${gitDir}\n`);

    const readable = codexReadableRoots(worktree, undefined);
    expect(readable).toEqual(expect.arrayContaining([worktree, gitDir, common]));
    const home = fs.realpathSync(os.homedir());
    for (const root of readable) expect(root === home || home.startsWith(root + path.sep) || root === '/').toBe(false);
  });

  it('narrows the codex install root when it would be the home directory', () => {
    const worktree = tempDir('gr-codex-wt-');
    const bin = path.join(os.homedir(), 'bin', 'codex');
    const readable = codexReadableRoots(worktree, bin);
    expect(readable).not.toContain(fs.realpathSync(os.homedir()));
  });
});

describe('Codex child processes', () => {
  it('kills codex when the abort signal fires', async () => {
    const fake = hangingCodex();
    const controller = new AbortController();
    const run = runCodex('q', { provider: 'codex', cwd: fake.cwd }, { signal: controller.signal }, 's');
    await waitFor(() => fs.existsSync(fake.pidFile) && fs.readFileSync(fake.pidFile, 'utf8') !== '');
    const pid = Number(fs.readFileSync(fake.pidFile, 'utf8'));
    expect(liveCodexProcesses()).toBe(1);
    controller.abort();
    await expect(run).rejects.toThrow(/aborted/);
    await waitFor(() => !alive(pid));
    expect(liveCodexProcesses()).toBe(0);
  });

  it('does not start codex for an already aborted signal', async () => {
    const fake = hangingCodex();
    const controller = new AbortController();
    controller.abort();
    await expect(runCodex('q', { provider: 'codex', cwd: fake.cwd }, { signal: controller.signal }, 's')).rejects.toThrow(/aborted/);
    expect(fs.existsSync(fake.pidFile)).toBe(false);
  });
});
