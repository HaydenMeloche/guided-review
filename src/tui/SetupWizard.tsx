import { useEffect, useRef, useState } from 'react';
import { render, useApp, useInput, useWindowSize } from 'ink';
import { Box, Text, ThemeContext, useSelected, useThemePreview } from './themed.js';
import { loadPalette, terminalPalette, themeList, TERMINAL_THEME, type Palette, type ThemeInfo } from './theme.js';
import { ThemePicker } from './ThemePicker.js';
import { Key, KeyBar } from './KeyBar.js';
import { pad, truncate, wrap } from './nav.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';
import { detectCodingAgents, detectGitHub, detectProviders, LOOKED_FOR, type GitHubFinding, type ProviderFinding } from '../detect.js';
import { CODING_AGENTS, CUSTOM_AGENT, customCommandProblem, DEFAULT_CODING_AGENT, PROMPT_PLACEHOLDER, type CodingAgent, type CodingAgentSetting } from '../codingAgent.js';
import { checkModels, type ModelCheck } from '../agent/check.js';
import { defaultParams, findVariant, KNOWN_MODELS, listModels, LISTS_MODELS, type ModelOption } from '../agent/models.js';
import { NO_PROVIDER, type GitHubConfig, type UserConfig } from '../config.js';
import {
  buildConfig,
  checkGitHubToken,
  describeUserConfig,
  githubConfig,
  githubDefaults,
  githubNotes,
  githubProblems,
  modelDefaults,
  modelNotes,
  modelProblems,
  modelReady,
  previousRouting,
  PROVIDER_CHOICES,
  replacesOverrides,
  takesKey,
  TOKEN_HELP,
  type GitHubAnswers,
  type ModelAnswers,
  type ProviderChoice,
  type SetupResult,
} from '../setup.js';
import { agentRouting } from '../config.js';

// gr's setup, full screen: a welcome card, the color theme (so every later screen is already
// in it), the model provider with what detection found marked, its details when something is
// missing, the coding agent o opens, GitHub access when gh isn't signed in, and a finish screen
// that sends one request to each model before saving. The caller saves the config the wizard returns.

type Step = 'welcome' | 'theme' | 'provider' | 'details' | 'agent' | 'github' | 'finish';

export interface Detected {
  providers: ProviderFinding[];
  github: GitHubFinding;
  codingAgents?: CodingAgent[]; // installed, in CODING_AGENTS order
}

export interface WizardProps {
  firstRun: boolean;
  current?: UserConfig;
  problem?: string; // why the saved config can't be used
  file: string;
  themes: ThemeInfo[];
  initial: Palette;
  detect: Promise<Detected>;
  checkModels: (config: UserConfig, signal: AbortSignal) => Promise<ModelCheck[]>;
  checkGitHub: (github: GitHubConfig) => Promise<{ ok: boolean; message: string }>;
  listModels: typeof listModels;
  env?: NodeJS.ProcessEnv;
  onDone: (result: SetupResult) => void;
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function useSpinner(on: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(t);
  }, [on]);
  return SPIN[frame % SPIN.length];
}

// Text wrapped by word to the width, one space in from the edge like the rest of a step.
function Para(props: { text: string; width: number; color?: string; dim?: boolean; marginTop?: number }) {
  return (
    <Box flexDirection="column" marginTop={props.marginTop}>
      {wrap(props.text, Math.max(10, props.width - 2)).map((l, i) => (
        <Text key={i} color={props.color} dimColor={props.dim}>
          {' '}
          {l}
        </Text>
      ))}
    </Box>
  );
}

// One row of the provider list: a provider, with what detection found when it was found.
interface ProviderRow {
  value: ProviderChoice;
  name: string;
  about: string;
  finding?: ProviderFinding;
  unavailable?: string;
  recommended?: boolean;
  missing?: string; // what detection looked for and didn't find
}

// `detected` false while detection runs: the other rows don't yet say what wasn't found.
// Tells rows apart when one provider has several: each local server found is its own row.
export const rowKey = (row: ProviderRow): string => (row.finding?.baseUrl ? `${row.value} ${row.finding.baseUrl}` : row.value);

export function providerRows(found: ProviderFinding[], detected = true): { found: ProviderRow[]; other: ProviderRow[] } {
  const choice = (v: ProviderChoice) => PROVIDER_CHOICES.find((c) => c.value === v)!;
  const foundRows = found.map((f) => ({ ...choice(f.provider), finding: f }));
  const isFound = (v: ProviderChoice) => found.some((f) => f.provider === v);
  // A local server found doesn't rule out a remote compatible endpoint.
  const other = PROVIDER_CHOICES.filter((c) => c.value === 'openai-compatible' || c.value === NO_PROVIDER || !isFound(c.value)).map((c) => ({
    ...c,
    missing: detected && c.value !== NO_PROVIDER && !c.unavailable && !isFound(c.value) ? LOOKED_FOR[c.value] : undefined,
  }));
  return { found: foundRows, other };
}

export function SetupWizard(props: WizardProps) {
  const { columns, rows } = useWindowSize();
  const { palette, preview } = useThemePreview(props.initial);
  const { exit } = useApp();
  const env = props.env ?? process.env;
  const previous = previousRouting(props.current);

  const [history, setHistory] = useState<Step[]>(['welcome']);
  const step = history.at(-1)!;
  const go = (next: Step) => setHistory((h) => [...h, next]);
  const back = () => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h));

  const [detected, setDetected] = useState<Detected>();
  useEffect(() => {
    let live = true;
    void props.detect.then((d) => live && setDetected(d));
    return () => {
      live = false;
    };
  }, [props.detect]);

  const [theme, setTheme] = useState(props.current?.theme ?? TERMINAL_THEME);
  const [model, setModel] = useState<ModelAnswers>();
  const [modelRow, setModelRow] = useState<string>(); // rowKey of the provider row the answers are for
  const [github, setGitHub] = useState<GitHubAnswers>();
  const [codingAgent, setCodingAgent] = useState<CodingAgentSetting>();
  const savedAgent: CodingAgentSetting | undefined = props.current?.codingAgent && { agent: props.current.codingAgent, command: props.current.codingAgentCommand };

  // GitHub needs a step only when gh can't be used as it is, or the config already has a token.
  const needsGitHub = !detected || !detected.github.login || !!props.current?.github;
  const githubAnswers = github ?? githubDefaults(props.current?.github, detected?.github.installed ?? true);
  const afterAgent = (): Step => (needsGitHub ? 'github' : 'finish');

  // Ctrl+C leaves setup, as it does everywhere else in gr.
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      process.exitCode = 130;
      setImmediate(() => process.exit(130));
    }
  });

  const width = columns - 2;
  const height = rows - 2;
  const steps: [Step, string][] = [['theme', 'Theme'], ['provider', 'Model'], ['agent', 'Agent'], ...(needsGitHub ? ([['github', 'GitHub']] as [Step, string][]) : []), ['finish', 'Finish']];
  const stepIndex = steps.findIndex(([s]) => s === (step === 'details' ? 'provider' : step));
  const body = height - 1;

  let screen;
  if (step === 'welcome') {
    screen = <Welcome {...props} width={width} height={body} onStart={() => go('theme')} onEdit={() => props.onDone({ kind: 'edit' })} onQuit={() => props.onDone({ kind: 'cancelled' })} />;
  } else if (step === 'theme') {
    screen = (
      <ThemePicker
        themes={props.themes}
        current={theme}
        width={width}
        height={body}
        note="Change it later with L during a tour, or with gr config."
        onPreview={preview}
        onDone={(name) => {
          if (name === undefined) {
            preview(theme);
            return back();
          }
          setTheme(name);
          go('provider');
        }}
      />
    );
  } else if (step === 'provider') {
    screen = (
      <ProviderStep
        width={width}
        height={body}
        detected={detected}
        selected={modelRow ?? props.current?.provider}
        onBack={back}
        onChoose={(row, customize) => {
          // Answers carry over only for the same row: Ollama and LM Studio are both compatible endpoints.
          const answers = model && modelRow === rowKey(row) ? model : modelDefaults(row.value, previous, row.finding);
          setModel(answers);
          setModelRow(rowKey(row));
          go(row.value !== NO_PROVIDER && (customize || !modelReady(answers, env)) ? 'details' : 'agent');
        }}
      />
    );
  } else if (step === 'details' && model) {
    const start = modelDefaults(model.provider, previous);
    screen = (
      <DetailsStep
        width={width}
        height={body}
        answers={model}
        env={env}
        listModels={props.listModels}
        startParams={(role, id) => (start[role] === id ? start[role === 'fast' ? 'fastParams' : 'strongParams'] : undefined)}
        onChange={setModel}
        onBack={back}
        onDone={() => go('agent')}
      />
    );
  } else if (step === 'agent') {
    screen = (
      <CodingAgentStep
        width={width}
        height={body}
        detected={detected}
        // A config saved without one has been opening Claude Code; only a first run starts on what's installed.
        selected={codingAgent ?? savedAgent ?? { agent: (props.current ? undefined : detected?.codingAgents?.[0]) ?? DEFAULT_CODING_AGENT }}
        onBack={back}
        onChoose={(agent) => {
          setCodingAgent(agent);
          go(afterAgent());
        }}
      />
    );
  } else if (step === 'github') {
    screen = (
      <GitHubStep width={width} height={body} answers={githubAnswers} ghInstalled={detected?.github.installed ?? true} env={env} onChange={setGitHub} onBack={back} onDone={() => go('finish')} />
    );
  } else if (step === 'finish' && model) {
    const github = needsGitHub ? githubConfig(githubAnswers) : props.current?.github;
    const config = buildConfig(props.current, model, theme, github, codingAgent);
    screen = (
      <FinishStep
        width={width}
        height={body}
        firstRun={props.firstRun}
        config={config}
        ghLogin={github ? undefined : detected?.github.login}
        replacesOverrides={replacesOverrides(props.current, model.provider)}
        checkModels={props.checkModels}
        checkGitHub={props.checkGitHub}
        onBack={back}
        onSave={() => props.onDone({ kind: 'saved', config })}
      />
    );
  }

  return (
    <ThemeContext value={palette}>
      <Box flexDirection="column" width={columns} height={rows} backgroundColor={palette.bg} paddingX={1} paddingY={1}>
        <Box height={body} flexDirection="column">
          {screen}
        </Box>
        {step === 'welcome' ? null : (
          <Text wrap="truncate">
            {steps.map(([s, label], i) => (
              <Text key={s}>
                {i ? <Text dimColor> › </Text> : ' '}
                <Text bold={i === stepIndex} color={i === stepIndex ? 'cyan' : undefined} dimColor={i !== stepIndex}>
                  {i < stepIndex ? '✓ ' : `${i + 1} `}
                  {label}
                </Text>
              </Text>
            ))}
          </Text>
        )}
      </Box>
    </ThemeContext>
  );
}

function Welcome(props: WizardProps & { width: number; height: number; onStart: () => void; onEdit: () => void; onQuit: () => void }) {
  useInput((input, key) => {
    if (key.return) return props.onStart();
    if (input === 'e') return props.onEdit();
    if (input === 'q' || key.escape) return props.onQuit();
  });
  const cardW = Math.min(props.width, 74);
  const textW = cardW - 6;
  const settings = props.current ? describeUserConfig(props.current) : [];
  return (
    <Box width={props.width} height={props.height} alignItems="center" justifyContent="center">
      <Box flexDirection="column" width={cardW} borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
        <Text color="cyan" bold>
          ↗ Guided Review
        </Text>
        <Text> </Text>
        {props.firstRun ? (
          <>
            <Box width={textW}>
              <Text>
                Guided Review turns a pull request into a guided tour: chapters that follow the code's flow, tests beside each change, and risk flags, with a briefing and narration from a model if you
                connect one. Nothing posts to GitHub until you submit your review.
              </Text>
            </Box>
            <Text> </Text>
            <Box width={textW}>
              <Text dimColor>Let's set you up: a color theme, a model, and GitHub access. It takes about a minute, and gr config changes it any time.</Text>
            </Box>
          </>
        ) : (
          <>
            <Text bold>Settings</Text>
            {props.problem ? (
              <Box width={textW}>
                <Text color="yellow">Your config can't be used: {props.problem}</Text>
              </Box>
            ) : (
              settings.map((l) => (
                <Text key={l} wrap="truncate">
                  {'  '}
                  {safe(l)}
                </Text>
              ))
            )}
            <Text dimColor wrap="truncate">
              {'  '}
              {props.file}
            </Text>
          </>
        )}
        <Text> </Text>
        <Text wrap="truncate">
          <Key k="enter" />
          <Text dimColor>{props.firstRun ? ' get started   ' : ' walk through setup   '}</Text>
          <Key k="e" />
          <Text dimColor> edit config.json </Text>
          <Key k="q" />
          <Text dimColor> quit</Text>
        </Text>
      </Box>
    </Box>
  );
}

function StepTitle(props: { title: string; about?: string; width: number }) {
  return (
    <Box flexDirection="column" width={props.width} marginBottom={1}>
      <Text bold> {props.title}</Text>
      {props.about ? <Para text={props.about} width={props.width} dim /> : null}
    </Box>
  );
}

function ProviderStep(props: { width: number; height: number; detected?: Detected; selected?: string; onBack: () => void; onChoose: (row: ProviderRow, customize: boolean) => void }) {
  const spin = useSpinner(!props.detected);
  const selectedRow = useSelected();
  const { found, other } = providerRows(props.detected?.providers ?? [], !!props.detected);
  const all = [...found, ...other];
  // The cursor is a row, not a position: rows found by detection arrive above it. Until it moves
  // it follows the provider chosen before, or the best one found once detection ends.
  const [moved, setMovedState] = useState<string>();
  // Read through a ref, so keys that arrive together (↓ then Enter) each see the last move.
  const movedRef = useRef<string>(undefined);
  const setMoved = (key: string) => {
    movedRef.current = key;
    setMovedState(key);
  };
  const exact = (key: string | undefined) => all.findIndex((r) => rowKey(r) === key);
  // A provider saved in the config names no server, so it matches its first row.
  const chosen = exact(props.selected) >= 0 ? exact(props.selected) : all.findIndex((r) => r.value === props.selected && !r.unavailable);
  const sel = Math.max(0, exact(moved) >= 0 ? exact(moved) : chosen);
  const [notice, setNotice] = useState('');
  const row = all[sel];

  useInput((input, key) => {
    const move = (d: number) => {
      setNotice('');
      const from = exact(movedRef.current) >= 0 ? exact(movedRef.current) : sel;
      setMoved(rowKey(all[Math.max(0, Math.min(all.length - 1, from + d))]));
    };
    if (key.downArrow || input === 'j') return move(1);
    if (key.upArrow || input === 'k') return move(-1);
    if (key.home || input === 'g') return move(-all.length);
    if (key.end || input === 'G') return move(all.length);
    if (key.escape) return props.onBack();
    if (key.return || input === 'c') {
      const chosen = all[exact(movedRef.current)] ?? row;
      if (chosen.unavailable) return setNotice(`${chosen.name} is ${chosen.unavailable}.`);
      return props.onChoose(chosen, input === 'c');
    }
  });

  const nameW = Math.min(30, Math.max(...all.map((r) => r.name.length)) + 2);
  const line = (r: ProviderRow, i: number) => {
    const detail = safe(r.finding?.detail ?? r.unavailable ?? r.missing ?? '');
    return (
      <Text key={`${r.value}-${i}`} {...selectedRow(i === sel)} wrap="truncate">
        {pad(` ${r.finding ? '✓' : ' '} ${r.name}`, nameW + 3)}
        <Text color={r.finding ? 'green' : undefined} dimColor={!r.finding}>
          {detail}
        </Text>
        {r.recommended ? (
          <Text color="cyan" bold>
            {detail ? '  ' : ''}recommended
          </Text>
        ) : null}
      </Text>
    );
  };
  return (
    <Box flexDirection="column" width={props.width} height={props.height}>
      <StepTitle width={props.width} title="Model provider" about="gr uses a model for the briefing, chapter narration, Q&A, and suggested changes. Everything else works without one." />
      {props.detected ? (
        found.length ? (
          <Text dimColor> Found on this machine</Text>
        ) : (
          <Text dimColor> Nothing found on this machine: no Codex login, API key variables, or local model server.</Text>
        )
      ) : (
        <Text color="cyan"> {spin} Looking for Codex, API keys, and local model servers…</Text>
      )}
      {found.map((r, i) => line(r, i))}
      <Text> </Text>
      <Text dimColor> {found.length ? 'Other choices' : 'Choices'}</Text>
      {other.map((r, i) => line(r, found.length + i))}
      <Text> </Text>
      <Para text={notice || row.about} width={props.width} color={notice ? 'yellow' : undefined} dim={!notice} />
      <Box flexGrow={1} />
      <KeyBar
        accent
        width={props.width}
        keys={[
          ['j/k', 'move'],
          ['enter', 'choose'],
          ['c', 'choose and customize'],
          ['esc', 'back'],
        ]}
      />
    </Box>
  );
}

function CodingAgentStep(props: { width: number; height: number; detected?: Detected; selected: CodingAgentSetting; onBack: () => void; onChoose: (setting: CodingAgentSetting) => void }) {
  const selectedRow = useSelected();
  const rows = [...CODING_AGENTS.map((a) => ({ value: a.value, name: a.name, command: a.command })), { value: CUSTOM_AGENT as CodingAgent, name: 'Custom command', command: undefined }];
  const [moved, setMoved] = useState<number>();
  // Read through a ref, so keys that arrive together (↓ then Enter) each see the last move.
  const movedRef = useRef<number>(undefined);
  const sel =
    moved ??
    Math.max(
      0,
      rows.findIndex((r) => r.value === props.selected.agent),
    );
  const installed = props.detected?.codingAgents;
  // Enter on the custom row asks for its command, starting from the saved one.
  const [editing, setEditing] = useState(false);
  const [command, setCommand] = useState(props.selected.command ?? '');

  useInput(
    (input, key) => {
      const move = (d: number) => {
        const next = Math.max(0, Math.min(rows.length - 1, (movedRef.current ?? sel) + d));
        movedRef.current = next;
        setMoved(next);
      };
      if (key.downArrow || input === 'j') return move(1);
      if (key.upArrow || input === 'k') return move(-1);
      if (key.home || input === 'g') return move(-rows.length);
      if (key.end || input === 'G') return move(rows.length);
      if (key.escape) return props.onBack();
      if (key.return) {
        const row = rows[movedRef.current ?? sel];
        return row.value === CUSTOM_AGENT ? setEditing(true) : props.onChoose({ agent: row.value });
      }
    },
    { isActive: !editing },
  );

  const nameW = Math.max(...rows.map((r) => r.name.length)) + 2;
  const fields: Field[] = [
    {
      id: 'command',
      label: 'Command',
      kind: 'text',
      value: command,
      placeholder: 'aider --message',
      problem: customCommandProblem(command),
      hint: `Runs without a shell. The prompt goes last, or wherever you write ${PROMPT_PLACEHOLDER}.`,
    },
  ];
  return (
    <Box flexDirection="column" width={props.width} height={props.height}>
      <StepTitle
        width={props.width}
        title="Coding agent"
        about="Press o in a chapter to open this agent in the PR's checkout, with the hunk, your draft comments, and the review threads as its first prompt."
      />
      {rows.map((r, i) => {
        const found = r.value !== CUSTOM_AGENT && installed?.includes(r.value);
        const detail = r.value === CUSTOM_AGENT ? 'any command that takes a prompt' : installed ? (found ? `${r.command} is installed` : `${r.command} not found`) : '';
        return (
          <Text key={r.value} {...selectedRow(i === sel)} wrap="truncate">
            {pad(` ${found ? '✓' : ' '} ${r.name}`, nameW + 3)}
            <Text color={found ? 'green' : undefined} dimColor={!found}>
              {detail}
            </Text>
          </Text>
        );
      })}
      {editing ? (
        <Box marginTop={1}>
          <Form
            width={props.width}
            fields={fields}
            onChange={(_, value) => setCommand(value)}
            onBack={() => setEditing(false)}
            onSubmit={() => props.onChoose({ agent: CUSTOM_AGENT, command: command.trim() })}
          />
        </Box>
      ) : null}
      <Box flexGrow={1} />
      <KeyBar
        accent
        width={props.width}
        keys={
          editing
            ? [
                ['enter', 'choose'],
                ['esc', 'back to the list'],
              ]
            : [
                ['j/k', 'move'],
                ['enter', 'choose'],
                ['esc', 'back'],
              ]
        }
      />
    </Box>
  );
}

// A field of a setup form: free text, a hidden secret, one of a few options, or one of a long
// list. ←/→ change the last two.
export interface Field {
  id: string;
  label: string;
  kind: 'text' | 'secret' | 'choice' | 'select';
  value: string;
  options?: { value: string; label: string }[];
  placeholder?: string;
  problem?: string;
  hint?: string;
  tight?: boolean; // no blank line after it: a model and its parameters read as one group
}

// Moves with ↑/↓ or Tab; Enter goes to the next field, and from the last one submits.
// Problems show once a submit has been tried, so an empty form doesn't open in red.
export function Form(props: { fields: Field[]; width: number; onChange: (id: string, value: string) => void; onSubmit: () => void; onBack: () => void }) {
  const [focus, setFocusState] = useState(0);
  const [tried, setTried] = useState(false);
  // Read through a ref, so keys that arrive together each see the field the last one moved to.
  const focusRef = useRef(0);
  const setFocus = (i: number) => {
    focusRef.current = i;
    setFocusState(i);
  };
  const fields = props.fields;
  const at = Math.min(focus, fields.length - 1);
  useInput((input, key) => {
    const now = Math.min(focusRef.current, fields.length - 1);
    const field = fields[now];
    const move = (d: number) => setFocus(Math.max(0, Math.min(fields.length - 1, now + d)));
    if (key.escape) return props.onBack();
    if (key.downArrow || (key.tab && !key.shift)) return move(1);
    if (key.upArrow || (key.tab && key.shift)) return move(-1);
    if (key.return) {
      if (now < fields.length - 1) return move(1);
      setTried(true);
      return fields.some((f) => f.problem) ? setFocus(fields.findIndex((f) => f.problem)) : props.onSubmit();
    }
    if (field.kind === 'choice') {
      const options = field.options!;
      const i = options.findIndex((o) => o.value === field.value);
      const d = key.rightArrow || input === ' ' || input === 'l' ? 1 : key.leftArrow || input === 'h' ? -1 : 0;
      if (d) props.onChange(field.id, options[(i + d + options.length) % options.length].value);
      return;
    }
    if (field.kind === 'select') {
      const options = field.options!;
      const d = key.rightArrow ? 1 : key.leftArrow ? -1 : 0;
      const i = options.findIndex((o) => o.value === field.value);
      if (d) props.onChange(field.id, options[i < 0 ? 0 : (i + d + options.length) % options.length].value);
      return;
    }
    if (key.backspace || key.delete) return props.onChange(field.id, field.value.slice(0, -1));
    if (key.ctrl && input === 'u') return props.onChange(field.id, '');
    // A paste arrives as one chunk; keep its printable characters.
    const typed = !key.ctrl && !key.meta ? [...input].filter((ch) => ch >= ' ' && ch !== '\u007f').join('') : '';
    if (typed) props.onChange(field.id, field.value + typed);
  });

  const labelW = Math.min(28, Math.max(...fields.map((f) => f.label.length)) + 2);
  const valueW = Math.max(10, props.width - labelW - 4);
  return (
    <Box flexDirection="column" width={props.width}>
      {fields.map((f, i) => {
        const here = i === at;
        let shown: string;
        if (f.kind === 'choice') shown = f.options!.find((o) => o.value === f.value)?.label ?? '';
        else if (f.kind === 'secret') shown = f.value ? '•'.repeat(Math.min(f.value.length, 24)) : '';
        else shown = f.value;
        const tail = shown.length > valueW - 3 ? `…${shown.slice(-(valueW - 4))}` : shown;
        return (
          <Box key={f.id} flexDirection="column" marginBottom={f.tight ? 0 : 1}>
            <Text wrap="truncate">
              <Text color={here ? 'cyan' : undefined} bold={here}>
                {` ${here ? '›' : ' '} `}
                {pad(f.label, labelW)}
              </Text>
              {f.kind === 'select' ? (
                <SelectValue field={f} here={here} width={valueW} />
              ) : f.kind === 'choice' ? (
                here ? (
                  <Text>
                    <Text color="cyan" bold>
                      ◀{' '}
                    </Text>
                    {tail}
                    <Text color="cyan" bold>
                      {' '}
                      ▶
                    </Text>
                    <Text dimColor>
                      {'  '}
                      {f.options!.findIndex((o) => o.value === f.value) + 1} of {f.options!.length}
                    </Text>
                  </Text>
                ) : (
                  <Text>
                    <Text dimColor>‹ </Text>
                    {tail}
                    <Text dimColor> ›</Text>
                  </Text>
                )
              ) : (
                <Text>
                  {tail || (here ? '' : <Text dimColor>{f.placeholder ?? ''}</Text>)}
                  {here ? <Text inverse> </Text> : null}
                  {here && !tail && f.placeholder ? <Text dimColor> {f.placeholder}</Text> : null}
                </Text>
              )}
            </Text>
            {(tried || f.value) && f.problem ? (
              <Text color="red" wrap="truncate">
                {'   '}
                {pad('', labelW)}
                {f.problem}
              </Text>
            ) : here && f.hint ? (
              <Text dimColor wrap="truncate">
                {'   '}
                {pad('', labelW)}
                {f.hint}
              </Text>
            ) : here && f.kind === 'select' ? (
              <Text wrap="truncate">
                {'   '}
                {pad('', labelW)}
                <Key k="←/→" />
                <Text dimColor> to choose from {f.options!.length} models</Text>
              </Text>
            ) : here && f.kind === 'choice' ? (
              // The other options, so it's plain there is more than the one shown.
              <Text wrap="truncate">
                {'   '}
                {pad('', labelW)}
                <Key k="←/→" />
                <Text dimColor>
                  {' '}
                  or{' '}
                  {f
                    .options!.filter((o) => o.value !== f.value)
                    .map((o) => o.label)
                    .join(' · ')}
                </Text>
              </Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

function SelectValue(props: { field: Field; here: boolean; width: number }) {
  const f = props.field;
  const options = f.options!;
  const i = options.findIndex((o) => o.value === f.value);
  const label = options[i]?.label;
  const id = truncate(safe(f.value), Math.max(4, props.width - 20));
  if (!props.here) {
    return (
      <Text>
        {id}
        {label && label !== f.value ? <Text dimColor> {label}</Text> : null}
      </Text>
    );
  }
  return (
    <Text>
      <Text color="cyan" bold>
        ◀{' '}
      </Text>
      {id}
      <Text color="cyan" bold>
        {' '}
        ▶
      </Text>
      <Text dimColor>
        {'  '}
        {label && label !== f.value ? `${label} · ` : ''}
        {i >= 0 ? `${i + 1} of ${options.length}` : 'not in the list'}
      </Text>
    </Text>
  );
}

// A parameter value's name, marked when only Max Mode variants use it.
function paramValueLabel(option: ModelOption, param: string, value: { value: string; label: string }): string {
  const using = option.variants?.filter((v) => v.params[param] === value.value) ?? [];
  const label = param === 'fast' ? (value.value === 'true' ? 'fast (costs more)' : 'standard speed') : value.label;
  return using.length && using.every((v) => v.maxMode) ? `${label} (Max Mode)` : label;
}

type ModelList = { for: string; status: 'loading' | 'ok' | 'error'; options?: ModelOption[]; error?: string };

// The key the listing request uses, as the answers give it.
function answerKey(a: ModelAnswers, env: NodeJS.ProcessEnv): string | undefined {
  if (a.keySource === 'store') return a.apiKey || undefined;
  if (a.keySource === 'env') return env[a.apiKeyEnv.replace(/^\$/, '')] || undefined;
  return undefined;
}

function DetailsStep(props: {
  width: number;
  height: number;
  answers: ModelAnswers;
  env: NodeJS.ProcessEnv;
  listModels: WizardProps['listModels'];
  startParams: (role: 'fast' | 'strong', model: string) => Record<string, string> | undefined;
  onChange: (a: ModelAnswers) => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const a = props.answers;
  const problems = modelProblems(a);
  const name = PROVIDER_CHOICES.find((c) => c.value === a.provider)?.name ?? a.provider;

  // OpenAI's and Anthropic's models are a fixed list. Cursor's and a compatible endpoint's are
  // fetched once the key (or the URL) is usable; Cursor can list with the SDK's stored login.
  const known = a.provider === NO_PROVIDER ? undefined : KNOWN_MODELS[a.provider];
  const key = answerKey(a, props.env);
  const canList = a.provider !== NO_PROVIDER && LISTS_MODELS.includes(a.provider) && (a.provider === 'openai-compatible' ? !problems.baseUrl : !!key || a.provider === 'cursor');
  const listFor = canList ? JSON.stringify([a.provider, key, a.baseUrl]) : '';
  const [list, setList] = useState<ModelList>();
  useEffect(() => {
    if (!listFor || a.provider === NO_PROVIDER) return;
    const ac = new AbortController();
    const provider = a.provider;
    // Waits for typing to pause, so pasting a key or URL sends one request.
    const t = setTimeout(() => {
      setList({ for: listFor, status: 'loading' });
      props
        .listModels(provider, { key, baseUrl: provider === 'openai-compatible' ? a.baseUrl : undefined, signal: ac.signal })
        .then((options) => !ac.signal.aborted && setList({ for: listFor, status: 'ok', options }))
        .catch((e: Error) => !ac.signal.aborted && setList({ for: listFor, status: 'error', error: e.message }));
    }, 300);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
    // listFor holds everything the request depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listFor]);
  const current = list?.for === listFor ? list : undefined;
  const models = known ?? (current?.status === 'ok' && current.options?.length ? current.options : undefined);
  // IDs and names come from the provider, so terminal controls are stripped before they're shown.
  const options = models?.map((o) => ({ value: o.id, label: safe(o.label ?? '') }));
  const modelOf = (id: string) => models?.find((m) => m.id === id);

  // A Cursor model with parameters starts on its default variant (outside Max Mode) once the list
  // says what they are, unless the answers already name one.
  useEffect(() => {
    const fill = (role: 'fast' | 'strong'): Partial<ModelAnswers> => {
      const params = role === 'fast' ? a.fastParams : a.strongParams;
      const option = modelOf(a[role]);
      if (params || !option) return {};
      const start = defaultParams(option);
      return start ? { [role === 'fast' ? 'fastParams' : 'strongParams']: start } : {};
    };
    const next = { ...fill('fast'), ...fill('strong') };
    if (Object.keys(next).length) props.onChange({ ...a, ...next });
    // Runs when a list arrives or a model changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, a.fast, a.strong]);
  const listHint = !canList ? undefined : current?.status === 'error' ? safe(`Type a model ID; listing your models failed: ${current.error}`) : !options ? "Loading your account's models…" : undefined;
  const fields: Field[] = [];
  if (a.provider === 'openai-compatible') {
    fields.push({
      id: 'baseUrl',
      label: 'API base URL',
      kind: 'text',
      value: a.baseUrl,
      placeholder: 'http://localhost:11434/v1',
      problem: problems.baseUrl,
      hint: 'Including /v1. Remote endpoints must use https.',
    });
    fields.push({
      id: 'toolCalling',
      label: 'Function calling',
      kind: 'choice',
      value: a.toolCalling ? 'yes' : 'no',
      options: [
        { value: 'yes', label: 'supported: the model can read the repository' },
        { value: 'no', label: 'not supported' },
      ],
    });
  }
  if (takesKey(a.provider)) {
    const options = [
      ...(a.provider === 'openai-compatible' ? [{ value: 'none', label: 'no key (a local server)' }] : []),
      { value: 'env', label: 'read it from an environment variable' },
      { value: 'store', label: 'paste it (saved in config.json, owner-only)' },
    ];
    fields.push({ id: 'keySource', label: 'API key', kind: 'choice', value: a.keySource, options });
    if (a.keySource === 'env') fields.push({ id: 'apiKeyEnv', label: 'Variable', kind: 'text', value: a.apiKeyEnv, problem: problems.apiKeyEnv, hint: modelNotes(a, props.env)[0] });
    if (a.keySource === 'store') fields.push({ id: 'apiKey', label: 'Key', kind: 'secret', value: a.apiKey, problem: problems.apiKey, hint: 'Hidden as you type or paste.' });
  }
  const modelField = (id: 'fast' | 'strong', label: string, role: string): Field =>
    options ? { id, label, kind: 'select', value: a[id], options, problem: problems[id] } : { id, label, kind: 'text', value: a[id], problem: problems[id], hint: listHint ?? role };
  // One field per parameter of the chosen model (effort, speed, context), under its model.
  const paramFields = (role: 'fast' | 'strong'): Field[] => {
    const option = modelOf(a[role]);
    const params = (role === 'fast' ? a.fastParams : a.strongParams) ?? {};
    const all = option?.parameters ?? [];
    const offered = !option?.variants || findVariant(option, params);
    return all.map((p, i) => ({
      id: `${role}Param:${p.id}`,
      tight: i < all.length - 1,
      label: `  ${safe(p.label)}`,
      kind: 'choice',
      value: params[p.id] ?? '',
      options: p.values.map((v) => ({ value: v.value, label: safe(paramValueLabel(option!, p.id, v)) })),
      problem: i === all.length - 1 && !offered ? `${name} doesn't offer this combination` : undefined,
    }));
  };
  for (const [role, label, about] of [
    ['fast', 'Summaries and narration', 'A fast model: it writes the briefing and every chapter.'],
    ['strong', 'Q&A', 'A strong model: it answers your questions with ? during a tour.'],
  ] as const) {
    const params = paramFields(role);
    fields.push({ ...modelField(role, label, about), tight: params.length > 0 }, ...params);
  }

  const notes = modelNotes(a, props.env);
  return (
    <Box flexDirection="column" width={props.width} height={props.height}>
      <StepTitle width={props.width} title={name} about="Summaries and narration suit a fast model, Q&A a strong one. Enter moves on; the last Enter continues." />
      <Form
        width={props.width}
        fields={fields}
        onBack={props.onBack}
        onSubmit={props.onDone}
        onChange={(id, value) => {
          if (id === 'toolCalling') return props.onChange({ ...a, toolCalling: value === 'yes' });
          // Another model starts on its own default variant.
          // Another model starts on its own default variant. A typed one (no list) keeps the
          // variant setup started with when it is that model, so it never falls back to Max Mode.
          if (id === 'fast' || id === 'strong') {
            const option = modelOf(value);
            const params = option ? defaultParams(option) : props.startParams(id, value);
            return props.onChange({ ...a, [id]: value, [id === 'fast' ? 'fastParams' : 'strongParams']: params });
          }
          const param = /^(fast|strong)Param:(.+)$/.exec(id);
          if (param) {
            const key = param[1] === 'fast' ? 'fastParams' : 'strongParams';
            return props.onChange({ ...a, [key]: { ...a[key], [param[2]]: value } });
          }
          props.onChange({ ...a, [id]: value });
        }}
      />
      {notes.length ? (
        <Text color="yellow" wrap="truncate">
          {' '}
          {notes[0]}
        </Text>
      ) : null}
      <Box flexGrow={1} />
      <KeyBar
        accent
        width={props.width}
        keys={[
          ['↑/↓', 'field'],
          ['←/→', 'change option'],
          ['enter', 'next'],
          ['esc', 'back'],
        ]}
      />
    </Box>
  );
}

function GitHubStep(props: {
  width: number;
  height: number;
  answers: GitHubAnswers;
  ghInstalled: boolean;
  env: NodeJS.ProcessEnv;
  onChange: (g: GitHubAnswers) => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const g = props.answers;
  const problems = githubProblems(g);
  const fields: Field[] = [
    {
      id: 'method',
      label: 'Access',
      kind: 'choice',
      value: g.method,
      options: [
        { value: 'gh', label: props.ghInstalled ? 'GitHub CLI (gh): your gh login' : 'GitHub CLI (gh): I will install it' },
        { value: 'env', label: 'personal access token in an environment variable' },
        { value: 'file', label: 'personal access token in a file' },
      ],
    },
  ];
  if (g.method === 'env') fields.push({ id: 'tokenEnv', label: 'Variable', kind: 'text', value: g.tokenEnv, problem: problems.tokenEnv });
  if (g.method === 'file') fields.push({ id: 'tokenFile', label: 'Token file', kind: 'text', value: g.tokenFile, placeholder: '~/.config/guided-review/github-token', problem: problems.tokenFile });
  if (g.method !== 'gh') fields.push({ id: 'apiUrl', label: 'API URL', kind: 'text', value: g.apiUrl, problem: problems.apiUrl, hint: 'For GitHub Enterprise Server: https://<host>/api/v3' });
  const about = props.ghInstalled
    ? 'gr reads PRs and posts reviews through GitHub. gh is installed but not signed in, or your config uses a token.'
    : 'gr reads PRs and posts reviews through GitHub, and the GitHub CLI (gh) is not installed. Install it from https://cli.github.com and run gh auth login, or use a personal access token.';
  const notes = githubNotes(g, props.ghInstalled, props.env);
  return (
    <Box flexDirection="column" width={props.width} height={props.height}>
      <StepTitle width={props.width} title="GitHub access" about={about} />
      <Form width={props.width} fields={fields} onBack={props.onBack} onSubmit={props.onDone} onChange={(id, value) => props.onChange({ ...g, [id]: value })} />
      {notes.map((n) => (
        <Text key={n} color="yellow" wrap="truncate">
          {' '}
          {n}
        </Text>
      ))}
      {g.method !== 'gh' ? <Para text={TOKEN_HELP.join(' ')} width={props.width} dim marginTop={1} /> : null}
      <Box flexGrow={1} />
      <KeyBar
        accent
        width={props.width}
        keys={[
          ['↑/↓', 'field'],
          ['←/→', 'change option'],
          ['enter', 'next'],
          ['esc', 'back'],
        ]}
      />
    </Box>
  );
}

type Checks = { models?: ModelCheck[]; github?: { ok: boolean; message: string } };

function FinishStep(props: {
  width: number;
  height: number;
  firstRun: boolean;
  config: UserConfig;
  ghLogin?: string;
  replacesOverrides: boolean;
  checkModels: WizardProps['checkModels'];
  checkGitHub: WizardProps['checkGitHub'];
  onBack: () => void;
  onSave: () => void;
}) {
  const hasModel = !!agentRouting(props.config);
  const [checks, setChecks] = useState<Checks>({});
  const [round, setRound] = useState(0);
  const key = JSON.stringify(props.config);
  useEffect(() => {
    const ac = new AbortController();
    setChecks({});
    if (hasModel) void props.checkModels(props.config, ac.signal).then((models) => !ac.signal.aborted && setChecks((c) => ({ ...c, models })));
    if (props.config.github) void props.checkGitHub(props.config.github).then((github) => !ac.signal.aborted && setChecks((c) => ({ ...c, github })));
    return () => ac.abort();
    // The config is rebuilt on every render; it changes only when its contents do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, round]);
  const checking = (hasModel && !checks.models) || (!!props.config.github && !checks.github);
  const spin = useSpinner(checking);
  const failed = !!checks.models?.some((m) => !m.ok) || checks.github?.ok === false;

  useInput((input, key) => {
    if (key.escape || input === 'b') return props.onBack();
    if (input === 'r' && !checking) return setRound((r) => r + 1);
    if (key.return) return props.onSave();
  });

  const save = props.firstRun ? 'save and start' : 'save';
  return (
    <Box flexDirection="column" width={props.width} height={props.height}>
      <StepTitle width={props.width} title="Ready to save" />
      {describeUserConfig(props.config).map((l) => (
        <Text key={l} wrap="truncate">
          {'   '}
          {safe(l)}
        </Text>
      ))}
      <Text> </Text>
      {hasModel ? (
        checks.models ? (
          checks.models.map((m) =>
            m.ok ? (
              <Text key={m.model} color="green" wrap="truncate">
                {' '}
                ✓ {safe(m.model)} answered in {(m.ms / 1000).toFixed(1)}s
              </Text>
            ) : (
              <Para key={m.model} text={safe(`✗ ${m.model}: ${m.error}`)} width={props.width} color="red" />
            ),
          )
        ) : (
          <Text color="cyan"> {spin} Sending a test request to your model…</Text>
        )
      ) : (
        <Text dimColor> No model: tours use static analysis only. Run gr config to add one later.</Text>
      )}
      {props.config.github ? (
        checks.github ? (
          <Text color={checks.github.ok ? 'green' : 'red'} wrap="truncate">
            {' '}
            {checks.github.ok ? '✓' : '✗'} {safe(checks.github.message)}
          </Text>
        ) : (
          <Text color="cyan"> {spin} Signing in to GitHub with your token…</Text>
        )
      ) : props.ghLogin ? (
        <Text color="green" wrap="truncate">
          {' '}
          ✓ gh is signed in as {safe(props.ghLogin)}
        </Text>
      ) : null}
      {props.replacesOverrides ? (
        <Para text="Your config has per-task overrides set by hand (a provider, endpoint, key, or tool calling for one task); saving replaces them." width={props.width} color="yellow" />
      ) : null}
      {failed ? <Para text="Press b to go back and fix it, r to try again, or Enter to save anyway." width={props.width} dim marginTop={1} /> : null}
      <Box flexGrow={1} />
      <KeyBar
        accent
        width={props.width}
        keys={[
          ['enter', failed ? 'save anyway' : save],
          ['r', 'check again'],
          ['b', 'back'],
        ]}
      />
    </Box>
  );
}

// Runs the wizard on the alternate screen and resolves when it is saved, cancelled, or left
// for the editor. Detection starts at once, so it is usually done by the time a theme is chosen.
export async function runSetupWizard(opts: { firstRun: boolean; current?: UserConfig; problem?: string; file: string }): Promise<SetupResult> {
  // Stopped when setup closes, so probes still running don't keep gr from exiting.
  const probes = new AbortController();
  const detect = Promise.all([detectProviders({ signal: probes.signal }), detectGitHub({ signal: probes.signal }), detectCodingAgents({ signal: probes.signal })]).then(
    ([providers, github, codingAgents]) => ({ providers, github, codingAgents }),
  );
  const themes = await themeList();
  const known = opts.current?.theme && themes.some((t) => t.id === opts.current!.theme) ? opts.current.theme : TERMINAL_THEME;
  const initial = await loadPalette(known).catch(() => terminalPalette);
  let result: SetupResult = { kind: 'cancelled' };
  const app = render(
    <SetupWizard
      {...opts}
      themes={themes}
      initial={initial}
      detect={detect}
      checkModels={(config, signal) => checkModels(agentRouting(config)!, { signal })}
      checkGitHub={checkGitHubToken}
      listModels={listModels}
      onDone={(r) => {
        result = r;
        app.unmount();
      }}
    />,
    { alternateScreen: true, exitOnCtrlC: false },
  );
  // stdin stays unref'd: gr config then exits, and a tour or the editor after it takes stdin itself.
  await app.waitUntilExit();
  probes.abort();
  return result;
}
