import { spawn } from 'node:child_process';

// Opens a URL or file with the platform's default handler. Resolves once the opener has
// started (its exit status means nothing: explorer exits 1 on success); rejects when it
// cannot be started, e.g. xdg-open is not installed.
export function openExternal(target: string): Promise<void> {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [target], { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
