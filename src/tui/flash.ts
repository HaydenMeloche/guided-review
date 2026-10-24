import { useEffect, useState } from 'react';

// A one-line message after a key press. Info ("Draft saved") is plain and fades, and so does a
// quiet note (dim: a key that does nothing here). A warning (yellow: why a key did nothing, what
// to do instead) and an error (red: a GitHub write that failed) stay until the next key press,
// so they are never missed, as does a first-run tip (cyan).

export type Tone = 'info' | 'quiet' | 'tip' | 'warn' | 'error';

export interface Flash {
  text: string;
  tone: Tone;
}

export const TONE_COLOR: Record<Tone, string | undefined> = { info: undefined, quiet: undefined, tip: 'cyan', warn: 'yellow', error: 'red' };

const INFO_MS = 2500;

// A message that says something failed reads as an error unless the caller says otherwise.
const FAILED = /\b(failed|couldn['’]t|could not|cannot reach)\b/i;

export function useFlash(): { flash?: Flash; show: (text: string, tone?: Tone) => void; dismiss: () => void } {
  const [flash, setFlash] = useState<Flash>();
  useEffect(() => {
    if (flash?.tone !== 'info' && flash?.tone !== 'quiet') return;
    const t = setTimeout(() => setFlash(undefined), INFO_MS);
    return () => clearTimeout(t);
  }, [flash]);
  return {
    flash,
    show: (text, tone) => setFlash(text ? { text, tone: tone ?? (FAILED.test(text) ? 'error' : 'warn') } : undefined),
    dismiss: () => setFlash(undefined),
  };
}

// What a key that does nothing on this screen says, so no key press goes unanswered; undefined
// for keys that are not a plain character (arrows, chords) or for a space.
export function unboundKey(input: string, key: { ctrl?: boolean; meta?: boolean }): string | undefined {
  if (key.ctrl || key.meta || input.length !== 1 || input === ' ' || input < '!' || input > '~') return undefined;
  return `no action for ${input} here · ? lists the keys`;
}
