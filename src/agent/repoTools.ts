import fs from 'node:fs/promises';
import { run, type ExecError } from '../util/exec.js';
import { git } from '../git/git.js';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// The read-only repository lookups offered to every provider that runs its own tool loop. Each
// adapter converts REPO_TOOLS into its wire format; calls come back here confined to the worktree.

const MAX_TOOL_OUTPUT = 24_000;
const READ_CHUNK = 64 * 1024;
const SEARCH_TIMEOUT_MS = 15_000;

export type ToolParameters = { type: 'object'; properties: Record<string, { type: 'string' | 'integer' }>; required: string[] };
export type RepoTool = { name: string; description: string; parameters: ToolParameters };

export const REPO_TOOLS: RepoTool[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 file in the checked-out repository.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer' }, lineCount: { type: 'integer' } }, required: ['path'] },
  },
  {
    name: 'search_repo',
    description: 'Search repository files for a regex; returns file paths and line numbers.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  },
  { name: 'git_history', description: 'Show recent commits for a repository file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

// Arguments as a provider delivered them; an Error when they were not a JSON object, which is
// reported back to the model as a tool error rather than failing the run.
export type ToolInput = Record<string, unknown> | Error;

export function toolInput(value: unknown): ToolInput {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : new Error('tool arguments must be a JSON object');
}

export function parseToolArgs(json: string | undefined): ToolInput {
  try {
    return toolInput(JSON.parse(json || '{}'));
  } catch (e) {
    return e as Error;
  }
}

async function safeFile(root: string, relative: unknown): Promise<string> {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('path must be relative to the repository');
  const base = await fs.realpath(root);
  const candidate = await fs.realpath(path.resolve(base, relative));
  if (!candidate.startsWith(base + path.sep)) throw new Error('path is outside the repository');
  return candidate;
}

// Returns lines start..start+count-1 (1-based) of a file, numbered, reading only as far as
// needed. A trailing newline yields a final empty line, as split('\n') would.
async function readLines(file: string, start: number, count: number, signal?: AbortSignal): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(READ_CHUNK);
    const out: string[] = [];
    let size = 0;
    let lineNo = 1;
    let pending = '';
    const full = () => out.length >= count || size > MAX_TOOL_OUTPUT;
    const emit = (line: string) => {
      if (lineNo >= start) {
        const numbered = `${lineNo}: ${line}`;
        out.push(numbered);
        size += numbered.length + 1;
      }
      lineNo++;
    };
    while (!full()) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, null);
      if (!bytesRead) {
        emit(pending + decoder.end());
        break;
      }
      const lines = (pending + decoder.write(buffer.subarray(0, bytesRead))).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        emit(line);
        if (full()) break;
      }
      // One very long line inside the window already fills the output.
      if (lineNo >= start && pending.length >= MAX_TOOL_OUTPUT) emit(pending);
    }
    return out.slice(0, count).join('\n').slice(0, MAX_TOOL_OUTPUT);
  } finally {
    await handle.close();
  }
}

export async function runRepoTool(root: string, name: string, input: ToolInput, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  try {
    if (input instanceof Error) throw input;
    if (name === 'read_file') {
      const file = await safeFile(root, input.path);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 2_000_000) throw new Error('file is unavailable or too large');
      const start = Math.max(1, Math.floor(Number(input.startLine) || 1));
      const count = Math.min(250, Math.max(1, Math.floor(Number(input.lineCount) || 120)));
      return await readLines(file, start, count, signal);
    }
    if (name === 'search_repo') {
      if (typeof input.pattern !== 'string' || !input.pattern || input.pattern.length > 300) throw new Error('invalid search pattern');
      // ripgrep's regex engine runs in linear time, so a pathological pattern cannot hang it;
      // the timeout bounds a search of a very large repository.
      const stdout = await run('rg', ['-n', '--max-count', '8', '--max-columns', '400', '--glob', '!.git/**', '--', input.pattern, '.'], {
        cwd: root,
        maxBuffer: 2_000_000,
        timeout: SEARCH_TIMEOUT_MS,
        signal,
      }).catch((e: ExecError) => {
        if (signal?.aborted) throw e;
        if (e.code === 1) return '';
        if (e.killed) throw new Error('search timed out');
        if (e.code === 'ENOENT') throw new Error('ripgrep (rg) is not installed');
        throw e;
      });
      return stdout.slice(0, MAX_TOOL_OUTPUT) || '(no matches)';
    }
    if (name === 'git_history') {
      const file = await safeFile(root, input.path);
      const stdout = await git(root, ['log', '--no-ext-diff', '--no-textconv', '-5', '--format=%h %s', '--', path.relative(root, file)], { maxBuffer: 100_000, signal });
      return stdout.slice(0, MAX_TOOL_OUTPUT) || '(no history)';
    }
    return 'Unknown tool';
  } catch (e) {
    if (signal?.aborted) throw e;
    return `Tool error: ${(e as Error).message}`;
  }
}

// Runs one turn's tool calls concurrently; results come back in call order.
export function runRepoTools(root: string, calls: { name: string; input: ToolInput }[], signal?: AbortSignal): Promise<string[]> {
  return Promise.all(calls.map((call) => runRepoTool(root, call.name, call.input, signal)));
}
