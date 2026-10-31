import { spawnSync } from 'node:child_process';

const FALLBACK_EDITOR = 'vi';

// Splits $EDITOR into argv so values like `code --wait` work without passing the file
// path through a shell.
export function editorCommand(editor: string): string[] {
  const argv: string[] = [];
  let current = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (const ch of editor.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) argv.push(current);
      current = '';
      inWord = false;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (inWord) argv.push(current);
  return argv.length ? argv : [FALLBACK_EDITOR];
}

// Editors that take the line as `file:line`, or as `--goto file:line`; the rest (vi, vim, nvim,
// nano, emacs, micro, kak, …) take `+line file`.
const COLON_LINE = new Set(['subl', 'zed', 'hx', 'helix', 'mate']);
const GOTO_LINE = new Set(['code', 'code-insiders', 'codium', 'cursor', 'windsurf']);

// The arguments that open file at line in the editor `command` names.
export function lineArgs(command: string, file: string, line: number): string[] {
  const name = command
    .split(/[\\/]/)
    .pop()!
    .replace(/\.(exe|cmd)$/i, '');
  if (GOTO_LINE.has(name)) return ['--goto', `${file}:${line}`];
  if (COLON_LINE.has(name)) return [`${file}:${line}`];
  return [`+${line}`, file];
}

// Opens file in $VISUAL/$EDITOR, at line when given, and waits for it to exit. Throws if the
// editor cannot be started or exits non-zero.
export function openInEditor(file: string, line?: number): void {
  const editor = process.env.VISUAL || process.env.EDITOR || FALLBACK_EDITOR;
  const [command, ...args] = editorCommand(editor);
  const result = spawnSync(command, [...args, ...(line === undefined ? [file] : lineArgs(command, file, line))], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${editor} exited with status ${result.status}`);
}
