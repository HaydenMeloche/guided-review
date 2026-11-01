// Backtests chapter design against real PRs. Every tour saved in a Guided Review database names a
// PR and its head; this rebuilds each one's static tour (no model) from the same diff and
// worktree the app uses, and writes its shape (the tour corpus summary: files, hunks, chapters,
// test links, flags) to one file per PR. Run it before and after a change to chapter building,
// symbol extraction or test pairing, and diff the two directories:
//
//   pnpm backtest -- --out /tmp/before          # on the baseline commit
//   pnpm backtest -- --out /tmp/after           # with the change
//   diff -r /tmp/before /tmp/after
//
// It reads GR_HOME (default .gr-dev) for the database and the cached repositories, and checks
// each PR's head out under GR_HOME/worktrees like a review does. A blobless clone fetches
// missing blobs from origin, so the first run over a repository may be slow.
//
//   --only <text>   run the PRs whose repo#number contains the text
//   --limit <n>     run at most n PRs (newest tours first)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { buildStaticTour } from '../src/pipeline.js';
import { ensureWorktree, mergeBaseOf, prDiff } from '../src/git/worktree.js';
import { repoSlug } from '../src/paths.js';
import type { PRInfo, Tour } from '../src/types.js';
import { summarize } from '../test/helpers/summarize.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

process.env.GR_HOME ??= path.resolve('.gr-dev');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const out = arg('--out');
if (!out) {
  console.error('usage: pnpm backtest -- --out <dir> [--only <text>] [--limit <n>]');
  process.exit(2);
}
const only = arg('--only');
const limit = Number(arg('--limit') ?? Infinity);

interface Saved {
  repo: string;
  pr: number;
  head: string;
  createdAt: string;
  tour: Tour;
}

function savedTours(): Saved[] {
  const file = path.join(process.env.GR_HOME!, 'gr.db');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare('SELECT repo, pr, head, created_at, tour FROM tours WHERE pr > 0 ORDER BY created_at DESC').all() as {
      repo: string;
      pr: number;
      head: string;
      created_at: string;
      tour: Uint8Array;
    }[];
    return rows.map((r) => ({ repo: r.repo, pr: r.pr, head: r.head, createdAt: r.created_at, tour: JSON.parse(gunzipSync(r.tour).toString('utf8')) as Tour }));
  } finally {
    db.close();
  }
}

function prInfo(s: Saved): PRInfo {
  const t = s.tour;
  return {
    repo: s.repo,
    number: s.pr,
    title: t.title,
    body: t.description ?? '',
    url: t.url,
    author: t.author,
    baseRef: 'base',
    headRef: 'head',
    baseSha: t.baseSha,
    headSha: t.headSha,
    commits: [],
    linkedIssues: [],
  };
}

async function main(): Promise<void> {
  fs.mkdirSync(out!, { recursive: true });
  // The latest tour of each PR, since the shape is about the code, not the head it was seen at.
  const seen = new Set<string>();
  const saved = savedTours().filter((s) => {
    const key = `${s.repo}#${s.pr}`;
    if (seen.has(key) || (only && !key.includes(only))) return false;
    seen.add(key);
    return fs.existsSync(path.join(process.env.GR_HOME!, 'repos', `${repoSlug(s.repo)}.git`));
  });
  const run = saved.slice(0, limit);
  console.log(`${run.length} PRs${saved.length > run.length ? ` of ${saved.length}` : ''}, output in ${out}`);
  let failed = 0;
  for (const s of run) {
    const name = `${repoSlug(s.repo)}-${s.pr}`;
    const started = Date.now();
    try {
      const pr = prInfo(s);
      const worktree = await ensureWorktree(pr);
      const mergeBase = (await mergeBaseOf(worktree, pr.baseSha, pr.headSha)) ?? pr.baseSha;
      const diff = await prDiff(worktree, mergeBase, pr.headSha);
      const tour = await buildStaticTour(pr, diff, worktree, () => {}, undefined, { mergeBase });
      fs.writeFileSync(path.join(out!, `${name}.tour.txt`), summarize(tour, `${s.repo}#${s.pr} ${tour.title}`));
      console.log(`${name}: ${tour.files.length} files, ${tour.chapters.length} chapters (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (error) {
      failed++;
      console.log(`${name}: failed: ${(error as Error).message.split('\n')[0]}`);
    }
  }
  if (failed) process.exitCode = 1;
}

await main();
