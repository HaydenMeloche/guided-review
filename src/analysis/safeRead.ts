import fs from 'node:fs';
import path from 'node:path';

// Default cap for source files read out of a PR worktree.
const MAX_READ_BYTES = 1024 * 1024;

const inside = (root: string, p: string) => {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function realRoot(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

// Reads a repo-relative file from a worktree whose content the PR author controls.
// Returns undefined for anything that is not a plain regular file inside the root:
// symlinks (a link to ~/.aws/credentials would leak it into the tour and the prompt),
// devices and FIFOs (a link to /dev/zero would read forever), paths escaping the root
// through `..` or a symlinked parent directory, and files larger than `maxBytes`.
export function safeReadFile(root: string, rel: string, maxBytes = MAX_READ_BYTES, rootReal = realRoot(root)): string | undefined {
  if (!rel || path.isAbsolute(rel) || rel.includes('\0')) return undefined;
  const full = path.resolve(root, rel);
  if (!inside(path.resolve(root), full)) return undefined;
  let fd: number | undefined;
  try {
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink() || !st.isFile() || st.size > maxBytes) return undefined;
    // A symlinked parent directory would pass lstat on the leaf.
    if (!inside(rootReal, fs.realpathSync(full))) return undefined;
    fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const fst = fs.fstatSync(fd);
    if (!fst.isFile() || fst.size > maxBytes) return undefined;
    // Read at most maxBytes + 1 even if the file grew after the stat.
    const buf = Buffer.alloc(Math.min(fst.size, maxBytes) + 1);
    let n = 0;
    while (n < buf.length) {
      const r = fs.readSync(fd, buf, n, buf.length - n, n);
      if (r === 0) break;
      n += r;
    }
    if (n > maxBytes) return undefined;
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Memoized safeReadFile bound to one worktree.
export function safeReader(root: string, maxBytes = MAX_READ_BYTES): (rel: string) => string | undefined {
  const rootReal = realRoot(root);
  const cache = new Map<string, string | undefined>();
  return (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    const v = safeReadFile(root, rel, maxBytes, rootReal);
    cache.set(rel, v);
    return v;
  };
}
