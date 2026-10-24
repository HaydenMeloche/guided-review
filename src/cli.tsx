import meow from 'meow';
import fs from 'node:fs';
import path from 'node:path';
import type { AppOptions } from './tui/App.js';
import { currentBranchPR, currentRepo, parsePRArg } from './github/gh.js';
import { cleanupWorktrees, defaultBaseRef, localRepoRoot, mergeBaseOf, prDiff } from './git/worktree.js';
import { git } from './git/git.js';
import {
  agentRouting,
  loadChapterOrder,
  loadCodingAgent,
  loadGlyphSetting,
  loadThemeSetting,
  loadUserConfig,
  loadViewSetting,
  readUserConfigFile,
  saveThemeSetting,
  saveViewSetting,
  userConfigPath,
  UserConfigError,
  type GlyphSetting,
} from './config.js';
import { editRepoConfig, setup } from './setup.js';
import { installClaudeCommand, installCodexSkill, type SkillInstallResult } from './codexSkill.js';
import { planOpen, runOpen, targetArg } from './open.js';
import type { PRInfo } from './types.js';
import { KEEP_TOURS_PER_PR, TOUR_MAX_AGE_DAYS } from './store/retention.js';
import { AGENT_ROLES, configForRole, validateRouting } from './agent/types.js';
import { packageInfo, promptForUpdate, startUpdateCheck } from './updateCheck.js';
import { SCREEN_RENDER } from './tui/renderOptions.js';

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
const PKG = packageInfo();
// The package description headed by the name and version, "Guided Review 0.2.0: …". A description
// that already starts with the name gets the version inserted after it.
function describeGr(): string | undefined {
  const { version, description } = PKG;
  if (!version || !description) return description;
  const named = description.replace(/^Guided Review\b/, `Guided Review ${version}`);
  return named === description ? `Guided Review ${version}: ${description}` : named;
}
const usage = (args: string, what: string) => `    $ ${`${NAME}${args && ` ${args}`}`.padEnd(NAME.length + 26)}${what}`;

const cli = meow(
  `
  Usage
${[
  usage('', 'Pick from PRs awaiting your review'),
  usage('review <number|URL>', 'Start or resume a guided tour of a PR'),
  usage('feedback [number|URL]', 'Work through the review feedback on your PR (default: this branch)'),
  usage('preview', 'Tour your current branch before opening the PR'),
  usage('open [number|URL]', 'Open the tour of a PR (default: this branch) in a new terminal window'),
  usage('open --preview', 'Open the preview of your current branch in a new terminal window'),
  usage('build [number|URL]', 'Build a tour without the TUI (for CI); share it with --comment or --out'),
  usage('cleanup [--days n]', 'Remove local PR worktrees (skip worktrees with changes) and old tours'),
  usage('config', 'Choose a model provider (or none), models, API key, and GitHub access'),
  usage('config --edit', 'Open ~/.guided-review/config.json in your editor'),
  usage('config --repo', "Edit this repo's .guided-review.json (file kinds, test globs, checklists)"),
  usage('install-claude-command', 'Add /guided-review to Claude Code'),
  usage('install-codex-skill', 'Add Guided Review as a Codex skill'),
].join('\n')}

  Options
    --no-agent       Plain mode: kind sorting and test pairing, no model calls
    --fresh          Rebuild the tour even if one is cached or shared on the PR for this head
    --preview        With open: open \`${NAME} preview\` instead of a PR's tour
    --force          With install-*: replace an existing file that has different content
    --comment        With build: post the tour to the PR, where \`${NAME} review\` picks it up
    --out <file>     With build: write the tour JSON to a file (- for stdout)
    --days <n>       With cleanup: delete tours not opened in n days (default ${TOUR_MAX_AGE_DAYS})

  Also installed as \`${NAME === 'gr' ? 'guided-review' : 'gr'}\`. Use \`guided-review\` if \`gr\` is a shell alias (Oh My Zsh: git remote).
  Set GR_DEBUG=1 to print stack traces on errors.
  Set GR_NO_UPDATE_CHECK=1 to stop checking npm for a newer version.

  Keys inside a tour: n/p hunk · ]/[ chapter · c comment · ? ask · t tests · d diagram · s submit · M merge · h help
  Keys in feedback:   n/p thread · y reply · space triage · Z resolve · o prompt for agent · s send · M merge
`,
  {
    importMeta: import.meta,
    description: describeGr(),
    flags: {
      agent: { type: 'boolean', default: true },
      fresh: { type: 'boolean', default: false },
      repo: { type: 'boolean', default: false },
      edit: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      preview: { type: 'boolean', default: false },
      comment: { type: 'boolean', default: false },
      out: { type: 'string' },
      days: { type: 'number' },
    },
  },
);

// Runs in the background while the command works. Never for build: it runs in CI.
const updateCheck = cli.input[0] === 'build' ? undefined : startUpdateCheck({ installed: PKG.version });

async function printUpdateNotice(graceMs = 0): Promise<void> {
  const notice = await updateCheck?.finish(graceMs);
  if (notice) process.stderr.write(`${notice}\n`);
}

function fail(msg: string, error?: unknown): never {
  process.stderr.write(`${NAME}: ${msg}\n`);
  if (process.env.GR_DEBUG === '1' && error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exit(1);
}

// What to do about an unusable config: with a model, the problem stops gr choosing one.
const CHOOSE_PROVIDER_HINT = 'Run `gr config` to choose a model provider (or no model), or pass --no-agent to review without one.';
const EDIT_CONFIG_HINT = 'Run `gr config --edit` to fix it.';

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

// The model routing for a tour, or undefined with --no-agent or when the config chooses no model.
// Exits with a hint when the config is unusable. Reads config.json unless given what it holds.
function loadAgent(noAgent: boolean, config?: Record<string, unknown> | null): AppOptions['agent'] {
  if (noAgent) return undefined;
  let agent: AppOptions['agent'];
  try {
    agent = agentRouting(loadUserConfig(config));
  } catch (error) {
    if (!(error instanceof UserConfigError)) throw error;
    fail(`${error.message}.\n\n  ${CHOOSE_PROVIDER_HINT}`);
  }
  if (!agent) return undefined;
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

// A config with no model works like --no-agent.
function agentOptions(config?: Record<string, unknown> | null): { agent: AppOptions['agent']; noAgent: boolean } {
  const agent = loadAgent(!cli.flags.agent, config);
  return { agent, noAgent: !agent };
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
    reportInstall(installClaudeCommand({ force: cli.flags.force }), 'The /guided-review command', 'Run /guided-review in Claude Code to preview your local changes.');
    return;
  }
  if (cmd === 'open' && cli.flags.preview) {
    if (arg) fail(`--preview tours your local changes and takes no PR. Usage: ${NAME} open --preview`);
    const root = (await localRepoRoot(cwd)) ?? fail(`${NAME} open --preview must run inside a git repository.`);
    const plan = planOpen({ target: 'preview', cwd: root });
    runOpen(plan);
    if (plan.kind === 'print') {
      process.stdout.write(`Could not open a new terminal window here. Run this in another terminal, from ${root}:\n  ${plan.commandLine}\n`);
    } else {
      process.stdout.write(`Opened a preview of ${root} in a new ${plan.kind === 'tmux' ? 'tmux' : 'Terminal'} window.\n`);
    }
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
    // A tour without a model is what every reader's gr builds for itself, so there is nothing to share.
    const { agent } = agentOptions();
    if (!agent)
      fail(
        `${NAME} build shares a tour written by a model, and ${cli.flags.agent ? 'your config chooses no model' : '--no-agent turns the model off'}. Without one, \`${NAME} review\` builds the same tour for each reviewer.`,
      );
    const out = cli.flags.out ?? (cli.flags.comment ? undefined : '-');
    const { buildTour } = await import('./build.js');
    await buildTour({
      target,
      agent,
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
  if (cmd && cmd !== 'review' && cmd !== 'feedback' && cmd !== 'preview' && !prArg.test(cmd)) cli.showHelp(1);

  // Everything below starts the full-screen tour. Check for a terminal before
  // spending any gh or network calls on it.
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail(`${NAME} is an interactive terminal app; run it in a terminal.`);
  // How the terminal shows color, read once before any screen: its background (so the default
  // palette's tints suit a light terminal), its color depth, and NO_COLOR.
  const noColor = !!process.env.NO_COLOR;
  {
    const [{ detectBackground }, theme] = await Promise.all([import('./tui/terminalBackground.js'), import('./tui/theme.js')]);
    theme.setColorDepth(theme.detectColorDepth());
    theme.setTerminalBackground(await detectBackground(), noColor);
  }
  const offer = updateCheck?.offer();
  if (offer) {
    const code = await promptForUpdate(offer);
    if (code !== undefined) process.exit(code);
  }
  // First run: introduce gr and set it up, then carry on with the command that was run.
  if (cli.flags.agent && !fs.existsSync(userConfigPath())) {
    const result = await setup({ firstRun: true });
    if (result.kind === 'cancelled') fail(`no config saved. Run \`${NAME} config\` when you're ready, or pass --no-agent to review without a model.`);
  }
  // Load the TUI while the PR is being resolved below.
  const tui = Promise.all([import('ink'), import('./tui/App.js')]);
  tui.catch(() => undefined); // awaited below; a failure surfaces there
  const localRepoP = localRepoRoot(cwd);
  const takesArg = cmd === 'review' || cmd === 'feedback';
  const needsRepo = takesArg ? !!arg : !!cmd && cmd !== 'preview';
  const cwdRepoP = needsRepo && /^#?\d+$/.test((takesArg ? arg : cmd).trim()) ? currentRepo(cwd) : Promise.resolve(undefined);

  // config.json, read once for the model and every setting below. A file that can't be read gets
  // the hint the first loader to need it would give.
  let config: Record<string, unknown> | null;
  try {
    config = readUserConfigFile();
  } catch (error) {
    if (!(error instanceof UserConfigError)) throw error;
    fail(`${error.message}.\n\n  ${cli.flags.agent ? CHOOSE_PROVIDER_HINT : EDIT_CONFIG_HINT}`);
  }
  const { agent, noAgent } = agentOptions(config);
  let chapterOrder: AppOptions['chapterOrder'];
  let hideWhitespace: boolean;
  let splitDiff: boolean;
  let themeName: string | undefined;
  let glyphs: GlyphSetting;
  let codingAgent: AppOptions['codingAgent'];
  try {
    chapterOrder = loadChapterOrder(config);
    hideWhitespace = loadViewSetting('hideWhitespace', config);
    splitDiff = loadViewSetting('splitDiff', config);
    themeName = loadThemeSetting(config);
    glyphs = loadGlyphSetting(config);
    codingAgent = loadCodingAgent(config);
  } catch (error) {
    if (!(error instanceof UserConfigError)) throw error;
    fail(`${error.message}.\n\n  ${EDIT_CONFIG_HINT}`);
  }
  // Loaded while the PR is resolved below. Only a name shiki doesn't have is the config's fault;
  // any other failure is reported as it is.
  // NO_COLOR wins over a theme: the screens show no colors at all.
  const name = noColor ? undefined : themeName;
  const paletteP = name
    ? import('./tui/theme.js').then(async ({ isTheme, loadPalette }) => {
        if (!(await isTheme(name))) fail(`unknown theme ${JSON.stringify(name)} in your config.\n\n  Run \`gr config\` to pick one.`);
        return loadPalette(name);
      })
    : Promise.resolve(undefined);
  paletteP.catch(() => undefined); // awaited below; a failure surfaces there
  const base: AppOptions = {
    agent,
    chapterOrder,
    hideWhitespace,
    splitDiff,
    saveViewSetting,
    saveTheme: config ? saveThemeSetting : undefined,
    codingAgent,
    noAgent,
    fresh: cli.flags.fresh,
    localRepo: await localRepoP,
  };

  let opts: AppOptions = base;
  if (cmd === 'review') {
    const target = arg ? parsePRArg(arg, await cwdRepoP) : await currentBranchPR(cwd);
    if (!target) fail('no PR given and the current branch has no open PR. Usage: gr review <number|URL>');
    opts = { ...base, target };
  } else if (cmd === 'feedback') {
    const target = arg ? parsePRArg(arg, await cwdRepoP) : await currentBranchPR(cwd);
    if (!target) fail(`no PR given and the current branch has no open PR. Usage: ${NAME} feedback <number|URL>`);
    opts = { ...base, target, mode: 'author' };
  } else if (cmd === 'preview') {
    opts = { ...base, preview: await previewInfo(cwd) };
  } else if (cmd) {
    opts = { ...base, target: parsePRArg(cmd, await cwdRepoP) };
  }

  const [{ render }, { App }] = await tui;
  (await import('./tui/glyphs.js')).setGlyphs(glyphs);
  opts = { ...opts, palette: await paletteP };
  const app = render(<App {...opts} />, { ...SCREEN_RENDER, exitOnCtrlC: true });
  await app.waitUntilExit();
  // Backstop: stray timers, sockets, or child processes must not keep gr alive
  // after the tour has closed.
  process.exit(0);
}

// Only the short commands get here: build and the tour exit from main (the tour
// offers updates before it starts). Give a check still in flight a moment so
// quick commands can refresh the cache too.
main()
  .then(() => printUpdateNotice(300))
  .catch((e) => fail(e instanceof Error ? e.message : String(e), e));
