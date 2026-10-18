import { useCallback, useEffect } from 'react';
import { useStdout } from 'ink';
import { sanitizeTerminal } from '../util/sanitize.js';

// The window title and the tab or taskbar progress indicator, set with OSC sequences the
// terminal does not draw.

export const OSC = '\u001b]';
export const BEL = '\u0007';
// xterm's title stack (XTWINOPS 22/23): save the user's title on start and restore it on exit.
// Terminals without a stack ignore these.
const PUSH_TITLE = '\u001b[22;0t';
const POP_TITLE = '\u001b[23;0t';

export type TerminalProgress = { state: 'none' } | { state: 'busy' } | { state: 'value'; percent: number } | { state: 'error' };

export const titleSequence = (title: string) => `${OSC}0;${sanitizeTerminal(title)}${BEL}`;

// OSC 9;4 (ConEmu's progress, adopted by Windows Terminal, Ghostty, WezTerm and iTerm2):
// 0 clears, 1 sets a percentage, 2 marks an error, 3 is indeterminate.
export function progressSequence(p: TerminalProgress): string {
  if (p.state === 'value') return `${OSC}9;4;1;${Math.max(0, Math.min(100, Math.round(p.percent)))}${BEL}`;
  const code = { none: 0, error: 2, busy: 3 }[p.state];
  return `${OSC}9;4;${code};0${BEL}`;
}

// OSC 9 alone is a desktop notification in iTerm2 before 3.6 and in other terminals, so a
// progress update there would pop up "4;1;50". Only terminals known to read 9;4 get it.
// GNU screen keeps the outer terminal's TERM_PROGRAM, so it is ruled out first.
export function supportsProgress(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.STY || env.TERM?.startsWith('screen')) return false;
  if (env.WT_SESSION || env.ConEmuANSI === 'ON') return true;
  const program = env.TERM_PROGRAM;
  if (program === 'ghostty' || program === 'WezTerm') return true;
  if (program === 'iTerm.app') {
    const [major = 0, minor = 0] = (env.TERM_PROGRAM_VERSION ?? '').split('.').map(Number);
    return major > 3 || (major === 3 && minor >= 6);
  }
  return false;
}

// Keeps the title and progress indicator in step with the app while it runs, and puts the
// user's title back and clears the indicator when it exits. Does nothing unless stdout is a
// terminal, so tests and piped output never see the sequences. Returns a function that writes
// both again, for when another program has had the terminal.
export function useTerminalStatus(title: string, progress: TerminalProgress, env: NodeJS.ProcessEnv = process.env): () => void {
  const { stdout } = useStdout();
  const enabled = !!(stdout as Partial<NodeJS.WriteStream>).isTTY;
  const withProgress = enabled && supportsProgress(env);
  const titleOut = enabled ? titleSequence(title) : '';
  const progressOut = withProgress ? progressSequence(progress) : '';

  useEffect(() => {
    if (!enabled) return;
    const restore = () => stdout.write(POP_TITLE + (withProgress ? progressSequence({ state: 'none' }) : ''));
    stdout.write(PUSH_TITLE);
    // An exit that skips React's cleanup (an uncaught error) still restores the title.
    process.once('exit', restore);
    return () => {
      process.off('exit', restore);
      restore();
    };
  }, [stdout, enabled, withProgress]);

  // Keyed on the sequences, so a new progress object that writes the same bytes writes nothing.
  useEffect(() => {
    if (titleOut) stdout.write(titleOut);
  }, [stdout, titleOut]);
  useEffect(() => {
    if (progressOut) stdout.write(progressOut);
  }, [stdout, progressOut]);

  return useCallback(() => {
    if (titleOut || progressOut) stdout.write(titleOut + progressOut);
  }, [stdout, titleOut, progressOut]);
}
