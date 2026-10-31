import { describe, expect, it } from 'vitest';
import { quitAsksAbout, quitSummary } from '../src/tui/App.js';
import { diffLines, hunk, tour } from './fixtures/tour.js';

describe('what Q asks about before quitting', () => {
  const pr = { repo: 'acme/app', pr: 7 };
  const target = { repo: 'acme/app', number: 7 };

  it('asks about the PR open now', () => {
    expect(quitAsksAbout('chapter', pr, target, false)).toEqual(pr);
    expect(quitAsksAbout('load', undefined, target, false)).toEqual(pr);
  });

  it('asks about nothing at the PR list, though the last PR is still the target', () => {
    expect(quitAsksAbout('pick', undefined, target, false)).toBeUndefined();
    // After posting a review, the list opens with the tour still loaded.
    expect(quitAsksAbout('pick', pr, target, false)).toBeUndefined();
  });

  it('asks about nothing for a local tour, whose drafts have nowhere to post', () => {
    expect(quitAsksAbout('chapter', { repo: 'local', pr: 0 }, { repo: 'local', number: 0 }, true)).toBeUndefined();
  });
});

describe('the line left on quit', () => {
  const h1 = hunk('h1', 'src/a.ts', diffLines(['+a']));
  const h2 = hunk('h2', 'src/b.ts', diffLines(['+b']));
  const t = tour([h1, h2], [], { repo: 'acme/api', pr: 812, title: 'feature (preview)' });

  it('says how far the review got, what is unposted, and how to resume', () => {
    expect(quitSummary({ tour: t, mode: 'review', states: { [h1.contentHash]: 'read' }, drafts: 2, replies: 0 })).toBe(
      'acme/api#812 · 1/2 hunks read · 2 drafts saved, not posted · resume with gr review acme/api#812',
    );
    expect(quitSummary({ tour: t, mode: 'author', states: {}, drafts: 0, replies: 1 })).toBe('acme/api#812 · 1 reply queued, not sent · resume with gr feedback acme/api#812');
  });

  it('names a preview by its title with nothing to resume by, and leaves the demo out', () => {
    const local = { pr: {} as never, diff: '', worktree: '/r' };
    expect(quitSummary({ tour: t, mode: 'review', states: {}, drafts: 0, replies: 0, local })).toBe('feature (preview) · 0/2 hunks read');
    expect(quitSummary({ tour: t, mode: 'review', states: {}, drafts: 0, replies: 0, local, demo: true })).toBeUndefined();
  });
});
