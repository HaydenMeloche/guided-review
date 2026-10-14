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
