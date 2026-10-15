import { describe, expect, it, vi } from 'vitest';
import { shareOnPR } from '../src/build.js';
import { MAX_COMMENT_CHARS } from '../src/github/sharedTour.js';
import { tour } from './fixtures/tour.js';

const pr = { repo: 'o/r', number: 7 };
const complete = (intent: string) => tour([], [], { pr: 7, complete: true, mode: 'agent', intent });

describe('shareOnPR', () => {
  it('posts a tour that fits in a comment', async () => {
    const post = vi.fn(async () => 'https://github.com/o/r/pull/7#issuecomment-1');
    const log = vi.fn();
    expect(await shareOnPR(pr, complete('Small.'), 'gr review 7', log, post)).toBe(true);
    expect(post).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('Posted the tour to https://github.com/o/r/pull/7#issuecomment-1');
  });

  it('skips a tour too large for a comment with a warning, and does not fail', async () => {
    // Random text barely compresses.
    const noise = Array.from({ length: MAX_COMMENT_CHARS }, () => Math.random().toString(36).slice(2)).join('');
    const post = vi.fn(async () => 'unused');
    const log = vi.fn();
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    try {
      expect(await shareOnPR(pr, complete(noise), 'gr review 7', log, post)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(post).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^::warning::Not posting the tour: .*comment limit\. Reviewers will build it locally\.$/));
  });
});
