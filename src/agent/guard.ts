import fs from 'node:fs';
import path from 'node:path';
import type { CanUseTool, HookCallback } from '@anthropic-ai/claude-agent-sdk';

// The Claude agent reads untrusted PR content, so its tools are held to the PR worktree:
// Read, Grep, and Glob may only touch paths inside `root` (after resolving symlinks), and Bash
// may only run a few read-only git and gh commands whose arguments cannot reach a shell, read
// files outside the worktree, or write files. gh is pinned to the worktree's own repository.
//
// The same check runs twice: as a PreToolUse hook, which sees every tool call, and as
// canUseTool, which the SDK only consults when it would otherwise prompt.

const GH_SUBCOMMANDS: Record<string, Set<string>> = { pr: new Set(['view', 'list', 'diff']) };
// Diff and textconv drivers named by the PR's .gitattributes resolve to commands in the user's
// git config, so every permitted git command turns them off.
const GIT_NO_DRIVERS: Record<string, string[]> = {
  log: ['--no-ext-diff', '--no-textconv'],
  show: ['--no-ext-diff', '--no-textconv'],
  diff: ['--no-ext-diff', '--no-textconv'],
  grep: ['--no-textconv'],
  blame: ['--no-textconv'],
};
const GIT_SUBCOMMANDS = new Set(Object.keys(GIT_NO_DRIVERS));

// Git accepts unambiguous abbreviations of long options (`--outp` means `--output`), so a
// long option is refused when it is a prefix of, or starts with, one of these.
const GIT_DENIED_LONG = [
  '--output',
  '--open-files-in-pager',
  '--ext-diff',
  '--textconv',
  '--no-index',
  '--contents',
  '--file',
  '--exec-path',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config',
  '--ignore-revs-file',
];
// Exact options that happen to be prefixes of denied ones.
const GIT_SAFE_EXACT = new Set(['--text', '--ignore-rev']);
// --repo would point gh at any repository the user's token can read.
const GH_DENIED_LONG = ['--web', '--repo'];

class UnsafeCommandError extends Error {}

// Splits a command the way bash would for the subset it allows; anything that could expand,
// redirect, chain, or substitute is refused rather than interpreted.
export function tokenize(command: string): string[] {
  if (/[\x00-\x1f\x7f]/.test(command)) throw new UnsafeCommandError('control characters are not allowed');
  if (/[$`\\]/.test(command)) throw new UnsafeCommandError('shell expansion is not allowed');
  const out: string[] = [];
  let current = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === ' ') {
      if (inWord) out.push(current);
      current = '';
      inWord = false;
    } else if (ch === '~' && (!inWord || /[=:]$/.test(current))) {
      // Bash expands a tilde at the start of a word (or after = or :), not in HEAD~2.
      throw new UnsafeCommandError('unquoted ~ is not allowed');
    } else if (';&|<>(){}*?[]#!'.includes(ch)) {
      throw new UnsafeCommandError(`unquoted ${ch} is not allowed`);
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (quote) throw new UnsafeCommandError('unterminated quote');
  if (inWord) out.push(current);
  return out;
}

function deniedLong(arg: string, denied: string[]): boolean {
  const name = arg.split('=')[0];
  return denied.some((d) => d.startsWith(name) || name.startsWith(d));
}

// `git diff a b` silently becomes `--no-index` when a path is outside the work tree.
function outsidePath(arg: string): boolean {
  return path.isAbsolute(arg) || arg.startsWith('~') || arg.split('/').includes('..');
}

function checkGit(args: string[]): void {
  const sub = args[0];
  if (!GIT_SUBCOMMANDS.has(sub)) throw new UnsafeCommandError(`git ${sub ?? ''} is not allowed`);
  let options = true;
  for (const arg of args.slice(1)) {
    if (!options || arg === '--' || !arg.startsWith('-') || arg === '-') {
      if (arg === '--') options = false;
      else if (outsidePath(arg)) throw new UnsafeCommandError(`${arg} is outside the repository`);
      continue;
    }
    if (arg.startsWith('--')) {
      if (!GIT_SAFE_EXACT.has(arg.split('=')[0]) && deniedLong(arg, GIT_DENIED_LONG)) throw new UnsafeCommandError(`${arg} is not allowed`);
      // An attached value (`--relative=/abs`) is checked like a separate argument.
      const eq = arg.indexOf('=');
      if (eq >= 0 && outsidePath(arg.slice(eq + 1))) throw new UnsafeCommandError(`${arg} is outside the repository`);
    } else if (arg.startsWith('-') && arg.length > 1) {
      // Short options can be bundled (`-nOcmd`); -O runs a pager or reads an order file,
      // grep's -f reads patterns from any file, and blame's -S reads a revs file.
      const flags = arg.slice(1);
      if (flags.includes('O') || (sub === 'grep' && flags.includes('f')) || (sub === 'blame' && flags.includes('S'))) throw new UnsafeCommandError(`${arg} is not allowed`);
    }
  }
}

// A PR URL as the argument, or a repo:/org:/user: qualifier in a --search query, would reach
// another repository.
function otherRepoRef(arg: string): boolean {
  return /:\/\/|github\.|\/[^\s]*#|\b(?:repo|org|user|owner):/i.test(arg);
}

function checkGh(args: string[]): void {
  const [group, sub] = args;
  if (!GH_SUBCOMMANDS[group]?.has(sub)) throw new UnsafeCommandError(`gh ${group ?? ''} ${sub ?? ''} is not allowed`);
  let options = true;
  for (const arg of args.slice(2)) {
    if (otherRepoRef(arg)) throw new UnsafeCommandError(`${arg} may refer to another repository`);
    if (arg === '--') options = false;
    if (!options || !arg.startsWith('-') || arg === '-') continue;
    if (arg.startsWith('--')) {
      if (deniedLong(arg, GH_DENIED_LONG)) throw new UnsafeCommandError(`${arg} is not allowed`);
    } else if (arg.length > 1) {
      // pflag bundles boolean shorthands (`-cw` includes --web) and takes `-Rx` or `-R=x` as
      // -R's value, so the flags before any `=` must not include w or R.
      const flags = arg.slice(1).split('=')[0];
      if (flags.includes('w') || flags.includes('R')) throw new UnsafeCommandError(`${arg} is not allowed`);
    }
  }
}

export function checkBashCommand(command: string): void {
  const argv = tokenize(command.trim());
  if (argv[0] === 'git') return checkGit(argv.slice(1));
  if (argv[0] === 'gh') return checkGh(argv.slice(1));
  throw new UnsafeCommandError(`${argv[0] ?? 'empty command'} is not allowed`);
}

function shellQuote(arg: string): string {
  if (!arg.includes("'")) return `'${arg}'`;
  // tokenize() already refused $, `, and \, so nothing inside double quotes can expand.
  if (!arg.includes('"')) return `"${arg}"`;
  throw new UnsafeCommandError('an argument may not contain both quote characters');
}

// Checks a command and returns it with diff and textconv drivers turned off. The result is
// rebuilt from the checked arguments, so it runs exactly what was checked.
export function hardenBashCommand(command: string): string {
  checkBashCommand(command);
  const argv = tokenize(command.trim());
  if (argv[0] === 'git') argv.splice(2, 0, ...(GIT_NO_DRIVERS[argv[1]] ?? []));
  return argv.map(shellQuote).join(' ');
}

// Resolves symlinks through the deepest existing ancestor, so a path that does not exist
// yet still cannot escape through a linked directory.
function realish(p: string): string {
  let current = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(root: string, target: string): boolean {
  const base = realish(path.resolve(root));
  const resolved = realish(path.resolve(base, target));
  return resolved === base || resolved.startsWith(base + path.sep);
}

function escapesByPattern(pattern: unknown): boolean {
  return typeof pattern === 'string' && (path.isAbsolute(pattern) || pattern.startsWith('~') || pattern.split(/[\\/]/).includes('..'));
}

type ToolDecision = { allow: true; input: Record<string, unknown> } | { allow: false; message: string };

function checkToolUse(root: string, toolName: string, input: Record<string, unknown>): ToolDecision {
  const deny = (message: string): ToolDecision => ({ allow: false, message });
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
    const target = toolName === 'Read' ? input.file_path : input.path;
    if (toolName === 'Read' && typeof target !== 'string') return deny('Read needs a file_path.');
    if (target !== undefined && (typeof target !== 'string' || !isInside(root, target))) return deny('Guided Review only reads files inside the PR worktree.');
    if (toolName === 'Glob' && escapesByPattern(input.pattern)) return deny('Glob patterns must stay inside the PR worktree.');
    if (toolName === 'Grep' && escapesByPattern(input.glob)) return deny('Grep globs must stay inside the PR worktree.');
    return { allow: true, input };
  }
  if (toolName === 'Bash' && typeof input.command === 'string') {
    try {
      const command = hardenBashCommand(input.command);
      return { allow: true, input: command === input.command ? input : { ...input, command } };
    } catch (e) {
      if (!(e instanceof UnsafeCommandError)) throw e;
      return deny(`Guided Review only allows read-only git log/blame/show/grep/diff and gh pr view/list/diff on this PR's repository: ${e.message}`);
    }
  }
  return deny('Guided Review only allows read-only tools (Read, Grep, Glob, git log/blame/show/grep/diff).');
}

export function readOnlyGuard(root: string): CanUseTool {
  return async (toolName, input) => {
    const decision = checkToolUse(root, toolName, input);
    return decision.allow ? { behavior: 'allow', updatedInput: decision.input } : { behavior: 'deny', message: decision.message };
  };
}

// The SDK's own structured-output tool carries the final answer and touches nothing.
const HOOK_PASSTHROUGH = new Set(['StructuredOutput']);

// Runs the guard on every tool call, including the ones the SDK auto-approves without
// consulting canUseTool (Read/Grep/Glob in cwd, read-only Bash such as `cat`).
export function readOnlyHook(root: string): HookCallback {
  return async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse' || HOOK_PASSTHROUGH.has(hookInput.tool_name)) return {};
    const raw = hookInput.tool_input;
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const decision = checkToolUse(root, hookInput.tool_name, input);
    if (!decision.allow) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.message } };
    }
    // A rewritten Bash command (drivers turned off) was fully checked, so it is allowed as rewritten.
    if (decision.input !== input) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: decision.input } };
    }
    return {};
  };
}
