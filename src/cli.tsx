import meow from 'meow';
import fs from 'node:fs';
import path from 'node:path';
import type { AppOptions } from './tui/App.js';
import { currentBranchPR, currentRepo, parsePRArg } from './github/gh.js';
import { localRepoRoot } from './git/worktree.js';
import { autoCleanup, cleanup } from './cleanup.js';
import { localPreview, parseDiffTarget } from './preview.js';
import {
  agentRouting,
  loadChapterOrder,
  loadGlyphSetting,
  loadIconSetting,
  loadTipsSeen,
  saveTipSeen,
  loadThemeSetting,
  loadUserConfig,
  loadViewSetting,
  loadCommentLabels,
  loadSyncViewed,
  readUserConfigFile,
  saveThemeSetting,
  saveViewSetting,
  userConfigPath,
  UserConfigError,
  type GlyphSetting,
  type IconSetting,
} from './config.js';
import { editRepoConfig, setup, setupClones } from './setup.js';
import { installClaudeCommand, installCodexSkill, refreshInstalled, type SkillInstallResult } from './codexSkill.js';
import { planOpen, runOpen, targetArg } from './open.js';
import { KEEP_TOURS_PER_PR, REPO_MAX_AGE_DAYS, TOUR_MAX_AGE_DAYS } from './store/retention.js';
import { AGENT_ROLES, configForRole, validateRouting } from './agent/types.js';
import { packagedRun, packageInfo, promptForUpdate, RELEASES_URL, startUpdateCheck, updateNow } from './updateCheck.js';
import { holdTerminalInput, SCREEN_RENDER } from './tui/renderOptions.js';

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
  usage('preview --base <ref>', 'Tour it against another branch, such as the one it stacks on'),
  usage('diff [rev | a..b]', 'Tour the working tree against a commit, or two commits (a...b: from their merge base)'),
  usage('tutor', 'Learn gr: lessons in a tour of a sample change, offline, no PR or model needed'),
  usage('open [number|URL]', 'Open the tour of a PR (default: this branch) in a new terminal window'),
  usage('open --preview', 'Open the preview of your current branch in a new terminal window'),
  usage('build [number|URL]', 'Build a tour without the TUI (for CI); share it with --comment or --out'),
  usage('doctor', 'Check what gr needs (git, gh, ripgrep, your model, …) and how to fix what is missing'),
  usage('cleanup [--days n]', 'Remove local PR worktrees (skip worktrees with changes), unused clones, and old tours'),
  usage('update', 'Install the newest version of gr'),
  usage('config', 'Choose a model provider (or none), models, API key, and GitHub access'),
  usage('config --edit', 'Open ~/.guided-review/config.json in your editor'),
  usage('config --repo', "Edit this repo's .guided-review.json (file kinds, test globs, checklists)"),
  usage('config --clones', 'Find your clones, so PRs are checked out from them instead of downloaded'),
  usage('install-claude-command', 'Add /guided-review to Claude Code'),
  usage('install-codex-skill', 'Add Guided Review as a Codex skill'),
  usage('completion <zsh|bash|fish>', 'Print a script that completes commands, flags, branches and PR numbers'),
].join('\n')}

  Options
    --no-agent       Review without a model: static analysis only
    --fresh          Rebuild the tour even if one is cached or shared on the PR for this head
    --preview        With open: open \`${NAME} preview\` instead of a PR's tour
    --base <ref>     With preview: compare with this branch or commit instead of the default branch
    --force          With install-*: replace an existing file that has different content
    --comment        With build: post the tour to the PR, where \`${NAME} review\` picks it up
    --out <file>     With build: write the tour JSON to a file (- for stdout)
    --days <n>       With cleanup: delete tours not opened in n days (default ${TOUR_MAX_AGE_DAYS})
    --no-agent       With doctor: skip the request to your model

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
      clones: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      preview: { type: 'boolean', default: false },
      base: { type: 'string' },
      comment: { type: 'boolean', default: false },
      out: { type: 'string' },
      days: { type: 'number' },
    },
  },
);

// Runs in the background while the command works. Never for build, which runs in CI, nor for
// completion, which the shell runs, nor for update, which asks npm itself.
const updateCheck = ['build', 'completion', '__complete', 'update'].includes(cli.input[0]) ? undefined : startUpdateCheck({ installed: PKG.version });
// gr update: asks npm now and installs a newer version with the update screen, whatever the daily check says.
async function update(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail(`${NAME} update shows its progress full screen; run it in a terminal.`);
  const found = await updateNow({ installed: PKG.version });
  if (found.kind === 'source') fail(`this ${NAME} runs from a source checkout (${path.dirname(path.dirname(process.argv[1] ?? ''))}). Update it with git pull and pnpm build.`);
  if (found.kind === 'offline') fail('could not reach npm to look for a newer version. Check your connection and try again.');
  if (found.kind === 'current') return void process.stdout.write(`Guided Review ${found.installed} is the newest version.\n`);
  if (found.kind === 'manual') {
    if (!found.latest) return void process.stdout.write(`Guided Review ${found.installed} is the newest version.\n`);
    return void process.stdout.write(
      `Guided Review ${found.latest} is out (you have ${found.installed}), but this ${NAME} isn't a global install ${NAME} can update.\nUpdate it the way you installed it, or install it globally: npm install -g @haydenmeloche/guided-review\nRelease notes: ${RELEASES_URL}\n`,
    );
  }
  await readTerminal(!!process.env.NO_COLOR);
  const code = await promptForUpdate(found.offer, undefined);
  if (code) process.exit(code);
}

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

// How the terminal shows color, read once before any screen: its background (so the default
// palette's tints suit a light terminal) and its color depth.
async function readTerminal(noColor: boolean): Promise<void> {
  const [{ detectBackground }, theme] = await Promise.all([import('./tui/terminalBackground.js'), import('./tui/theme.js')]);
  theme.setColorDepth(theme.detectColorDepth());
  theme.setTerminalBackground(await detectBackground(), noColor);
}

// The marks and file icons the screens draw, from the config.
async function setMarks(glyphs: GlyphSetting, icons: IconSetting): Promise<void> {
  (await import('./tui/glyphs.js')).setGlyphs(glyphs);
  (await import('./tui/icons.js')).setIcons(icons);
}

async function main() {
  const [cmd, arg] = cli.input;
  const cwd = process.cwd();
  if (cmd === 'completion') {
    const { completionScript, SHELLS } = await import('./shellCompletion.js');
    const shell = SHELLS.find((s) => s === arg) ?? fail(`completion takes a shell: ${NAME} completion ${SHELLS.join('|')}.`);
    process.stdout.write(completionScript(shell, NAME === 'gr' ? ['gr', 'guided-review'] : ['guided-review', 'gr']));
    return;
  }
  // The completion scripts' PR numbers: this repo's open PRs, "number<tab>title" a line. Quiet,
  // and quick to give up, as a shell waits on it.
  if (cmd === '__complete' && arg === 'prs') {
    const [{ listOpenPRs }, { completionText }] = await Promise.all([import('./github/gh.js'), import('./shellCompletion.js')]);
    const repo = await currentRepo(cwd).catch(() => undefined);
    const prs = repo ? await listOpenPRs(repo, AbortSignal.timeout(4000)).catch(() => []) : [];
    process.stdout.write(prs.map((p) => `${p.number}\t${completionText(p.title)}\n`).join(''));
    return;
  }
  // After an update, the command and skill gr installed follow the new version, unless edited.
  if (cmd !== 'build' && packagedRun()) for (const what of refreshInstalled()) process.stderr.write(`Updated ${what} to match Guided Review ${PKG.version}.\n`);
  if (cmd === 'update') return update();
  // `setup` is the old name for `config`.
  if (cmd === 'config' || cmd === 'setup') {
    if (cli.flags.repo) {
      editRepoConfig((await localRepoRoot(cwd)) ?? fail('not inside a git repository.'));
      return;
    }
    await runConfig({ edit: cli.flags.edit, clones: cli.flags.clones });
    return;
  }
  if (cmd === 'cleanup') {
    const { days } = cli.flags;
    if (days !== undefined && !(Number.isFinite(days) && days > 0)) fail('--days must be a positive number of days.');
    const maxAge = days ?? TOUR_MAX_AGE_DAYS;
    const result = await cleanup(maxAge);
    process.stdout.write(`Removed ${result.worktrees.removed.length} PR worktree(s).\n`);
    for (const item of result.worktrees.skipped) process.stdout.write(`Skipped ${item.path}: ${item.reason}\n`);
    process.stdout.write(`Removed ${result.repos.length} of gr's own clone(s): unused for ${REPO_MAX_AGE_DAYS} days, or replaced by yours.\n`);
    process.stdout.write(`Removed ${result.tours} old tour(s): the newest ${KEEP_TOURS_PER_PR} per PR are kept, minus any not opened in ${maxAge} days.\n`);
    if (result.prs) process.stdout.write(`Cleared reading state for ${result.prs} PR(s) with no tour left; unposted drafts are kept.\n`);
    return;
  }
  if (cmd === 'doctor') {
    const [{ diagnose, formatFindings, runCommand }, { detectColorDepth }, { viewerLogin }, { readGitHubToken }, { loadGitHubConfig }, { grHome }] = await Promise.all([
      import('./doctor.js'),
      import('./tui/theme.js'),
      import('./github/gh.js'),
      import('./github/auth.js'),
      import('./config.js'),
      import('./paths.js'),
    ]);
    let problem: string | undefined;
    let raw: Record<string, unknown> | null = null;
    let routing: ReturnType<typeof agentRouting>;
    try {
      raw = readUserConfigFile();
      if (raw) routing = agentRouting(loadUserConfig(raw));
    } catch (e) {
      problem = (e as Error).message;
    }
    const findings = await diagnose({
      run: runCommand,
      env: process.env,
      platform: process.platform,
      nodeVersion: process.versions.node,
      home: grHome(),
      grammars: async () => {
        const ts = await import('./analysis/treesitter.js');
        await ts.initTreeSitter();
        return ts.treeSitterGrammars();
      },
      colorDepth: () => detectColorDepth(),
      models: async () => (routing && cli.flags.agent ? (await import('./agent/check.js')).checkModels(routing) : undefined),
      githubToken: () => {
        const github = raw ? loadGitHubConfig() : undefined;
        if (!readGitHubToken(github)) return undefined;
        return github?.tokenEnv ? `$${github.tokenEnv}` : github?.tokenFile;
      },
      viewer: () => viewerLogin(),
      configProblem: () => problem,
      noModel: !raw ? 'not set up yet: gr config chooses one, or none' : !routing ? 'none: tours are built from static analysis only' : 'not checked (--no-agent)',
    });
    process.stdout.write(formatFindings(findings, !!process.stdout.isTTY && !process.env.NO_COLOR));
    process.exit(findings.some((f) => f.status === 'fail') ? 1 : 0);
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
  // gr tutor: lessons over the demo tour, a sample change toured offline.
  const tutor = cmd === 'tutor';
  const demo = tutor;
  if (cmd && cmd !== 'review' && cmd !== 'feedback' && cmd !== 'preview' && cmd !== 'diff' && !demo && !prArg.test(cmd)) cli.showHelp(1);
  if (cli.flags.base !== undefined && cmd !== 'preview') fail(`--base goes with ${NAME} preview. For two commits, use ${NAME} diff <a>..<b>.`);

  // Everything below starts the full-screen tour. Check for a terminal before
  // spending any gh or network calls on it.
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail(`${NAME} is an interactive terminal app; run it in a terminal.`);
  // How the terminal shows color, and NO_COLOR, read once before any screen.
  const noColor = !!process.env.NO_COLOR;
  await readTerminal(noColor);
  // Each release is offered full screen once, as gr starts; a deprecated version's, every time.
  const launch = updateCheck?.launchOffer();
  if (launch) {
    const code = await promptForUpdate(launch, process.argv.slice(2));
    if (code !== undefined) process.exit(code);
  }
  // First run: introduce gr and set it up, then carry on with the command that was run. A command
  // that reads GitHub checks gh first, so a signed-out gh is said before five screens of setup
  // rather than after them.
  // The demo needs no model, so it starts without setup.
  if (cli.flags.agent && !demo && !fs.existsSync(userConfigPath())) {
    if (cmd !== 'preview' && cmd !== 'diff') {
      const { detectGitHub } = await import('./detect.js');
      const gh = await detectGitHub();
      if (!gh.installed) fail(`the GitHub CLI (gh) is not installed. Install it from https://cli.github.com and run \`gh auth login\`, or run \`${NAME} config\` to use a personal access token.`);
      if (!gh.login) fail(`gh is not signed in to GitHub (or GitHub could not be reached). Run \`gh auth login\`, or \`${NAME} config\` to use a personal access token, then run this again.`);
    }
    const result = await setup({ firstRun: true });
    if (result.kind === 'cancelled') fail(`no config saved. Run \`${NAME} config\` when you're ready, or pass --no-agent to review without a model.`);
  }
  // The daily cleanup runs while the PR is resolved, and finishes before the tour can open a worktree.
  const cleanupP = autoCleanup();
  // Load the TUI while the PR is being resolved below.
  const tui = Promise.all([import('ink'), import('./tui/App.js')]);
  tui.catch(() => undefined); // awaited below; a failure surfaces there
  const localRepoP = localRepoRoot(cwd);
  // The clone gr runs in is remembered, so later PRs of its repository are checked out from it
  // wherever gr is started.
  void localRepoP.then((root) => (root ? import('./git/clones.js').then(({ recordClone }) => recordClone(root)) : undefined)).catch(() => undefined);
  const takesArg = cmd === 'review' || cmd === 'feedback';
  const needsRepo = takesArg ? !!arg : !!cmd && cmd !== 'preview' && cmd !== 'diff' && !demo;
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
  const { agent, noAgent } = demo ? { agent: undefined, noAgent: true } : agentOptions(config);
  let chapterOrder: AppOptions['chapterOrder'];
  let hideWhitespace: boolean;
  let splitDiff: boolean;
  let sidebar: boolean;
  let shortExplanation: boolean;
  let commentLabels: boolean;
  let syncViewed: boolean;
  let themeName: string | undefined;
  let glyphs: GlyphSetting;
  let icons: IconSetting;
  let tipsSeen: string[];
  try {
    chapterOrder = loadChapterOrder(config);
    hideWhitespace = loadViewSetting('hideWhitespace', config);
    splitDiff = loadViewSetting('splitDiff', config);
    sidebar = loadViewSetting('sidebar', config);
    shortExplanation = loadViewSetting('shortExplanation', config);
    commentLabels = loadCommentLabels(config);
    syncViewed = loadSyncViewed(config);
    themeName = loadThemeSetting(config);
    glyphs = loadGlyphSetting(config);
    icons = loadIconSetting(config);
    tipsSeen = loadTipsSeen(config);
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
    sidebar,
    shortExplanation,
    commentLabels,
    syncViewed,
    tipsSeen,
    saveTipSeen: config ? saveTipSeen : undefined,
    saveViewSetting,
    saveTheme: config ? saveThemeSetting : undefined,
    noAgent,
    fresh: cli.flags.fresh,
    localRepo: await localRepoP,
  };

  let opts: AppOptions = base;
  if (cmd === 'review') {
    const target = arg ? parsePRArg(arg, await cwdRepoP) : await currentBranchPR(cwd);
    if (target) opts = { ...base, target };
    else {
      // A branch with no PR yet is most likely what was meant: offer its preview.
      const preview = !arg && base.localRepo ? await localPreview(cwd).catch(() => undefined) : undefined;
      if (!preview?.diff.trim()) fail(`no PR given and the current branch has no open PR. Usage: ${NAME} review <number|URL>`);
      const yes = await askYes(`No open PR for ${preview.pr.headRef}. Tour the branch against ${preview.pr.baseRef} instead (${NAME} preview)? [Y/n] `);
      if (!yes) process.exit(0);
      opts = { ...base, preview };
    }
  } else if (cmd === 'feedback') {
    const target = arg ? parsePRArg(arg, await cwdRepoP) : await currentBranchPR(cwd);
    if (!target) fail(`no PR given and the current branch has no open PR. Usage: ${NAME} feedback <number|URL>`);
    opts = { ...base, target, mode: 'author' };
  } else if (cmd === 'preview' || cmd === 'diff') {
    if (!base.localRepo) fail(`${NAME} ${cmd} must run inside a git repository.`);
    if (cmd === 'preview' && arg) fail(`${NAME} preview tours the current branch and takes no argument. To compare with another branch: ${NAME} preview --base <ref>.`);
    if (cli.flags.base === '') fail('--base needs a branch or commit.');
    // gr diff with nothing given: the working tree against HEAD, as git diff shows it.
    const previewTarget = cmd === 'diff' ? parseDiffTarget(arg ?? 'HEAD') : cli.flags.base ? { base: cli.flags.base } : undefined;
    const preview = await localPreview(cwd, undefined, previewTarget).catch((e: Error) => fail(e.message));
    const { baseRef, headRef } = preview.pr;
    if (!preview.diff.trim()) fail(`nothing to tour: ${previewTarget?.head ? `no changes between ${baseRef} and ${headRef}` : `the working tree has no changes against ${baseRef}`}.`);
    opts = { ...base, previewTarget, preview };
  } else if (demo) {
    // Not the repository gr runs in: the demo's own, under GR_HOME.
    const { demoPreview } = await import('./demo.js');
    opts = { ...base, localRepo: undefined, demo: true, tutor, preview: await demoPreview().catch((e: Error) => fail(`could not set up the demo: ${e.message}`)) };
  } else if (cmd) {
    opts = { ...base, target: parsePRArg(cmd, await cwdRepoP) };
  }

  const [{ render }, { App }] = await tui;
  await cleanupP;
  await setMarks(glyphs, icons);
  opts = { ...opts, palette: await paletteP };
  // Set by the gr that installed this version, checked it, and started it again.
  const updated = process.env.GR_UPDATED;
  delete process.env.GR_UPDATED;
  if (updated) opts = { ...opts, notice: `Updated to Guided Review ${updated}.` };
  let summary: string | undefined;
  // U on the PR list closes the app for the update screen. When the update doesn't happen
  // (not now, skipped, or failed), the PR list opens again.
  for (;;) {
    let wantsUpdate = false;
    let wantsConfig = false;
    const offer = updateCheck?.available();
    holdTerminalInput();
    const app = render(
      <App
        {...opts}
        onQuit={(line) => (summary = line)}
        update={offer && { version: offer.latest, deprecated: offer.deprecated }}
        onUpdate={offer ? () => (wantsUpdate = true) : undefined}
        onConfig={demo ? () => (wantsConfig = true) : undefined}
      />,
      { ...SCREEN_RENDER, exitOnCtrlC: true },
    );
    await app.waitUntilExit();
    // The tutor's end: gr config, in place of the demo.
    if (wantsConfig) {
      await runConfig();
      process.exit(0);
    }
    if (!wantsUpdate || !offer) break;
    // Back on the PR list, wherever it was started from: the args that pick a PR are left out.
    const args = process.argv.slice(2).filter((a) => !cli.input.includes(a));
    const code = await promptForUpdate(offer, args);
    if (code !== undefined) process.exit(code);
    opts = { ...opts, target: undefined, preview: undefined, mode: undefined, notice: undefined };
  }
  // Where the review stands, left in the scrollback once the screen is gone.
  if (summary) process.stdout.write(`${summary}\n`);
  await printUpdateNotice();
  // Backstop: stray timers, sockets, or child processes must not keep gr alive
  // after the tour has closed.
  process.exit(0);
}

// gr config, and c at the end of the demo's tutor. The wizard's theme preview draws as the tour
// will: for this terminal, with the config's marks. A config that can't be read keeps the default
// marks; setup says what is wrong with it.
async function runConfig(o: { edit?: boolean; clones?: boolean } = {}): Promise<void> {
  if (!o.edit && process.stdin.isTTY && process.stdout.isTTY) {
    await readTerminal(!!process.env.NO_COLOR);
    try {
      const saved = readUserConfigFile();
      await setMarks(loadGlyphSetting(saved), loadIconSetting(saved));
    } catch (error) {
      if (!(error instanceof UserConfigError)) throw error;
    }
  }
  if (o.clones) {
    await setupClones().catch((e: Error) => fail(e.message));
    return;
  }
  await setup({ edit: o.edit });
}

// A yes-or-no question on the terminal before the tour starts; Enter is yes.
async function askYes(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^(y|yes)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

// The short commands get here; build and the tour exit from main. Give a check
// still in flight a moment so quick commands can refresh the cache too.
main()
  .then(() => printUpdateNotice(300))
  .catch((e) => fail(e instanceof Error ? e.message : String(e), e));
