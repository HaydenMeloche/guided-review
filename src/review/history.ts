import type { Hunk } from '../types.js';
import { git } from '../git/git.js';

// Line history (H): the commits that last shaped the selected lines before the PR, from
// `git log -L` at the base, so "why was it like this?" has an answer without leaving gr.

export interface HistoryEntry {
  sha: string;
  author: string;
  at: number; // commit time, in seconds
  subject: string;
  pr?: number; // a PR number the subject names, as "(#123)" or "Merge pull request #123"
  patch: string; // the commit's change to these lines
}

export const HISTORY_LIMIT = 10;

// The lines to look up at the base: the selection's lines that were there before, or, for a
// selection of only added lines, the lines the hunk replaced. Undefined when there were none
// (the file is new, or the hunk only adds lines at the very top).
export function baseRange(h: Hunk, [a, b]: [number, number]): { start: number; end: number } | undefined {
  const old = h.lines
    .slice(a, b + 1)
    .map((l) => (l.kind === 'add' ? undefined : l.oldLine))
    .filter((n) => n !== undefined);
  if (old.length) return { start: Math.min(...old), end: Math.max(...old) };
  if (!h.oldLines) return h.oldStart > 0 ? { start: h.oldStart, end: h.oldStart } : undefined;
  return { start: h.oldStart, end: h.oldStart + h.oldLines - 1 };
}

const PR_IN_SUBJECT = /\(#(\d+)\)\s*$|^Merge pull request #(\d+)\b/;

// `git log -L` output with each commit starting with NUL: sha, author, time and subject on the
// first line, separated by unit separators, then its patch.
export function parseHistory(text: string): HistoryEntry[] {
  return text
    .split('\0')
    .filter((c) => c.trim())
    .map((chunk) => {
      const nl = chunk.indexOf('\n');
      const [sha, author, at, subject] = (nl < 0 ? chunk : chunk.slice(0, nl)).split('\x1f');
      const m = PR_IN_SUBJECT.exec(subject ?? '');
      const pr = m ? Number(m[1] ?? m[2]) : undefined;
      return { sha: sha.trim(), author: author ?? '', at: Number(at) || 0, subject: (subject ?? '').trim(), ...(pr ? { pr } : {}), patch: nl < 0 ? '' : chunk.slice(nl + 1).trim() };
    });
}

// The newest HISTORY_LIMIT commits that changed `path` lines start..end as they are at `base`.
export async function lineHistory(root: string, base: string, path: string, start: number, end: number, signal?: AbortSignal): Promise<HistoryEntry[]> {
  const out = await git(root, ['log', '--no-color', '--no-ext-diff', `-n${HISTORY_LIMIT}`, '--format=%x00%H%x1f%an%x1f%at%x1f%s', `-L${start},${end}:${path}`, base, '--'], {
    signal,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseHistory(out);
}
