// The terminal's background, so the default palette's tints suit a light terminal as well as a
// dark one. gr asks with OSC 11 and then with DA1, which every terminal answers: once the DA1
// reply arrives, an OSC 11 reply would have come before it. Startup waits for that only so long
// (300 ms). When the answer is slower than that, over SSH or mosh, it would reach the screens as
// keys (Esc, ], 1, 1, ;, r, g, b, …), so for a few seconds after giving up gr strips any OSC 11
// or DA1 reply from what stdin.read() returns (`swallowLateReply`), until the DA1 reply has gone
// by. Failing an answer, COLORFGBG (set by rxvt, Konsole and others) says light or dark.
// Undefined: assume dark.

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
    const done = (late?: boolean) => {
      clearTimeout(timer);
      if (late) swallowLateReply(stdin, buf, LATE_REPLY_MS);
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(buf);
    };
    const onData = (d: Buffer) => {
      buf += d.toString('latin1');
      if (DA1.test(buf)) done();
    };
    const timer = setTimeout(() => done(true), opts.timeoutMs ?? 300);
    stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.resume();
    stdout.write('\u001b]11;?\u0007\u001b[c');
  });
  const hex = parseOsc11(reply);
  return hex ? { type: typeOf(hex), hex } : fallback;
}

// How long after giving up a late reply is still stripped from input.
const LATE_REPLY_MS = 5000;
// A reply, whole: OSC 11 ended by BEL or ST, or DA1.
const REPLY = /\u001b\]11;[^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[\?[\d;]*c/g;
// The start of a reply cut off at the end of a chunk. No key sends ESC ] or ESC [ ?.
const REPLY_START = /(?:\u001b\][^\u0007\u001b]*\u001b?|\u001b\[\?[\d;]*)$/;

// Takes the late reply out of input text. `held` is a reply's start cut off at the end of the last
// chunk; `over` says the DA1 reply, the answer's end, has gone by.
export function stripReply(held: string, text: string): { text: string; held: string; over: boolean } {
  const all = held + text;
  const over = DA1.test(all);
  const stripped = all.replace(REPLY, '');
  const cut = REPLY_START.exec(stripped);
  return cut ? { text: stripped.slice(0, cut.index), held: cut[0], over } : { text: stripped, held: '', over };
}

// Wraps stdin.read, which Ink reads input with, to strip a late answer for `ms`, or until it has
// all gone by. `seen` is what had arrived of it before the timeout.
export function swallowLateReply(stdin: NodeJS.ReadStream, seen: string, ms: number): void {
  if (DA1.test(seen)) return;
  const read = stdin.read.bind(stdin);
  const own = Object.hasOwn(stdin, 'read');
  let held = REPLY_START.exec(seen.replace(REPLY, ''))?.[0] ?? '';
  const restore = () => {
    clearTimeout(timer);
    if (stdin.read !== filtered) return;
    if (own) stdin.read = read;
    else Reflect.deleteProperty(stdin, 'read');
  };
  const filtered = ((size?: number) => {
    const chunk = read(size) as string | Buffer | null;
    if (chunk === null) return chunk;
    const isBuffer = typeof chunk !== 'string';
    const out = stripReply(held, isBuffer ? chunk.toString('latin1') : chunk);
    held = out.held;
    if (out.over) restore();
    return isBuffer ? Buffer.from(out.text, 'latin1') : out.text;
  }) as typeof stdin.read;
  const timer = setTimeout(restore, ms);
  timer.unref?.();
  stdin.read = filtered;
}
