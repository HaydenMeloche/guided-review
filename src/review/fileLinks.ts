import { readBlobs } from '../git/blobs.js';
import { fetchCommit, hasCommit } from '../git/worktree.js';
import { safeReadFile } from '../analysis/safeRead.js';
import { escapeRe } from '../util/regex.js';

// Links in review comments to files in the PR's own repository, such as the permalinks gr posts
// for code references: https://github.com/o/r/blob/<ref>/src/x.ts#L10-L20. Links to other
// repositories are left alone: gr only reads the checkout it has.

export interface FileLink {
  url: string;
  ref: string; // a commit or branch name, the URL's first segment after /blob/
  path: string;
  startLine?: number;
  endLine?: number;
}

export function findFileLinks(text: string, opts: { host: string; repo: string }): FileLink[] {
  const re = new RegExp(`https?://${escapeRe(opts.host)}/${escapeRe(opts.repo)}/blob/([^/\\s)\\]>]+)/([^\\s#)\\]>?]+)(?:\\?[^\\s#)\\]>]*)?(?:#L(\\d+)(?:-L(\\d+))?)?`, 'gi');
  const out: FileLink[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) {
    let path: string;
    try {
      path = decodeURIComponent(m[2]).replace(/[.,;:]+$/, '');
    } catch {
      continue;
    }
    if (!path || path.split('/').some((p) => p === '..' || p === '.' || p === '')) continue;
    const url = m[0].replace(/[.,;:]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    const start = m[3] ? Number(m[3]) : undefined;
    const end = m[4] ? Number(m[4]) : undefined;
    out.push({ url, ref: m[1], path, ...(start ? { startLine: start } : {}), ...(start && end && end > start ? { endLine: end } : {}) });
  }
  return out;
}

export interface LinkedFile {
  text?: string; // undefined: unreadable
  at: string; // the commit or ref shown
  note?: string;
}

// The linked file as the link means it: at the link's commit, fetched if this clone lacks it;
// a branch name or a commit gone after a force push falls back to the PR head.
export async function readLinkedFile(worktree: string, link: FileLink, headSha: string, signal?: AbortSignal): Promise<LinkedFile> {
  // The head is what the checkout holds.
  if (link.ref === headSha) {
    const text = safeReadFile(worktree, link.path);
    return text !== undefined ? { text, at: headSha } : { at: headSha, note: `${link.path} can't be read at the PR head` };
  }
  const isSha = /^[0-9a-f]{7,40}$/i.test(link.ref);
  if (isSha) {
    if (!(await hasCommit(worktree, link.ref, signal))) await fetchCommit(worktree, link.ref, signal).catch(() => undefined);
    const text = (await readBlobs(worktree, link.ref, [link.path], signal)).get(link.path);
    if (text !== undefined) return { text, at: link.ref };
  }
  const head = safeReadFile(worktree, link.path);
  const why = isSha ? `${link.ref.slice(0, 8)} isn't available` : `the link names ${link.ref}`;
  if (head !== undefined) return { text: head, at: headSha, note: `${why}; shown at the PR head` };
  return { at: link.ref, note: `${link.path} can't be read at ${isSha ? link.ref.slice(0, 8) : link.ref} or at the PR head` };
}
