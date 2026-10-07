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

// Opens file in $VISUAL/$EDITOR and waits for it to exit. Throws if the editor cannot be
// started or exits non-zero.
export function openInEditor(file: string): void {
  const editor = process.env.VISUAL || process.env.EDITOR || FALLBACK_EDITOR;
  const [command, ...args] = editorCommand(editor);
  const result = spawnSync(command, [...args, file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${editor} exited with status ${result.status}`);
}
