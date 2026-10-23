import { run } from './exec.js';

// The platform's clipboard reader, in order of preference. Linux tries Wayland, then X11.
const READERS: Record<string, [string, string[]][]> = {
  darwin: [['pbpaste', []]],
  win32: [['powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard']]],
  linux: [
    ['wl-paste', ['--no-newline']],
    ['xclip', ['-o', '-selection', 'clipboard']],
  ],
};

// A small cap: a PR link is short, and the picker reads the clipboard every few seconds.
const MAX_BYTES = 16 * 1024;

let reader: [string, string[]] | null | undefined; // null: no reader works here

// The clipboard's text, '' when it is empty or too large, or undefined when this machine
// has no way to read it (the caller stops asking).
export async function readClipboard(): Promise<string | undefined> {
  const candidates = reader ? [reader] : reader === null ? [] : (READERS[process.platform] ?? []);
  for (const [cmd, args] of candidates) {
    try {
      const text = await run(cmd, args, { timeout: 2000, maxBuffer: MAX_BYTES });
      reader = [cmd, args];
      return text;
    } catch (e) {
      // Missing tool: try the next. Anything else (oversized, empty Wayland clipboard) reads as empty.
      if ((e as { code?: string }).code !== 'ENOENT') {
        reader = [cmd, args];
        return '';
      }
    }
  }
  reader = null;
  return undefined;
}

// The platform's clipboard writer, in order of preference, as with READERS.
const WRITERS: Record<string, [string, string[]][]> = {
  darwin: [['pbcopy', []]],
  win32: [['clip.exe', []]],
  linux: [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
  ],
};

let writer: [string, string[]] | null | undefined; // null: no writer works here

// Puts text on the clipboard. Without a clipboard tool (over SSH, in a container) it asks the
// terminal instead with OSC 52, which most terminals honour; 'terminal' says the copy went that
// way and may not have landed.
export async function writeClipboard(text: string, out: { write: (s: string) => unknown } = process.stdout): Promise<'tool' | 'terminal'> {
  const candidates = writer ? [writer] : writer === null ? [] : (WRITERS[process.platform] ?? []);
  for (const [cmd, args] of candidates) {
    try {
      await run(cmd, args, { input: text, timeout: 2000 });
      writer = [cmd, args];
      return 'tool';
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') throw e;
    }
  }
  writer = null;
  out.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
  return 'terminal';
}
