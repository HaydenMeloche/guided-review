import { describe, expect, it } from 'vitest';
import { quitAsksAbout } from '../src/tui/App.js';

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
