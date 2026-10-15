import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import pty from 'node-pty';
import xterm from '@xterm/headless';

const GR = path.resolve(import.meta.dirname, '../../bin/gr.js');

// An isolated world for one test: its own GR_HOME, HOME, CODEX_HOME, and a fake
// `gh` first on PATH that logs its arguments and fails, as if no remote exists.
export interface Sandbox {
  root: string;
  env: NodeJS.ProcessEnv;
  ghCalls: () => string[];
  cleanup: () => void;
}

export function sandbox(): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gr-e2e-')));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const ghLog = path.join(root, 'gh.log');
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "$*" >> "$GH_LOG"\necho "gh: not available in e2e tests" >&2\nexit 1\n', { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HOME: path.join(root, 'home'),
    GR_HOME: path.join(root, 'gr-home'),
    CODEX_HOME: path.join(root, 'codex-home'),
    GH_LOG: ghLog,
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GR_NO_UPDATE_CHECK: '1',
  };
  fs.mkdirSync(env.HOME!);
  return {
    root,
    env,
    ghCalls: () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean) : []),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// A repo on `feature/discount` one commit ahead of origin/main, which is what `gr preview` diffs against.
export function fixtureRepo(box: Sandbox): string {
  const repo = path.join(box.root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: box.env, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'src/invoice.ts'), 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n');
  fs.writeFileSync(path.join(repo, 'src/invoice.test.ts'), "import { total } from './invoice';\ntest('total sums items', () => { expect(total([1, 2])).toBe(3); });\n");
  git('add', '.');
  git('commit', '-m', 'Add invoice totals');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-b', 'feature/discount');
  fs.writeFileSync(
    path.join(repo, 'src/invoice.ts'),
    'export function total(items: number[], discount = 0): number {\n  const sum = items.reduce((a, b) => a + b, 0);\n  return sum - sum * discount;\n}\n',
  );
  git('commit', '-am', 'Apply a discount to invoice totals');
  return repo;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Runs gr without a terminal, for the commands that print and exit.
export function runGr(box: Sandbox, args: string[], cwd = box.root): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [GR, ...args], { cwd, env: box.env, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

export interface Session {
  screen: () => string;
  press: (...keys: string[]) => void;
  type: (text: string) => void;
  waitFor: (match: string | RegExp, timeoutMs?: number) => Promise<string>;
  exited: Promise<number>;
  kill: () => void;
}

const QUIET_MS = 100;

export const KEY = { enter: '\r', escape: '\u001b', tab: '\t' } as const;

// Runs gr in a pseudo-terminal and mirrors its output into a headless xterm,
// so tests read the screen the way a user would see it.
export function startGr(box: Sandbox, args: string[], opts: { cwd: string; cols?: number; rows?: number }): Session {
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 36;
  const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
  const proc = pty.spawn(process.execPath, [GR, ...args], { cols, rows, cwd: opts.cwd, env: box.env });
  let lastData = Date.now();
  proc.onData((data) => {
    lastData = Date.now();
    term.write(data);
  });
  let alive = true;
  const exited = new Promise<number>((resolve) =>
    proc.onExit(({ exitCode }) => {
      alive = false;
      resolve(exitCode);
    }),
  );

  const screen = () => {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < rows; i++) lines.push(buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '');
    return lines.join('\n');
  };

  // A match can land mid-frame (a header painted before the panel under it), and Ink binds its
  // input handlers in effects that run after the first paint. Wait for the output to go quiet so
  // assertions see the whole frame and the next key press is not dropped.
  const settle = async () => {
    const until = Date.now() + 2000;
    while (Date.now() - lastData < QUIET_MS && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise<void>((resolve) => term.write('', resolve));
    return screen();
  };

  const waitFor = async (match: string | RegExp, timeoutMs = 10_000) => {
    const hit = (s: string) => (typeof match === 'string' ? s.includes(match) : match.test(s));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // Flush pending writes into the buffer before reading it.
      await new Promise<void>((resolve) => term.write('', resolve));
      const current = screen();
      if (hit(current)) return settle();
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${String(match)}. Screen:\n${current}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  return {
    screen,
    press: (...keys) => {
      for (const k of keys) proc.write(k);
    },
    type: (text) => proc.write(text),
    waitFor,
    exited,
    kill: () => {
      if (alive) proc.kill();
    },
  };
}
