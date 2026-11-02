import type { RenderOptions } from 'ink';

// How every full-screen command renders. The kitty keyboard protocol, in terminals that speak it,
// tells Shift+Enter from Enter and a bare Esc from the start of an Alt chord; incremental
// rendering repaints only the rows that changed, which keeps tmux and SSH sessions from flickering.
// GR_KITTY_KEYBOARD=enabled or disabled overrides the detection, for a terminal that answers it
// wrongly (and for tests, whose headless terminal does not answer).
const kittyMode = process.env.GR_KITTY_KEYBOARD === 'enabled' || process.env.GR_KITTY_KEYBOARD === 'disabled' ? process.env.GR_KITTY_KEYBOARD : 'auto';

// Ink asks the terminal about the kitty protocol as soon as render() is called, before useInput
// turns raw mode on. A terminal that answers at once would have its reply echoed onto the screen,
// as "^[[?0u" in the top-left corner. Call this before render(): with raw mode on from the start,
// the reply is not echoed, and Ink reads it as it would any key. Ink turns raw mode off on unmount.
//
// A question asked on the terminal first (readline, as gr review's "[Y/n]") leaves stdin paused,
// and Ink's reader does not wake a paused stdin: gr would read no keys, and exit once nothing else
// kept it running. So stdin is resumed here, for Ink to read.
export function holdTerminalInput(): void {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  if (process.stdin.isPaused()) process.stdin.resume();
}

export const SCREEN_RENDER: RenderOptions = {
  alternateScreen: true,
  kittyKeyboard: { mode: kittyMode, flags: ['disambiguateEscapeCodes'] },
  incrementalRendering: true,
};
