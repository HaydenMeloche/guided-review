import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// `gr doctor`: everything gr leans on outside itself, checked in one go, each with what to do
// when it is missing. A missing ripgrep otherwise only shows up as quietly worse completions.

export type Status = 'ok' | 'warn' | 'fail';

export interface Finding {
  name: string;
  status: Status; // fail: gr can't do its main job without it; warn: a feature is worse or off
  detail: string;
  fix?: string;
}

// `missing`: the command isn't installed.
export type Run = (cmd: string, args: string[]) => Promise<{ ok: boolean; out: string; missing?: boolean }>;

export interface DoctorDeps {
  run: Run;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  nodeVersion: string;
  home: string; // GR_HOME
  grammars: () => Promise<{ loaded: string[]; all: string[] }>;
  colorDepth: () => string;
  // The model check: undefined when no model is configured (or --no-agent), else one row per model.
  models: () => Promise<{ model: string; ok: boolean; ms: number; error?: string }[] | undefined>;
  githubToken: () => string | undefined; // where a configured token comes from, e.g. "$GITHUB_TOKEN"; throws when it can't be read
  viewer: () => Promise<string>; // who the token signs in as
  configProblem: () => string | undefined; // why config.json can't be used, or undefined when it can (or is absent)
  noModel: string; // what the model row says when there is none to check
}

const PROBE_MS = 5000;

export const runCommand: Run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: PROBE_MS }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: `${stdout}${stderr}`.trim(), missing: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' }),
    );
  });

const MIN_NODE = [22, 13];

// The first dotted version in a command's output: "git version 2.47.1" → "2.47.1".
const versionIn = (out: string) => out.match(/\d+\.\d+(?:\.\d+)?/)?.[0];

// Whether `name` is an executable file on PATH.
export function onPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (path.isAbsolute(name)) return fs.existsSync(name);
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean))
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, name + ext), fs.constants.X_OK);
        return true;
      } catch {
        // not here
      }
    }
  return false;
}

const install = (platform: NodeJS.Platform, brew: string, other: string) => (platform === 'darwin' ? `brew install ${brew}` : other);

function nodeCheck(d: DoctorDeps): Finding {
  const [major, minor] = d.nodeVersion.split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return ok
    ? { name: 'node', status: 'ok', detail: d.nodeVersion }
    : { name: 'node', status: 'fail', detail: `${d.nodeVersion}, older than ${MIN_NODE.join('.')}`, fix: 'install Node 22.13 or newer' };
}

async function gitCheck(d: DoctorDeps): Promise<Finding> {
  const r = await d.run('git', ['--version']);
  if (r.missing) return { name: 'git', status: 'fail', detail: 'not found', fix: install(d.platform, 'git', 'install git from https://git-scm.com') };
  return { name: 'git', status: 'ok', detail: versionIn(r.out) ?? r.out };
}

async function ghCheck(d: DoctorDeps): Promise<Finding> {
  let token: string | undefined;
  try {
    token = d.githubToken();
  } catch (e) {
    return { name: 'GitHub', status: 'fail', detail: (e as Error).message };
  }
  if (token) {
    const login = await d.viewer().catch((e: Error) => e);
    if (login instanceof Error) return { name: 'GitHub', status: 'fail', detail: `the token from ${token} was refused: ${login.message}`, fix: 'gr config' };
    return { name: 'GitHub', status: 'ok', detail: `token from ${token} · signed in as ${login}` };
  }
  const version = await d.run('gh', ['--version']);
  if (version.missing)
    return { name: 'gh', status: 'fail', detail: 'not found: reviews need it, gr preview and gr tutor don’t', fix: 'install it from https://cli.github.com, or set a token with gr config' };
  const v = versionIn(version.out) ?? '';
  const user = await d.run('gh', ['api', 'user', '--jq', '.login']);
  if (!user.ok || !/^[\w-]+$/.test(user.out)) return { name: 'gh', status: 'fail', detail: `${v} · not signed in, or GitHub could not be reached`, fix: 'gh auth login' };
  return { name: 'gh', status: 'ok', detail: `${v} · signed in as ${user.out}` };
}

async function rgCheck(d: DoctorDeps): Promise<Finding> {
  const r = await d.run('rg', ['--version']);
  if (r.missing)
    return {
      name: 'rg',
      status: 'warn',
      detail: 'not found: code references in comments and the model’s search tool need it',
      fix: install(d.platform, 'ripgrep', 'install ripgrep: https://github.com/BurntSushi/ripgrep#installation'),
    };
  return { name: 'rg', status: 'ok', detail: versionIn(r.out) ?? r.out };
}

async function treeSitterCheck(d: DoctorDeps): Promise<Finding> {
  const { loaded, all } = await d.grammars();
  if (loaded.length === all.length) return { name: 'tree-sitter', status: 'ok', detail: `${all.length} grammars` };
  const missing = all.filter((l) => !loaded.includes(l));
  return {
    name: 'tree-sitter',
    status: 'warn',
    detail: `${loaded.length} of ${all.length} grammars load; ${missing.join(', ')} fall back to simpler parsing`,
    fix: 'reinstall gr (npm install -g @haydenmeloche/guided-review)',
  };
}

function colorCheck(d: DoctorDeps): Finding {
  const depth = d.colorDepth();
  if (d.env.NO_COLOR) return { name: 'colors', status: 'ok', detail: 'off (NO_COLOR is set)' };
  if (depth === 'truecolor') return { name: 'colors', status: 'ok', detail: 'truecolor' };
  return {
    name: 'colors',
    status: 'warn',
    detail: `${depth} colors: themes and diff backgrounds are approximated`,
    fix: 'set COLORTERM=truecolor if your terminal supports it',
  };
}

function clipboardCheck(d: DoctorDeps): Finding {
  const tools: Record<string, string[]> = { darwin: ['pbcopy'], win32: ['clip'], linux: ['wl-copy', 'xclip'] };
  const found = (tools[d.platform] ?? []).find((t) => onPath(t, d.env, d.platform));
  if (found) return { name: 'clipboard', status: 'ok', detail: found };
  return {
    name: 'clipboard',
    status: 'warn',
    detail: 'no clipboard tool: copies go through your terminal (OSC 52), which may ignore them',
    fix: d.platform === 'linux' ? 'install wl-clipboard or xclip' : undefined,
  };
}

function openCheck(d: DoctorDeps): Finding {
  if (d.env.TMUX) return { name: 'gr open', status: 'ok', detail: 'opens a new tmux window' };
  if (d.platform === 'darwin') return { name: 'gr open', status: 'ok', detail: 'opens a new Terminal window' };
  return { name: 'gr open', status: 'warn', detail: 'outside tmux it prints the command to run instead of opening a window', fix: 'run gr inside tmux' };
}

function editorCheck(d: DoctorDeps): Finding {
  const editor = d.env.VISUAL || d.env.EDITOR;
  if (!editor) return { name: 'editor', status: 'warn', detail: 'neither $VISUAL nor $EDITOR is set, so E and ctrl+o open vi', fix: 'set $EDITOR' };
  const command = editor
    .trim()
    .split(/\s+/)[0]
    .replace(/^["']|["']$/g, '');
  if (!onPath(command, d.env, d.platform)) return { name: 'editor', status: 'warn', detail: `${editor} is not on your PATH`, fix: 'set $EDITOR to an editor you have' };
  return { name: 'editor', status: 'ok', detail: editor };
}

async function modelCheck(d: DoctorDeps): Promise<Finding[]> {
  const problem = d.configProblem();
  if (problem) return [{ name: 'config', status: 'fail', detail: problem, fix: 'gr config' }];
  const results = await d.models();
  if (!results) return [{ name: 'model', status: 'ok', detail: d.noModel }];
  return results.map((r) =>
    r.ok
      ? { name: 'model', status: 'ok', detail: `${r.model} answered in ${(r.ms / 1000).toFixed(1)}s` }
      : { name: 'model', status: 'fail', detail: `${r.model}: ${r.error ?? 'no answer'}`, fix: 'gr config' },
  );
}

function size(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += size(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch {
      // gone, or not ours to read
    }
  }
  return total;
}

const subdirs = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()) : []);

function homeCheck(d: DoctorDeps): Finding {
  if (!fs.existsSync(d.home)) return { name: 'data', status: 'ok', detail: `${d.home} (empty)` };
  const mb = Math.round(size(d.home) / 1e6);
  const worktrees = subdirs(path.join(d.home, 'worktrees')).reduce((n, repo) => n + subdirs(path.join(d.home, 'worktrees', repo.name)).length, 0);
  return { name: 'data', status: 'ok', detail: `${d.home}: ${mb} MB · ${worktrees} PR worktree${worktrees === 1 ? '' : 's'}`, fix: mb > 1000 ? 'gr cleanup frees space' : undefined };
}

// Every check, in the order printed. They run at once; the model check is the slow one.
export async function diagnose(d: DoctorDeps): Promise<Finding[]> {
  const [git, gh, rg, ts, model] = await Promise.all([gitCheck(d), ghCheck(d), rgCheck(d), treeSitterCheck(d), modelCheck(d)]);
  return [nodeCheck(d), git, gh, rg, ts, colorCheck(d), clipboardCheck(d), openCheck(d), editorCheck(d), ...model, homeCheck(d)];
}

// One line per finding: its mark, name, what was found, and the fix after a dot.
export function formatFindings(findings: Finding[], color: boolean): string {
  const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const mark = { ok: paint(32, '✓'), warn: paint(33, '!'), fail: paint(31, '✗') };
  const width = Math.max(...findings.map((f) => f.name.length));
  const lines = findings.map((f) => ` ${mark[f.status]} ${f.name.padEnd(width)}  ${f.detail}${f.fix ? paint(2, ` · ${f.fix}`) : ''}`);
  const fails = findings.filter((f) => f.status === 'fail').length;
  const warns = findings.filter((f) => f.status === 'warn').length;
  const summary = fails ? `${fails} problem${fails === 1 ? '' : 's'} to fix` : warns ? `Ready; ${warns} thing${warns === 1 ? '' : 's'} could be better` : 'Everything gr needs is here.';
  return `${lines.join('\n')}\n\n${summary}\n`;
}
