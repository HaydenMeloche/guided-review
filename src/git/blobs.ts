import { spawn } from 'node:child_process';

// Batched reads of file contents at one revision.
//
// One `git show` per file costs a process each, and in a blobless clone each one also
// fetches its blob over the network on its own. Here the blob ids come from one `ls-tree`,
// the missing ones are fetched in one `git fetch`, and the contents are read through one
// `git cat-file --batch` process.

export interface ReadBlobsOptions {
  maxBytes?: number; // per file; larger blobs read as undefined
  maxTotalBytes?: number; // across the call; blobs past this read as undefined
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL = 256 * 1024 * 1024;
const LS_TREE_CHUNK = 64 * 1024; // bytes of path arguments per ls-tree call

interface GitResult {
  stdout: Buffer;
  code: number;
}

function gitRaw(cwd: string, args: string[], opts: { input?: string; env?: Record<string, string>; signal?: AbortSignal } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, ...opts.env }, signal: opts.signal, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout: Buffer.concat(chunks), code: code ?? 1 }));
    child.stdin.on('error', () => undefined); // git exited before reading all input
    child.stdin.end(opts.input ?? '');
  });
}

// path -> blob id at rev, for the paths that are regular blobs there.
async function blobIds(cwd: string, rev: string, paths: string[], signal?: AbortSignal): Promise<Map<string, string>> {
  const wanted = new Set(paths);
  const ids = new Map<string, string>();
  const chunks: string[][] = [[]];
  let size = 0;
  for (const p of wanted) {
    if (size + p.length > LS_TREE_CHUNK && chunks[chunks.length - 1].length) {
      chunks.push([]);
      size = 0;
    }
    chunks[chunks.length - 1].push(p);
    size += p.length + 1;
  }
  for (const chunk of chunks) {
    if (!chunk.length) continue;
    const { stdout, code } = await gitRaw(cwd, ['ls-tree', '-z', '--full-tree', rev, '--', ...chunk], { env: { GIT_LITERAL_PATHSPECS: '1' }, signal });
    if (code !== 0) continue;
    for (const entry of stdout.toString('utf8').split('\0')) {
      // <mode> SP <type> SP <oid> TAB <path>
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      const [, type, oid] = entry.slice(0, tab).split(' ');
      const p = entry.slice(tab + 1);
      if (type === 'blob' && wanted.has(p)) ids.set(p, oid);
    }
  }
  return ids;
}

// oid -> size for present blobs; oids that are not in the local object store are left out.
async function blobSizes(cwd: string, oids: string[], signal?: AbortSignal): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (!oids.length) return sizes;
  // GIT_NO_LAZY_FETCH: report missing objects instead of fetching them one at a time.
  const { stdout } = await gitRaw(cwd, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    input: oids.join('\n') + '\n',
    env: { GIT_NO_LAZY_FETCH: '1' },
    signal,
  });
  for (const line of stdout.toString('utf8').split('\n')) {
    const [oid, type, size] = line.split(' ');
    if (type === 'blob') sizes.set(oid, Number(size));
  }
  return sizes;
}

async function promisorRemote(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  const { stdout } = await gitRaw(cwd, ['config', '--get-regexp', '^(remote\\..*\\.promisor|extensions\\.partialclone)$'], { signal });
  for (const line of stdout.toString('utf8').split('\n')) {
    const [key, value] = [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1).trim()];
    if (key.toLowerCase() === 'extensions.partialclone' && value) return value;
    const m = key.match(/^remote\.(.+)\.promisor$/i);
    if (m && value === 'true') return m[1];
  }
  return undefined;
}

// Fetches blobs a partial clone does not have yet, in one request: the same command Git's
// own lazy fetch runs, but for every missing blob at once.
async function prefetch(cwd: string, oids: string[], signal?: AbortSignal): Promise<void> {
  const remote = await promisorRemote(cwd, signal);
  if (!remote) return;
  await gitRaw(cwd, ['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--filter=blob:none', '--stdin', remote], {
    input: oids.join('\n') + '\n',
    signal,
  });
}

async function catBlobs(cwd: string, oids: string[], signal?: AbortSignal): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!oids.length) return out;
  const { stdout } = await gitRaw(cwd, ['cat-file', '--batch'], { input: oids.join('\n') + '\n', env: { GIT_NO_LAZY_FETCH: '1' }, signal });
  let pos = 0;
  while (pos < stdout.length) {
    const nl = stdout.indexOf(10, pos);
    if (nl < 0) break;
    const [oid, type, size] = stdout.toString('utf8', pos, nl).split(' ');
    pos = nl + 1;
    if (type === 'missing' || size === undefined) continue;
    const n = Number(size);
    if (type === 'blob') out.set(oid, stdout.toString('utf8', pos, pos + n));
    pos += n + 1; // contents, then a newline
  }
  return out;
}

// Contents of `paths` at `rev` in the repository (or worktree) at `cwd`. Paths that do
// not exist at rev, are not regular blobs, exceed the size caps, or cannot be read come
// back as undefined. Only an abort rejects.
export async function readBlobs(cwd: string, rev: string, paths: string[], signal?: AbortSignal, opts: ReadBlobsOptions = {}): Promise<Map<string, string | undefined>> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxTotal = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL;
  const result = new Map<string, string | undefined>(paths.map((p) => [p, undefined]));
  if (!paths.length) return result;
  try {
    const ids = await blobIds(cwd, rev, paths, signal);
    const oids = [...new Set(ids.values())];
    const sizes = await blobSizes(cwd, oids, signal);
    const missing = oids.filter((o) => !sizes.has(o));
    if (missing.length) {
      await prefetch(cwd, missing, signal).catch((e) => {
        if (signal?.aborted) throw e;
      });
      for (const [oid, size] of await blobSizes(cwd, missing, signal)) sizes.set(oid, size);
    }
    let total = 0;
    const read: string[] = [];
    for (const oid of oids) {
      const size = sizes.get(oid);
      if (size === undefined || size > maxBytes || total + size > maxTotal) continue;
      total += size;
      read.push(oid);
    }
    const contents = await catBlobs(cwd, read, signal);
    for (const [p, oid] of ids) result.set(p, contents.get(oid));
  } catch {
    // Unreadable: callers treat undefined as "no base version". An abort still rejects below.
  }
  signal?.throwIfAborted();
  return result;
}

// ---------- Cached single-file reads for the TUI ----------

const CACHE_LIMIT = 64 * 1024 * 1024; // bytes of cached file contents
const cache = new Map<string, { value: Promise<string | undefined>; size: number }>();
let cacheBytes = 0;
const pending = new Map<string, { worktree: string; rev: string; paths: Map<string, { resolve: (v: string | undefined) => void }[]> }>();

const cacheKey = (worktree: string, rev: string, file: string) => `${worktree}\0${rev}\0${file}`;

function remember(key: string, value: Promise<string | undefined>, size = 0) {
  const old = cache.get(key);
  if (old) {
    cacheBytes -= old.size;
    cache.delete(key);
  }
  cache.set(key, { value, size });
  cacheBytes += size;
  for (const [k, v] of cache) {
    if (cacheBytes <= CACHE_LIMIT) break;
    cache.delete(k);
    cacheBytes -= v.size;
  }
}

function flush(groupKey: string) {
  const group = pending.get(groupKey);
  pending.delete(groupKey);
  if (!group) return;
  const paths = [...group.paths.keys()];
  readBlobs(group.worktree, group.rev, paths).then(
    (contents) => {
      for (const [p, waiters] of group.paths) {
        const text = contents.get(p);
        const key = cacheKey(group.worktree, group.rev, p);
        const entry = cache.get(key);
        if (entry) {
          cacheBytes += (text?.length ?? 0) - entry.size;
          entry.size = text?.length ?? 0;
        }
        for (const w of waiters) w.resolve(text);
      }
    },
    () => {
      for (const [p, waiters] of group.paths) {
        cache.delete(cacheKey(group.worktree, group.rev, p));
        for (const w of waiters) w.resolve(undefined);
      }
    },
  );
}

// The contents of `file` at `rev`, for display (the base side of a hunk). Results are cached
// in memory, and reads requested in the same tick share one `cat-file --batch` process.
// Resolves undefined when the file does not exist at rev, is over 2 MB, or cannot be read.
export function readBase(worktree: string, rev: string, file: string): Promise<string | undefined> {
  const key = cacheKey(worktree, rev, file);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // move to the most recently used end
    cache.set(key, hit);
    return hit.value;
  }
  const groupKey = `${worktree}\0${rev}`;
  let group = pending.get(groupKey);
  if (!group) {
    group = { worktree, rev, paths: new Map() };
    pending.set(groupKey, group);
    setImmediate(() => flush(groupKey));
  }
  const waiters = group.paths.get(file) ?? [];
  group.paths.set(file, waiters);
  const value = new Promise<string | undefined>((resolve) => waiters.push({ resolve }));
  remember(key, value);
  return value;
}

// Seeds readBase's cache with contents already read (the pipeline reads every changed
// file's base version), so the TUI's first views need no git process.
export function primeBaseCache(worktree: string, rev: string, contents: Map<string, string | undefined>): void {
  for (const [file, text] of contents) remember(cacheKey(worktree, rev, file), Promise.resolve(text), text?.length ?? 0);
}

export function clearBaseCache(): void {
  cache.clear();
  cacheBytes = 0;
}
