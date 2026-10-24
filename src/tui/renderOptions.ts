import type { RenderOptions } from 'ink';

// How every full-screen command renders. The kitty keyboard protocol, in terminals that speak it,
// tells Shift+Enter from Enter and a bare Esc from the start of an Alt chord; incremental
// rendering repaints only the rows that changed, which keeps tmux and SSH sessions from flickering.
// GR_KITTY_KEYBOARD=enabled or disabled overrides the detection, for a terminal that answers it
// wrongly (and for tests, whose headless terminal does not answer).
const kittyMode = process.env.GR_KITTY_KEYBOARD === 'enabled' || process.env.GR_KITTY_KEYBOARD === 'disabled' ? process.env.GR_KITTY_KEYBOARD : 'auto';

export const SCREEN_RENDER: RenderOptions = {
  alternateScreen: true,
  kittyKeyboard: { mode: kittyMode, flags: ['disambiguateEscapeCodes'] },
  incrementalRendering: true,
};
