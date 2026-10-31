import { describe, expect, it } from 'vitest';
import type { Chapter, ChapterKind } from '../src/types.js';
import { isBotAuthor, isShortTour } from '../src/review/botPR.js';

const chapter = (kind: ChapterKind, optional = false) => ({ id: kind, kind, optional }) as Chapter;

describe('bot PRs', () => {
  it('knows a bot by GitHub’s account type, or by a bot’s name', () => {
    expect(isBotAuthor({ author: 'some-app', authorBot: true })).toBe(true);
    expect(isBotAuthor({ author: 'dependabot' })).toBe(true);
    expect(isBotAuthor({ author: 'renovate[bot]' })).toBe(true);
    expect(isBotAuthor({ author: 'mira' })).toBe(false);
  });

  it('gives a short tour to a bot’s PR of special chapters only', () => {
    const bot = { author: 'dependabot', authorBot: true };
    expect(isShortTour({ ...bot, chapters: [chapter('dependencies')] })).toBe(true);
    expect(isShortTour({ ...bot, chapters: [chapter('dependencies'), chapter('lockfiles'), chapter('imports', true)] })).toBe(true);
    // Code in a flow needs the briefing, whoever wrote it, as does a person's dependency bump.
    expect(isShortTour({ ...bot, chapters: [chapter('dependencies'), chapter('flow')] })).toBe(false);
    expect(isShortTour({ author: 'mira', chapters: [chapter('dependencies')] })).toBe(false);
    expect(isShortTour({ ...bot, chapters: [] })).toBe(false);
  });
});
