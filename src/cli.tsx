import meow from 'meow';
import path from 'node:path';
import type { AppOptions } from './tui/App.js';
import { currentBranchPR, currentRepo, parsePRArg } from './github/gh.js';
import { cleanupWorktrees, defaultBaseRef, localRepoRoot, mergeBaseOf, prDiff } from './git/worktree.js';
import { git } from './git/git.js';
import { loadChapterOrder, loadHideWhitespace, loadUserConfig, saveHideWhitespace, UserConfigError } from './config.js';
import { editRepoConfig, setup } from './setup.js';
import { installClaudeCommand, installCodexSkill, type SkillInstallResult } from './codexSkill.js';
import { planOpen, runOpen, targetArg } from './open.js';
import type { PRInfo } from './types.js';
import { KEEP_TOURS_PER_PR, TOUR_MAX_AGE_DAYS } from './store/retention.js';
import { AGENT_ROLES, configForRole, validateRouting } from './agent/types.js';

// node:sqlite prints an ExperimentalWarning on load; drop just that one so it
// does not land on top of the TUI. The store, and the TUI that imports it, are
// loaded with import() below, after this filter is in place.
const originalEmit = process.emitWarning.bind(process) as (...a: unknown[]) => void;
process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
  const msg = typeof warning === 'string' ? warning : warning.message;
  const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  const name = typeof warning === 'string' ? type : warning.name;
  if ((name === 'ExperimentalWarning' || type === 'ExperimentalWarning') && /sqlite/i.test(msg)) return;
  return originalEmit(warning, ...rest);
};

// Installed as both `gr` and `guided-review` (Oh My Zsh aliases gr to git remote),
// so help and errors use whichever name the user typed.
const NAME = path.basename(process.argv[1] ?? '').replace(/\.js$/, '') === 'guided-review' ? 'guided-review' : 'gr';
const usage = (args: string, what: string) => `    $ ${`${NAME}${args && ` ${args}`}`.padEnd(NAME.length + 26)}${what}`;

const cli = meow(
  `
  Usage
${[
  usage('', 'Pick from PRs awaiting your review'),
  usage('review <number|URL>', 'Start or resume a guided tour of a PR'),
  usage('preview', 'Author mode: tour your current branch before opening the PR'),
  usage('open [number|URL]', 'Open the tour of a PR (default: this branch) in a new terminal window'),
  usage('build [number|URL]', 'Build a tour without the TUI (for CI); share it with --comment or --out'),
  usage('cleanup [--days n]', 'Remove local PR worktrees (skip worktrees with changes) and old tours'),
  usage('config', 'Choose a model provider, models, API key, and GitHub access'),
  usage('config --edit', 'Open ~/.guided-review/config.json in your editor'),
  usage('config --repo', "Edit this repo's .guided-review.json (file kinds, test globs, checklists)"),
  usage('install-claude-command', 'Add /guided-review to Claude Code'),
  usage('install-codex-skill', 'Add Guided Review as a Codex skill'),
].join('\n')}

  Options
    --no-agent       Plain mode: kind sorting and test pairing, no model calls
    --fresh          Rebuild the tour even if one is cached or shared on the PR for this head
    --force          With install-*: replace an existing file that has different content
    --comment        With build: post the tour to the PR, where \`${NAME} review\` picks it up
    --out <file>     With build: write the tour JSON to a file (- for stdout)
    --days <n>       With cleanup: delete tours not opened in n days (default ${TOUR_MAX_AGE_DAYS})

  Also installed as \`${NAME === 'gr' ? 'guided-review' : 'gr'}\`. Use \`guided-review\` if \`gr\` is a shell alias (Oh My Zsh: git remote).
  Set GR_DEBUG=1 to print stack traces on errors.

  Keys inside a tour: n/p hunk · ]/[ chapter · c comment · ? ask · t tests · d diagram · s submit · h help
`,
  {
    importMeta: import.meta,
    flags: {
      agent: { type: 'boolean', default: true },
      fresh: { type: 'boolean', default: false },
      repo: { type: 'boolean', default: false },
      edit: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      comment: { type: 'boolean', default: false },
      out: { type: 'string' },
      days: { type: 'number' },
    },
  },
);

function fail(msg: string, error?: unknown): never {
  process.stderr.write(`${NAME}: ${msg}\n`);
  if (process.env.GR_DEBUG === '1' && error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exit(1);
}

function reportInstall(result: SkillInstallResult, what: string, installed: string): void {
  if (result.status === 'already-installed') process.stdout.write(`${what} is already installed at ${result.path}.\n`);
  else process.stdout.write(`${result.status === 'replaced' ? 'Replaced' : 'Installed'} ${result.path}. ${installed}\n`);
}

async function previewInfo(cwd: string): Promise<{ pr: PRInfo; diff: string; worktree: string }> {
  const root = await localRepoRoot(cwd);
  if (!root) fail(`${NAME} preview must run inside a git repository.`);
  const trim = (s: string) => s.trim();
  // Independent lookups run together; only the merge base waits for the default branch.
  // Preview works without gh: an unknown repo becomes local/<dir> below.
  const repoP = currentRepo(root).catch(() => undefined);
  const headP = git(root, ['rev-parse', 'HEAD']).then(trim);
  const branchP = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).then(trim);
  const base = (await defaultBaseRef(root, () => repoP)) ?? fail(`could not find the default branch to compare against (no origin/HEAD, no answer from origin, and no main or master).`);
  const baseSha = (await mergeBaseOf(root, 'HEAD', base.ref)) ?? fail(`could not find the merge base with ${base.ref.replace(/^refs\/(remotes\/|heads\/)/, '')}.`);
  // Diffs against the working tree, so it includes uncommitted work: the author is still shaping the branch.
  const [headSha, branch, log, diff, currentRepoName] = await Promise.all([headP, branchP, git(root, ['log', '--format=%H%x00%B%x1e', `${baseSha}..HEAD`]).then(trim), prDiff(root, baseSha), repoP]);
  const commits = log
    .split('\x1e')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [sha, message] = c.split('\0');
      return { sha, message: message ?? '' };
    });
  const repo = currentRepoName ?? `local/${path.basename(root)}`;
  return {
    worktree: root,
    diff,
    pr: {
      repo,
      number: 0,
      title: `${branch} (preview)`,
      body: commits.map((c) => c.message).join('\n\n'),
      url: '',
      author: 'you',
      baseRef: base.name,
      headRef: branch,
      baseSha,
      headSha,
      commits,
      linkedIssues: [],
    },
  };
}

// The model routing for a tour, or undefined with --no-agent. Exits with a hint when the config is unusable.
function loadAgent(noAgent: boolean): AppOptions['agent'] {
  if (noAgent) return undefined;
  let agent: AppOptions['agent'];
  try {
    agent = loadUserConfig();
  } catch (error) {
    if (!(error instanceof UserConfigError)) throw error;
    fail(`${error.message}.\n\n  Run \`gr config\` to choose a model provider, or pass --no-agent to review without one.`);
  }
  try {
    validateRouting(agent);
  } catch (error) {
    fail(`${(error as Error).message}. Run \`gr config\` to fix it.`);
  }
  const claudeProvider = AGENT_ROLES.map((role) => configForRole(agent, role).provider).find((p) => p === 'bedrock' || p === 'vertex');
  if (claudeProvider === 'bedrock') process.env.CLAUDE_CODE_USE_BEDROCK ??= '1';
  if (claudeProvider === 'vertex') process.env.CLAUDE_CODE_USE_VERTEX ??= '1';
  return agent;
}

async function main() {
  const [cmd, arg] = cli.input;
  const cwd = process.cwd();
  // `setup` is the old name for `config`.
  if (cmd === 'config' || cmd === 'setup') {
    if (cli.flags.repo) {
      editRepoConfig((await localRepoRoot(cwd)) ?? fail('not inside a git repository.'));
      return;
    }
    await setup({ edit: cli.flags.edit });
    return;
  }
  if (cmd === 'cleanup') {
    const { days } = cli.flags;
    if (days !== undefined && !(Number.isFinite(days) && days > 0)) fail('--days must be a positive number of days.');
    const result = await cleanupWorktrees();
    process.stdout.write(`Removed ${result.removed.length} PR worktree(s).\n`);
    for (const item of result.skipped) process.stdout.write(`Skipped ${item.path}: ${item.reason}\n`);
    const { Store } = await import('./store/db.js');
    const store = new Store();
    try {
      const extra = store.pruneTours();
      const maxAge = days ?? TOUR_MAX_AGE_DAYS;
      const stale = store.pruneStale(maxAge);
      process.stdout.write(`Removed ${extra + stale.tours} old tour(s): the newest ${KEEP_TOURS_PER_PR} per PR are kept, minus any not opened in ${maxAge} days.\n`);
      if (stale.prs) process.stdout.write(`Cleared reading state for ${stale.prs} PR(s) with no tour left; unposted drafts are kept.\n`);
    } finally {
      store.close();
    }
    return;
  }
  if (cmd === 'install-codex-skill') {
    reportInstall(installCodexSkill({ force: cli.flags.force }), 'Guided Review skill', 'Restart Codex to discover the guided-review skill.');
    return;
  }
  if (cmd === 'install-claude-command') {
    reportInstall(installClaudeCommand({ force: cli.flags.force }), 'The /guided-review command', "Run /guided-review in Claude Code to open the current branch's PR.");
    return;
  }
  if (cmd === 'open') {
    // Resolve and validate the PR here, so the new window gets a canonical owner/name#N.
    const target = arg ? (/^#?\d+$/.test(arg.trim()) ? parsePRArg(arg, await currentRepo(cwd)) : parsePRArg(arg)) : await currentBranchPR(cwd);
    if (!target) fail(`no PR given and the current branch has no open PR. Usage: ${NAME} open <number|URL>`);
    const root = (await localRepoRoot(cwd)) ?? cwd;
    const plan = planOpen({ target, cwd: root });
    runOpen(plan);
    const pr = targetArg(target);
    if (plan.kind === 'print') {
      process.stdout.write(`Could not open a new terminal window here. Run this in another terminal, from ${root}:\n  ${plan.commandLine}\n`);
    } else {
      process.stdout.write(`Opened ${pr} in a new ${plan.kind === 'tmux' ? 'tmux' : 'Terminal'} window.\n`);
    }
    return;
  }

  if (cmd === 'build') {
    // Headless: runs in CI, so no terminal check.
    const target = arg ? (/^#?\d+$/.test(arg.trim()) ? parsePRArg(arg, await currentRepo(cwd)) : parsePRArg(arg)) : await currentBranchPR(cwd);
    if (!target) fail(`no PR given and the current branch has no open PR. Usage: ${NAME} build <number|URL>`);
    const out = cli.flags.out ?? (cli.flags.comment ? undefined : '-');
    const { buildTour } = await import('./build.js');
    await buildTour({
      target,
      agent: loadAgent(!cli.flags.agent),
      noAgent: !cli.flags.agent,
      fresh: cli.flags.fresh,
      localRepo: await localRepoRoot(cwd),
      out,
      comment: cli.flags.comment,
      command: `${NAME} review`,
      log: (line) => process.stderr.write(`${line}\n`),
    });
    process.exit(0);
  }

  const prArg = /^(#?\d+|https?:\/\/|[\w.-]+\/[\w.-]+#\d+)/;
  if (cmd && cmd !== 'review' && cmd !== 'preview' && !prArg.test(cmd)) cli.showHelp(1);

  // Everything below starts the full-screen tour. Check for a terminal before
  // spending any gh or network calls on it.
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail(`${NAME} is an interactive terminal app; run it in a terminal.`);
  // Load the TUI while the PR is being resolved below.
  const tui = Promise.all([import('ink'), import('./tui/App.js')]);
  tui.catch(() => undefined); // awaited below; a failure surfaces there
  const localRepoP = localRepoRoot(cwd);
  const needsRepo = cmd === 'review' ? !!arg : !!cmd && cmd !== 'preview';
  const cwdRepoP = needsRepo && /^#?\d+$/.test((cmd === 'review' ? arg : cmd).trim()) ? currentRepo(cwd) : Promise.resolve(undefined);

  const noAgent = !cli.flags.agent;
  const agent = loadAgent(noAgent);
  let chapterOrder: AppOptions['chapterOrder'];
  let hideWhitespace: boolean;
  try {
    chapterOrder = loadChapterOrder();
    hideWhitespace = loadHideWhitespace();
  } catch (error) {
    if (!(error instanceof UserConfigError)) throw error;
    fail(`${error.message}.\n\n  Run \`gr config --edit\` to fix it.`);
  }
  const base: AppOptions = {
    agent,
    chapterOrder,
    hideWhitespace,
    saveHideWhitespace,
    noAgent,
    fresh: cli.flags.fresh,
    localRepo: await localRepoP,
  };

  let opts: AppOptions = base;
  if (cmd === 'review') {
    const target = arg ? parsePRArg(arg, await cwdRepoP) : await currentBranchPR(cwd);
    if (!target) fail('no PR given and the current branch has no open PR. Usage: gr review <number|URL>');
    opts = { ...base, target };
  } else if (cmd === 'preview') {
    opts = { ...base, preview: await previewInfo(cwd) };
  } else if (cmd) {
    opts = { ...base, target: parsePRArg(cmd, await cwdRepoP) };
  }

  const [{ render }, { App }] = await tui;
  const app = render(<App {...opts} />, { alternateScreen: true, exitOnCtrlC: true });
  await app.waitUntilExit();
  // Backstop: stray timers, sockets, or child processes must not keep gr alive
  // after the tour has closed.
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e), e));
