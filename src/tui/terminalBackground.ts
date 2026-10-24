// The terminal's background, so the default palette's tints suit a light terminal as well as a
// dark one. gr asks with OSC 11 and then with DA1, which every terminal answers: once the DA1
// reply arrives, an OSC 11 reply would have come before it, so no late answer is left for the
// tour to read as keys. Failing that, COLORFGBG (set by rxvt, Konsole and others) says light or
// dark. Undefined: assume dark.

export interface Background {
  type: 'dark' | 'light';
  hex?: string;
}

const OSC11 = /\u001b\]11;rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i;
const DA1 = /\u001b\[\?[\d;]*c/;

// "rgb:ffff/ffff/ffff" components, of one to four hex digits each, as #rrggbb.
export function parseOsc11(reply: string): string | undefined {
  const m = OSC11.exec(reply);
  if (!m) return undefined;
  const byte = (h: string) =>
    Math.round((parseInt(h, 16) / (16 ** h.length - 1)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(m[1])}${byte(m[2])}${byte(m[3])}`;
}

export function typeOf(hex: string): 'dark' | 'light' {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 'light' : 'dark';
}

// COLORFGBG is "fg;bg" (sometimes "fg;default;bg"): background 7 or 15 is light.
export function fromColorFgBg(value: string | undefined): Background | undefined {
  const bg = value?.split(';').at(-1);
  if (!bg || !/^\d+$/.test(bg)) return undefined;
  return { type: bg === '7' || bg === '15' ? 'light' : 'dark' };
}

export async function detectBackground(opts: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<Background | undefined> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const env = opts.env ?? process.env;
  const fallback = fromColorFgBg(env.COLORFGBG);
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') return fallback;
  const reply = await new Promise<string>((resolve) => {
    let buf = '';
    const wasRaw = stdin.isRaw;
    const done = () => {
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(buf);
    };
    const onData = (d: Buffer) => {
      buf += d.toString('latin1');
      if (DA1.test(buf)) done();
    };
    const timer = setTimeout(done, opts.timeoutMs ?? 300);
    stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.resume();
    stdout.write('\u001b]11;?\u0007\u001b[c');
  });
  const hex = parseOsc11(reply);
  return hex ? { type: typeOf(hex), hex } : fallback;
}
