// The coding agents `o` can open in a chapter, each started in the terminal gr suspends with
// the review context as its first prompt. The config's "codingAgent" names one; Claude Code
// when unset. "custom" runs the config's "codingAgentCommand" instead.

export const CODING_AGENTS = [
  { value: 'claude', name: 'Claude Code', command: 'claude', args: (prompt: string) => [prompt] },
  { value: 'codex', name: 'Codex', command: 'codex', args: (prompt: string) => [prompt] },
  { value: 'cursor', name: 'Cursor CLI', command: 'cursor-agent', args: (prompt: string) => [prompt] },
  { value: 'gemini', name: 'Gemini CLI', command: 'gemini', args: (prompt: string) => ['--prompt-interactive', prompt] },
  { value: 'opencode', name: 'opencode', command: 'opencode', args: (prompt: string) => ['--prompt', prompt] },
  { value: 'pi', name: 'pi', command: 'pi', args: (prompt: string) => [prompt] },
] as const;

export const CUSTOM_AGENT = 'custom';

export type CodingAgent = (typeof CODING_AGENTS)[number]['value'] | typeof CUSTOM_AGENT;

// The agent as the config holds it: a custom one carries its command line.
export interface CodingAgentSetting {
  agent: CodingAgent;
  command?: string;
}

export const DEFAULT_CODING_AGENT: CodingAgent = 'claude';

export const CODING_AGENT_VALUES: CodingAgent[] = [...CODING_AGENTS.map((a) => a.value), CUSTOM_AGENT];

export const isCodingAgent = (value: unknown): value is CodingAgent => CODING_AGENT_VALUES.includes(value as CodingAgent);

// Where a custom command takes the prompt; without it, the prompt is the last argument.
export const PROMPT_PLACEHOLDER = '{prompt}';

// Splits a command line into words, with "double" or 'single' quotes keeping spaces. No shell
// runs it, so the review text in the prompt is never interpreted.
export function splitCommand(line: string): string[] {
  return parseCommand(line).words;
}

function parseCommand(line: string): { words: string[]; unclosed: boolean } {
  const words: string[] = [];
  let word = '';
  let quote: string | undefined;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || word) words.push(word);
      word = '';
      started = false;
    } else {
      word += ch;
    }
  }
  if (started || word) words.push(word);
  return { words, unclosed: !!quote };
}

// A problem with a custom command as typed, or undefined.
export function customCommandProblem(line: string | undefined): string | undefined {
  if (!line?.trim()) return 'enter the command that starts your agent, such as aider --message';
  const { words, unclosed } = parseCommand(line);
  if (unclosed) return 'a quote is not closed';
  if (!words[0]) return 'the first word must name the program to run';
  return undefined;
}

export function codingAgentName(setting: CodingAgentSetting | undefined): string {
  const agent = setting?.agent ?? DEFAULT_CODING_AGENT;
  if (agent === CUSTOM_AGENT) return `custom command (${setting?.command ?? ''})`;
  return CODING_AGENTS.find((a) => a.value === agent)!.name;
}

// The program and arguments that open the agent with the prompt.
export function codingAgentLaunch(setting: CodingAgentSetting | undefined, prompt: string): { command: string; args: string[] } {
  const agent = setting?.agent ?? DEFAULT_CODING_AGENT;
  if (agent === CUSTOM_AGENT) {
    const [command, ...rest] = splitCommand(setting?.command ?? '');
    const placed = rest.some((w) => w.includes(PROMPT_PLACEHOLDER));
    const args = placed ? rest.map((w) => w.split(PROMPT_PLACEHOLDER).join(prompt)) : [...rest, prompt];
    return { command, args };
  }
  const info = CODING_AGENTS.find((a) => a.value === agent)!;
  return { command: info.command, args: [...info.args(prompt)] };
}
