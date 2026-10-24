// How long Guided Review keeps tours. Apart from db.ts so the CLI's help text can use them
// without loading node:sqlite.
export const KEEP_TOURS_PER_PR = 3;
// `gr cleanup` deletes tours not opened for this long, then the reading state of PRs left without one.
export const TOUR_MAX_AGE_DAYS = 90;
// As a tour starts, the same cleanup runs on its own at most this often, with this cutoff.
export const AUTO_CLEANUP_INTERVAL_MS = 7 * 86_400_000;
export const AUTO_CLEANUP_DAYS = 30;
