import { createContext, useContext } from 'react';
import { useInput as inkUseInput, type Key } from 'ink';

// Whether the screens may take keys. App turns it off while it asks a question over everything
// (the quit question), since Ink calls every active input handler: without this, the key that
// answers the question would also act on the screen or popup under it.
export const KeysLive = createContext(true);

type Handler = (input: string, key: Key) => void;

// Ink's useInput, quiet while KeysLive is off. Screens import it from here rather than from Ink.
// Ctrl+Z never reaches them: App suspends gr with it, and a screen would read it as z.
//
// Keys that reach gr together (typed fast, held down, or sent while gr is busy rendering) come
// from Ink as one input, "jjj" or "nQ", which a check like `input === 'Q'` misses. Unless the
// handler takes text (`text`, a field that inserts what is typed), it gets them one at a time.
export function useInput(handler: Handler, options?: { isActive?: boolean; text?: boolean }): void {
  const live = useContext(KeysLive);
  inkUseInput(
    (input, key) => {
      if (key.ctrl && input === 'z') return;
      if (options?.text) {
        // Text typed ahead of Enter can arrive with it ("abc\r"): the text, then Enter.
        if (input.length > 1 && input.endsWith('\r') && !input.slice(0, -1).includes('\r') && !key.return && !key.ctrl && !key.meta) {
          handler(input.slice(0, -1), key);
          return handler('\r', { ...key, return: true, shift: false });
        }
        return handler(input, key);
      }
      for (const [one, oneKey] of keypresses(input, key)) handler(one, oneKey);
    },
    { isActive: live && options?.isActive !== false },
  );
}

// The keys in one input from Ink: a run of plain characters split into one key each.
export function keypresses(input: string, key: Key): [string, Key][] {
  const plain = !key.ctrl && !key.meta && !key.escape && !key.return && !key.tab && !key.backspace && !key.delete;
  if (input.length < 2 || !plain) return [[input, key]];
  return [...input].map((ch): [string, Key] => {
    if (ch === '\r') return ['', { ...key, return: true, shift: false }];
    if (ch === '\t') return ['', { ...key, tab: true, shift: false }];
    return [ch, { ...key, shift: /[A-Z]/.test(ch) }];
  });
}
