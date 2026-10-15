import fs from 'node:fs';
import { fetchPR } from './github/gh.js';
import { encodeSharedTour, postSharedTour, shareableTour, SharedTourTooLargeError } from './github/sharedTour.js';
import { ensureWorktree } from './git/worktree.js';
import { runPipeline } from './pipeline.js';
import type { AgentRouting } from './agent/types.js';
import type { PRInfo, Tour } from './types.js';

export interface BuildOptions {
  target: { repo: string; number: number };
  agent?: AgentRouting;
  noAgent: boolean;
  fresh: boolean;
  localRepo?: string;
  out?: string; // write the tour JSON here ("-" for stdout)
  comment: boolean; // post the tour to the PR
  command: string; // how readers open it, shown in the comment
  log: (line: string) => void;
}

// Builds a PR's tour without the TUI (in CI, say) and shares it: as a file, as a PR comment, or both.
export async function buildTour(opts: BuildOptions): Promise<Tour> {
  const { target, log } = opts;
  const pr = await fetchPR(target.repo, target.number);
  log(`Building the tour of ${pr.repo}#${pr.number} at ${pr.headSha.slice(0, 8)}`);
  const worktree = await ensureWorktree(pr, { localRepo: opts.localRepo });
  const { Store } = await import('./store/db.js');
  const store = new Store();
  let tour: Tour;
  try {
    tour = await runPipeline({
      pr,
      worktree,
      store,
      agent: opts.agent,
      noAgent: opts.noAgent,
      fresh: opts.fresh,
      shared: false, // this is the build that produces the shared tour
      onProgress: (step, done) => {
        if (done) log(`  ✓ ${step}`);
      },
      onTour: () => {},
    });
  } finally {
    store.close();
  }
  if (!tour.complete) {
    // A failed briefing leaves its reason in a model-unavailable flag, not in the notes.
    const reasons = [...tour.flags.filter((f) => f.kind === 'model-unavailable').map((f) => f.message), ...tour.notes];
    throw new Error(`the tour did not finish, so it was not shared:\n${reasons.map((n) => `  ${n}`).join('\n')}`);
  }
  if (opts.out) {
    const json = JSON.stringify(shareableTour(tour));
    if (opts.out === '-') process.stdout.write(`${json}\n`);
    else {
      fs.writeFileSync(opts.out, json);
      log(`Wrote ${opts.out}`);
    }
  }
  if (opts.comment) await shareOnPR(pr, tour, `${opts.command} ${pr.number}`, log);
  return tour;
}

// Posts the tour to the PR. One too large for a comment is skipped with a warning, not an error:
// reviewers build it locally as usual, and a big PR should not turn its CI red.
export async function shareOnPR(pr: Pick<PRInfo, 'repo' | 'number'>, tour: Tour, command: string, log: (line: string) => void, post = postSharedTour): Promise<boolean> {
  let body: string;
  try {
    body = encodeSharedTour(tour, { command });
  } catch (e) {
    if (!(e instanceof SharedTourTooLargeError)) throw e;
    const message = `Not posting the tour: ${e.message}. Reviewers will build it locally.`;
    // In GitHub Actions, also an annotation on the run.
    log(process.env.GITHUB_ACTIONS === 'true' ? `::warning::${message}` : message);
    return false;
  }
  log(`Posted the tour to ${await post(pr.repo, pr.number, body)}`);
  return true;
}
