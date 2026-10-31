import type { ChapterKind, Tour } from '../types.js';

// PRs from a bot, such as a Dependabot or Renovate dependency bump: a short tour that opens on
// its chapter rather than the briefing, and ends with approve and merge.

// Bots by name, for a tour cached before gr read the author's type, and for bots that run as
// ordinary accounts.
const BOT_LOGIN = /\[bot\]$|^(dependabot|dependabot-preview|renovate|renovate-bot|depfu|greenkeeper|snyk-bot|pyup-bot)$/i;

export function isBotAuthor(tour: Pick<Tour, 'author' | 'authorBot'>): boolean {
  return !!tour.authorBot || BOT_LOGIN.test(tour.author);
}

// Chapters that hold one kind of change, as the tour's special chapters do, rather than a flow
// through the code.
const SPECIAL = new Set<ChapterKind>(['migrations', 'api', 'dependencies', 'lockfiles', 'infra', 'ci', 'config', 'mechanical', 'generated', 'vendored']);

// A bot's PR whose tour is only special chapters, such as a dependency bump: the briefing has
// nothing to add to it.
export function isShortTour(tour: Pick<Tour, 'author' | 'authorBot' | 'chapters'>): boolean {
  const read = tour.chapters.filter((c) => !c.optional);
  return isBotAuthor(tour) && read.length > 0 && read.every((c) => SPECIAL.has(c.kind));
}
