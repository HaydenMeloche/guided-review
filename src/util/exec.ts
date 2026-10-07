import { execFile, type ExecFileException } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  input?: string;
  maxBuffer?: number;
  env?: Record<string, string>; // added to the inherited environment
  timeout?: number; // ms; the child is killed after this
  signal?: AbortSignal; // kills the child process when aborted
}

// A failed command. The message reads "<cmd> <args> failed: <stderr>"; the fields keep what
// execFile reported so callers can tell a missing binary (code 'ENOENT') or a timeout
// (killed) from a command that ran and failed.
export class ExecError extends Error {
  readonly code: number | string | undefined; // exit status, or a spawn error code like 'ENOENT'
  readonly stdout: string;
  readonly stderr: string;
  readonly killed: boolean;
  constructor(message: string, error: ExecFileException, stdout: string, stderr: string) {
    super(message, { cause: error });
    this.name = 'ExecError';
    this.code = error.code ?? undefined;
    this.stdout = stdout;
    this.stderr = stderr;
    this.killed = !!error.killed;
  }
}

// Runs a command without a shell and resolves with stdout. Rejects with an ExecError carrying
// the command's stderr in the message so callers can surface it as-is.
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env && { ...process.env, ...opts.env },
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        timeout: opts.timeout,
        encoding: 'utf8',
        signal: opts.signal,
      },
      (err, stdout, stderr) => {
        if (err) {
          const timedOut = !!opts.timeout && !!err.killed && !opts.signal?.aborted;
          const detail = (stderr || (timedOut ? `timed out after ${opts.timeout} ms` : err.message)).trim();
          reject(new ExecError(`${cmd} ${args.join(' ')} failed: ${detail}`, err, stdout, stderr));
          return;
        }
        resolve(stdout);
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}
