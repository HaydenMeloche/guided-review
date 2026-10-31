import type { Chapter, Hunk, Tour } from '../types.js';
import { git } from '../git/git.js';

// Reading a PR one commit at a time (H): which of the tour's hunks each commit made. A hunk
// belongs to a commit that added or removed one of its changed lines, matched by text, so it
// holds when later commits move the lines. A hunk with no line matched (only trivial lines,
// or text a later commit rewrote) belongs to every commit that touched its file, so none is lost.

export interface CommitHunks {
  sha: string; // WORKING_TREE for a preview's uncommitted changes
  subject: string;
  additions: number;
  deletions: number;
  hunkIds: string[]; // the tour's hunks it made, in the tour's order
}

export const WORKING_TREE = 'working-tree';

interface Patch {
  sha: string;
  subject: string;
  additions: number;
  deletions: number;
  files: Map<string, { add: Set<string>; del: Set<string> }>;
}

// A line worth matching on: some text, not a lone brace or a blank.
const key = (text: string) => {
  const t = text.trim();
  return t.length >= 3 && /\w\w/.test(t) ? t : undefined;
};

// `git log -p` output, each commit starting with NUL, its sha, a unit separator and its subject.
// Without a header (a plain `git diff`), the whole text is one patch named `sha`.
export function parsePatches(text: string, sha?: string, subject = ''): Patch[] {
  const chunks = sha ? [`${sha}\x1f${subject}\n${text}`] : text.split('\0').filter((c) => c.trim());
  return chunks.map((chunk) => {
    const nl = chunk.indexOf('\n');
    const [id, title = ''] = chunk.slice(0, nl < 0 ? undefined : nl).split('\x1f');
    const p: Patch = { sha: id.trim(), subject: title.trim(), additions: 0, deletions: 0, files: new Map() };
    let file: { add: Set<string>; del: Set<string> } | undefined;
    let from = '';
    for (const line of nl < 0 ? [] : chunk.slice(nl + 1).split('\n')) {
      if (line.startsWith('diff --git ')) {
        file = undefined;
        from = '';
      } else if (!file && line.startsWith('--- ')) {
        // A file's headers come before its changes, so a removed line reading "-- x" is a change.
        from = line.slice(4).replace(/^a\//, '');
      } else if (!file && line.startsWith('+++ ')) {
        const to = line.slice(4).replace(/^b\//, '');
        const path = to === '/dev/null' ? from : to;
        if (!p.files.has(path)) p.files.set(path, { add: new Set(), del: new Set() });
        file = p.files.get(path);
      } else if (file && line.startsWith('+')) {
        p.additions++;
        const k = key(line.slice(1));
        if (k) file.add.add(k);
      } else if (file && line.startsWith('-')) {
        p.deletions++;
        const k = key(line.slice(1));
        if (k) file.del.add(k);
      }
    }
    return p;
  });
}

// The tour's hunks under each patch, patches in the order given.
export function commitHunks(tour: Pick<Tour, 'hunks' | 'chapters'>, patches: Patch[]): CommitHunks[] {
  // The tour's reading order, so a commit's hunks list as the tour reads them.
  const order = [...new Set(tour.chapters.flatMap((c) => c.hunkIds))];
  const hunks = order.map((id) => tour.hunks[id]).filter((h): h is Hunk => !!h);
  const owners = new Map<string, Set<string>>();
  for (const h of hunks) {
    const paths = [h.file, ...(h.oldFile ? [h.oldFile] : [])];
    const changes = h.lines.filter((l) => l.kind !== 'ctx' && !l.expanded);
    const touching = patches.filter((p) => paths.some((f) => p.files.has(f)));
    const matched = touching.filter((p) =>
      changes.some((l) => {
        const k = key(l.text);
        return k && paths.some((f) => (l.kind === 'add' ? p.files.get(f)?.add : p.files.get(f)?.del)?.has(k));
      }),
    );
    owners.set(h.id, new Set((matched.length ? matched : touching).map((p) => p.sha)));
  }
  return patches.map((p) => ({ sha: p.sha, subject: p.subject, additions: p.additions, deletions: p.deletions, hunkIds: hunks.filter((h) => owners.get(h.id)?.has(p.sha)).map((h) => h.id) }));
}

// Each commit of the tour, oldest first, with the hunks it made; for a preview of the working
// tree, its uncommitted changes last. Commits that made none of the tour's hunks (a merge of the
// base, say) are left out.
export async function readCommitHunks(root: string, tour: Pick<Tour, 'hunks' | 'chapters' | 'baseSha' | 'headSha'>, workingTree: boolean): Promise<CommitHunks[]> {
  const log = await git(root, ['log', '--reverse', '--no-color', '--no-ext-diff', '--format=%x00%H%x1f%s', '-p', `${tour.baseSha}..${tour.headSha}`], { maxBuffer: 256 * 1024 * 1024 });
  const patches = parsePatches(log);
  if (workingTree) {
    const uncommitted = await git(root, ['diff', '--no-color', '--no-ext-diff', 'HEAD'], { maxBuffer: 256 * 1024 * 1024 });
    if (uncommitted.trim()) patches.push(...parsePatches(uncommitted, WORKING_TREE, 'Uncommitted changes'));
  }
  const out = commitHunks(tour, patches);
  if (workingTree) {
    // Untracked files are in the tour but in no diff above: they are uncommitted too.
    const claimed = new Set(out.flatMap((c) => c.hunkIds));
    const order = [...new Set(tour.chapters.flatMap((c) => c.hunkIds))];
    const orphans = order.filter((id) => tour.hunks[id] && !claimed.has(id));
    if (orphans.length) {
      let wt = out.find((c) => c.sha === WORKING_TREE);
      if (!wt) out.push((wt = { sha: WORKING_TREE, subject: 'Uncommitted changes', additions: 0, deletions: 0, hunkIds: [] }));
      const mine = new Set([...wt.hunkIds, ...orphans]);
      wt.hunkIds = order.filter((id) => mine.has(id));
    }
  }
  return out.filter((c) => c.hunkIds.length);
}

// Commit order (f): the tour's chapters as its commits, oldest first, each titled by its subject.
// A hunk more than one commit made is read once, under the first, so progress adds up; hunks no
// commit claims end up in a last chapter of their own.
export function commitChapters(tour: Pick<Tour, 'hunks' | 'chapters'>, commits: CommitHunks[]): Chapter[] {
  const seen = new Set<string>();
  const chapter = (id: string, title: string, summary: string, hunkIds: string[]): Chapter => ({
    id,
    kind: 'supporting',
    title,
    summary,
    risk: Math.max(0, ...hunkIds.map((h) => tour.hunks[h]?.risk ?? 0)) as Chapter['risk'],
    hunkIds,
    linkedHunkIds: [],
    orphanReasons: {},
    untestedBranches: [],
    collapsed: false,
    optional: hunkIds.length > 0 && hunkIds.every((h) => tour.hunks[h]?.importOnly),
  });
  const out = commits.flatMap((c, i) => {
    const ids = c.hunkIds.filter((id) => !seen.has(id));
    for (const id of ids) seen.add(id);
    const where = c.sha === WORKING_TREE ? 'Not committed yet' : `Commit ${i + 1} of ${commits.length} · ${c.sha.slice(0, 7)} · +${c.additions} −${c.deletions}`;
    return ids.length ? [chapter(`commit-${c.sha.slice(0, 12)}`, c.subject, where, ids)] : [];
  });
  const rest = [...new Set(tour.chapters.flatMap((c) => c.hunkIds))].filter((id) => tour.hunks[id] && !seen.has(id));
  if (rest.length) out.push(chapter('commit-rest', 'Other changes', 'Changes no commit could be matched to.', rest));
  return out;
}
