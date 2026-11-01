import { sanitizeTerminal } from './util/sanitize.js';

// `gr completion <shell>`: a script that completes gr's commands, their flags, branches for
// `diff` and `--base`, and the repo's open PRs (from `gr __complete prs`) in zsh, bash and fish.

export const SHELLS = ['zsh', 'bash', 'fish'] as const;
export type Shell = (typeof SHELLS)[number];

type Arg = 'pr' | 'ref' | 'shell';

interface CommandSpec {
  name: string;
  about: string;
  flags: string[];
  arg?: Arg;
}

const TOUR_FLAGS = ['--no-agent', '--fresh'];

export const COMMANDS: CommandSpec[] = [
  { name: 'review', about: 'Start or resume a guided tour of a PR', flags: TOUR_FLAGS, arg: 'pr' },
  { name: 'feedback', about: 'Work through the review feedback on your PR', flags: TOUR_FLAGS, arg: 'pr' },
  { name: 'preview', about: 'Tour your current branch before opening the PR', flags: [...TOUR_FLAGS, '--base'] },
  { name: 'diff', about: 'Tour the working tree against a commit, or two commits', flags: TOUR_FLAGS, arg: 'ref' },
  { name: 'demo', about: 'Try a tour of a sample change', flags: [] },
  { name: 'open', about: 'Open the tour of a PR in a new terminal window', flags: ['--preview'], arg: 'pr' },
  { name: 'build', about: 'Build a tour without the TUI (for CI)', flags: [...TOUR_FLAGS, '--comment', '--out'], arg: 'pr' },
  { name: 'doctor', about: 'Check what gr needs and how to fix what is missing', flags: ['--no-agent'] },
  { name: 'cleanup', about: 'Remove local PR worktrees and old tours', flags: ['--days'] },
  { name: 'update', about: 'Install the newest version of gr', flags: [] },
  { name: 'config', about: 'Choose a model provider, models, API key, and GitHub access', flags: ['--edit', '--repo'] },
  { name: 'install-claude-command', about: 'Add /guided-review to Claude Code', flags: ['--force'] },
  { name: 'install-codex-skill', about: 'Add Guided Review as a Codex skill', flags: ['--force'] },
  { name: 'completion', about: 'Print a shell completion script', flags: [], arg: 'shell' },
];

const FLAG_ABOUT: Record<string, string> = {
  '--no-agent': 'Without a model: static analysis only',
  '--fresh': 'Rebuild the tour even if one is cached or shared',
  '--base': 'Compare with this branch or commit',
  '--preview': 'Open the preview of the current branch',
  '--comment': 'Post the tour to the PR',
  '--out': 'Write the tour JSON to a file (- for stdout)',
  '--days': 'Delete tours not opened in this many days',
  '--edit': 'Open the config file in your editor',
  '--repo': "Edit this repo's .guided-review.json",
  '--force': 'Replace an existing file with different content',
};

// Only the lines that are PRs, "number<tab>title": a gr too old to know __complete prints its help.
const PR_LINES = `awk -F'\\t' '$1 ~ /^[0-9]+$/ && NF > 1'`;

const REFS = `git for-each-ref --format="%(refname:short)" refs/heads refs/remotes refs/tags 2>/dev/null`;

const withArg = (arg: Arg) =>
  COMMANDS.filter((c) => c.arg === arg)
    .map((c) => c.name)
    .join(' ');

// A PR title as one line: no control characters (sanitizeTerminal), and tabs and newlines, which
// separate a completion from its description and from the next, made spaces.
export function completionText(s: string): string {
  return sanitizeTerminal(s).replace(/\s+/g, ' ').trim();
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
// fish's single quotes take \' and \\ inside them instead.
const fishQuote = (s: string) => `'${s.replace(/[\\']/g, '\\$&')}'`;

function zsh(names: string[]): string {
  const cmds = COMMANDS.map((c) => `    ${quote(`${c.name}:${c.about}`)}`).join('\n');
  const flagCases = COMMANDS.filter((c) => c.flags.length)
    .map((c) => `      ${c.name}) flags=(${c.flags.map((f) => quote(`${f}:${FLAG_ABOUT[f]}`)).join(' ')}) ;;`)
    .join('\n');
  return `# Guided Review completion for zsh. Load it from ~/.zshrc, after compinit:
#   eval "$(${names[0]} completion zsh)"
_gr_refs() {
  local -a refs
  refs=(\${(f)"$(${REFS})"})
  compadd -a refs
}
_gr() {
  local -a commands flags prs
  commands=(
${cmds}
  )
  if (( CURRENT == 2 )); then
    _describe -t commands 'command' commands
    return
  fi
  local cmd=$words[2]
  case $words[CURRENT-1] in
    --base) _gr_refs; return ;;
    --out) _files; return ;;
    --days) return ;;
  esac
  if [[ $PREFIX == -* ]]; then
    case $cmd in
${flagCases}
    esac
    _describe -t options 'option' flags
    return
  fi
  (( CURRENT == 3 )) || return
  case $cmd in
    ${withArg('pr').replace(/ /g, '|')})
      prs=(\${(f)"$($words[1] __complete prs 2>/dev/null | ${PR_LINES} | sed 's/\t/:/')"})
      _describe -t prs 'open PR' prs -V prs ;;
    ${withArg('ref')})
      compset -P '*..'
      _gr_refs ;;
    ${withArg('shell')}) compadd ${SHELLS.join(' ')} ;;
  esac
}
compdef _gr ${names.join(' ')}
`;
}

function bash(names: string[]): string {
  const flagCases = COMMANDS.filter((c) => c.flags.length)
    .map((c) => `      ${c.name}) flags=${quote(c.flags.join(' '))} ;;`)
    .join('\n');
  return `# Guided Review completion for bash. Load it from ~/.bashrc:
#   eval "$(${names[0]} completion bash)"
_gr() {
  local cur=\${COMP_WORDS[COMP_CWORD]} prev=\${COMP_WORDS[COMP_CWORD-1]} cmd=\${COMP_WORDS[1]} flags= pre= ref
  COMPREPLY=()
  case $prev in
    --base) COMPREPLY=($(compgen -W "$(${REFS})" -- "$cur")); return ;;
    --out) COMPREPLY=($(compgen -f -- "$cur")); return ;;
    --days) return ;;
  esac
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W ${quote(COMMANDS.map((c) => c.name).join(' '))} -- "$cur"))
    return
  fi
  if [[ $cur == -* ]]; then
    case $cmd in
${flagCases}
    esac
    COMPREPLY=($(compgen -W "$flags" -- "$cur"))
    return
  fi
  [[ $COMP_CWORD -eq 2 ]] || return
  case $cmd in
    ${withArg('pr').replace(/ /g, '|')}) COMPREPLY=($(compgen -W "$("\${COMP_WORDS[0]}" __complete prs 2>/dev/null | ${PR_LINES} | cut -f1)" -- "$cur")) ;;
    ${withArg('ref')})
      ref=$cur
      if [[ $cur == *..* ]]; then pre=\${cur%..*}..; ref=\${cur#"$pre"}; fi
      COMPREPLY=($(compgen -P "$pre" -W "$(${REFS})" -- "$ref")) ;;
    ${withArg('shell')}) COMPREPLY=($(compgen -W ${quote(SHELLS.join(' '))} -- "$cur")) ;;
  esac
}
complete -F _gr ${names.join(' ')}
`;
}

function fish(names: string[]): string {
  const [name] = names;
  const sub = (cmds: string) => `__fish_seen_subcommand_from ${cmds}`;
  const firstArg = (cmds: string) => fishQuote(`${sub(cmds)}; and test (count (commandline -opc)) -eq 2`);
  const lines = [
    `# Guided Review completion for fish. Load it from ~/.config/fish/config.fish:`,
    `#   ${name} completion fish | source`,
    `complete -c ${name} -f`,
    ...COMMANDS.map((c) => `complete -c ${name} -n __fish_use_subcommand -a ${c.name} -d ${fishQuote(c.about)}`),
    ...COMMANDS.flatMap((c) =>
      c.flags.map((f) => {
        const value = f === '--base' ? ` -x -a ${fishQuote(`(${REFS})`)}` : f === '--out' ? ' -r -F' : f === '--days' ? ' -x' : '';
        return `complete -c ${name} -n ${fishQuote(sub(c.name))} -l ${f.slice(2)}${value} -d ${fishQuote(FLAG_ABOUT[f])}`;
      }),
    ),
    `complete -c ${name} -n ${firstArg(withArg('pr'))} -a ${fishQuote(`(${name} __complete prs 2>/dev/null | ${PR_LINES})`)}`,
    `complete -c ${name} -n ${firstArg(withArg('ref'))} -a ${fishQuote(`(${REFS})`)}`,
    `complete -c ${name} -n ${firstArg(withArg('shell'))} -a ${fishQuote(SHELLS.join(' '))}`,
    ...names.slice(1).map((n) => `complete -c ${n} -w ${name}`),
  ];
  return `${lines.join('\n')}\n`;
}

// The script for `shell`, completing `names` (gr and guided-review), the name typed first.
export function completionScript(shell: Shell, names: string[]): string {
  return shell === 'zsh' ? zsh(names) : shell === 'bash' ? bash(names) : fish(names);
}
