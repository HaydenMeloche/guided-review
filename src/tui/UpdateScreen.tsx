import { stripVTControlCharacters } from 'node:util';
import { useEffect, useRef, useState } from 'react';
import { render, useInput, useWindowSize } from 'ink';
import { Box, Text, ThemeContext } from './themed.js';
import { loadPalette, terminalPalette, type Palette } from './theme.js';
import { KeyBar } from './KeyBar.js';
import { line, MdLineView, renderMarkdown, type MdLine } from './markdown.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';
import { loadThemeSetting } from '../config.js';
import { commandLine, fetchReleaseNotes, installCommand, RELEASES_URL, runInstall, type Install, type ReleaseNotes, type UpdateOffer, type UpdateResult } from '../updateCheck.js';
import { plural } from './plural.js';
import { SCREEN_RENDER } from './renderOptions.js';

// The update offered before a tour, full screen in the user's theme: what's new since the
// installed version, then the install with its output as it runs. A failed install can be
// retried or left, carrying on with the installed version.

export interface UpdateScreenProps {
  offer: Pick<UpdateOffer, 'installed' | 'latest' | 'packageManager'>;
  initial: Palette;
  // Undefined when GitHub couldn't be reached.
  notes: Promise<ReleaseNotes[] | undefined>;
  install: Install;
  onDone: (result: UpdateResult) => void;
}

type Phase = { kind: 'offer' } | { kind: 'installing'; since: number } | { kind: 'done' } | { kind: 'failed'; why: string };

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const MAX_OUTPUT = 500;
// How long the success screen shows before gr restarts.
export const DONE_MS = 1200;
// Piped, npm prints nothing until it finishes; at the http level it logs each package it fetches.
const PROGRESS_ARGS: Partial<Record<UpdateOffer['packageManager'], string[]>> = { npm: ['--loglevel=http'] };

// One line of installer output as plain text: colour codes go whole, before the sanitizer
// would strip only their ESC and leave "[32m" behind.
const clean = (l: string) => safe(stripVTControlCharacters(l)).trimEnd();

function useSpinner(on: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(t);
  }, [on]);
  return SPIN[frame % SPIN.length];
}

// Each release's heading and notes, newest first.
export function notesLines(notes: ReleaseNotes[] | undefined, width: number): MdLine[] {
  if (!notes) return [line("Couldn't load the release notes from GitHub.", { dim: true }), line(RELEASES_URL, { dim: true })];
  if (!notes.length) return [line('No release notes were published for this version.', { dim: true }), line(RELEASES_URL, { dim: true })];
  // An empty line renders as a blank row; a line holding '' would take no height.
  return notes.flatMap((n, i): MdLine[] => [
    ...(i ? [[]] : []),
    [{ text: n.version, bold: true, color: 'cyan' }, ...(n.date ? [{ text: ` · ${n.date}`, dim: true }] : [])],
    [],
    ...(n.body.trim() ? renderMarkdown(n.body, width) : [line('No notes for this release.', { dim: true })]),
  ]);
}

export function UpdateScreen(props: UpdateScreenProps) {
  const { columns, rows } = useWindowSize();
  const { installed, latest, packageManager: pm } = props.offer;
  const [phase, setPhase] = useState<Phase>({ kind: 'offer' });
  const [notes, setNotes] = useState<ReleaseNotes[] | undefined | 'loading'>('loading');
  const [scroll, setScroll] = useState(0);
  const [output, setOutput] = useState<string[]>([]);
  const install = useRef<AbortController>(undefined);
  const restart = useRef<NodeJS.Timeout>(undefined);

  useEffect(() => {
    let live = true;
    void props.notes.then((n) => live && setNotes(n));
    return () => {
      live = false;
      install.current?.abort();
      clearTimeout(restart.current);
    };
  }, [props.notes]);

  const start = () => {
    const ac = new AbortController();
    install.current = ac;
    setPhase({ kind: 'installing', since: Date.now() });
    setOutput([]);
    let partial = '';
    let all: string[] = [];
    const [command, args] = installCommand(pm);
    void props
      .install(
        command,
        [...args, ...(PROGRESS_ARGS[pm] ?? [])],
        (chunk) => {
          const parts = (partial + chunk.replace(/\r\n?/g, '\n')).split('\n');
          partial = parts.pop() ?? '';
          const done = parts.map(clean).filter(Boolean);
          if (!done.length) return;
          all = [...all, ...done].slice(-MAX_OUTPUT);
          setOutput(all);
        },
        ac.signal,
      )
      .then((r) => {
        if (ac.signal.aborted) return;
        if (clean(partial)) {
          all = [...all, clean(partial)].slice(-MAX_OUTPUT);
          setOutput(all);
        }
        if (!r.error && r.status === 0) {
          setPhase({ kind: 'done' });
          // The http-level lines are progress; the summary after them is what's worth keeping.
          const summary = all.filter((l) => !/^npm http /.test(l));
          restart.current = setTimeout(() => props.onDone({ kind: 'updated', output: summary }), DONE_MS);
          return;
        }
        setPhase({ kind: 'failed', why: r.error ? r.error.message : `${command} exited with code ${r.status}` });
      });
  };

  const width = Math.min(columns - 4, 100);
  const height = rows - 2;
  // Title, status, about, the box's label, and the gaps between them; the key bar below.
  const boxHeight = Math.max(3, height - 7);
  const inner = boxHeight - 2;
  const lines: MdLine[] =
    phase.kind === 'offer'
      ? notes === 'loading'
        ? []
        : notesLines(notes, width - 4)
      : output.length
        ? output.slice(-inner).map((l) => line(l, { dim: true }))
        : [line('Waiting for output…', { dim: true })];
  const maxScroll = Math.max(0, lines.length - inner);
  const top = phase.kind === 'offer' ? Math.min(scroll, maxScroll) : 0;
  // Also redraws the elapsed time while installing, so a quiet installer doesn't look stuck.
  const spin = useSpinner(phase.kind === 'installing' || notes === 'loading');

  useInput((input, key) => {
    // Stopping a global install halfway can leave gr missing, so it always runs to the end.
    if (phase.kind === 'installing' || phase.kind === 'done') return;
    if (key.ctrl && input === 'c') return props.onDone({ kind: 'quit' });
    if (phase.kind === 'failed') {
      if (input === 'r') return start();
      if (key.return || key.escape || input === 'q') return props.onDone({ kind: 'failed', why: phase.why });
      return;
    }
    if (key.return || input === 'y') return start();
    if (input === 'n' || input === 'q' || key.escape) return props.onDone({ kind: 'later' });
    if (input === 's') return props.onDone({ kind: 'skip' });
    const page = Math.max(1, inner - 2);
    if (key.downArrow || input === 'j') setScroll(Math.min(top + 1, maxScroll));
    if (key.upArrow || input === 'k') setScroll(Math.max(top - 1, 0));
    if (key.pageDown || input === ' ') setScroll(Math.min(top + page, maxScroll));
    if (key.pageUp) setScroll(Math.max(top - page, 0));
  });

  let status;
  let about;
  let boxTitle;
  let keys: [string, string][];
  if (phase.kind === 'offer') {
    status = (
      <Text wrap="truncate">
        <Text bold> Update available </Text>
        <Text dimColor>{installed} → </Text>
        <Text color="green" bold>
          {latest}
        </Text>
      </Text>
    );
    about = `Runs ${commandLine(pm)}, then restarts gr.`;
    boxTitle = "What's new";
    keys = [['enter', 'update now'], ['n', 'not now'], ['s', 'skip this version'], ...(maxScroll ? ([['↑↓', 'scroll']] as [string, string][]) : [])];
  } else if (phase.kind === 'installing') {
    status = (
      <Text color="cyan" wrap="truncate">
        {' '}
        {spin} Installing {latest} with {pm}… <Text dimColor>{Math.floor((Date.now() - phase.since) / 1000)}s</Text>
      </Text>
    );
    about = `${commandLine(pm)} · gr restarts when it's done`;
    boxTitle = `${pm} output`;
    keys = [];
  } else if (phase.kind === 'done') {
    status = (
      <Text color="green" wrap="truncate">
        {' '}
        ✓ Updated to {latest}. Restarting gr…
      </Text>
    );
    about = commandLine(pm);
    boxTitle = `${pm} output`;
    keys = [];
  } else {
    status = (
      <Text color="red" wrap="truncate">
        {' '}
        ✗ Couldn't install {latest}: {safe(phase.why)}
      </Text>
    );
    about = `Try again, or run ${commandLine(pm)} yourself later.`;
    boxTitle = `${pm} output`;
    keys = [
      ['enter', `continue with ${installed}`],
      ['r', 'try again'],
    ];
  }

  const below = lines.length - top - inner;
  return (
    <ThemeContext value={props.initial}>
      <Box flexDirection="column" width={columns} height={rows} backgroundColor={props.initial.bg} paddingX={1} paddingY={1} alignItems="center">
        <Box flexDirection="column" width={width} height={height}>
          <Text color="cyan" bold wrap="truncate">
            {' '}
            ↗ Guided Review
          </Text>
          <Text> </Text>
          {status}
          <Text dimColor wrap="truncate">
            {' '}
            {about}
          </Text>
          <Text> </Text>
          <Text wrap="truncate">
            <Text bold> {boxTitle}</Text>
            <Text dimColor>{phase.kind === 'offer' && below > 0 ? ` · ${plural(below, 'more line')}` : ''}</Text>
          </Text>
          <Box flexDirection="column" width={width} height={boxHeight} borderStyle="round" borderColor="gray" paddingX={1}>
            {phase.kind === 'offer' && notes === 'loading' ? (
              <Text color="cyan"> {spin} Loading the release notes…</Text>
            ) : (
              lines.slice(top, top + inner).map((l, i) => <MdLineView key={top + i} line={l} />)
            )}
          </Box>
          <Box flexGrow={1} />
          <KeyBar accent width={width} keys={keys} />
        </Box>
      </Box>
    </ThemeContext>
  );
}

// Runs the update screen on the alternate screen and resolves with what the user chose. The
// release notes load in the background; installing waits on nothing but the user.
export async function runUpdateScreen(offer: UpdateOffer): Promise<UpdateResult> {
  const ac = new AbortController();
  const notes = fetchReleaseNotes(offer.installed, offer.latest, fetch, AbortSignal.any([ac.signal, AbortSignal.timeout(5000)]));
  let initial = terminalPalette;
  try {
    const theme = loadThemeSetting();
    if (theme) initial = await loadPalette(theme);
  } catch {
    // a config gr can't read is reported once the tour starts; the update screen uses the terminal's colors
  }
  let result: UpdateResult = { kind: 'later' };
  const app = render(
    <UpdateScreen
      offer={offer}
      initial={initial}
      notes={notes}
      install={runInstall}
      onDone={(r) => {
        result = r;
        app.unmount();
      }}
    />,
    { ...SCREEN_RENDER, exitOnCtrlC: false },
  );
  await app.waitUntilExit();
  ac.abort();
  return result;
}
