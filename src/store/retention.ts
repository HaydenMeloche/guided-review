// How long Guided Review keeps tours, checkouts, and clones. Apart from db.ts so the CLI's help
// text can use them without loading node:sqlite.
export const KEEP_TOURS_PER_PR = 3;
// `gr cleanup` deletes tours not opened for this long, then the reading state of PRs left without one.
export const TOUR_MAX_AGE_DAYS = 90;
// A cached clone under repos/ that no tour has used for this long is deleted, by `gr cleanup` and
// the automatic cleanup alike. Cloning again costs one download.
export const REPO_MAX_AGE_DAYS = 30;
// As a tour starts, a cleanup runs on its own at most this often: tours not opened in
// AUTO_CLEANUP_DAYS, and PR worktrees not used in AUTO_WORKTREE_DAYS (rebuilt from the clone
// without a download when needed).
export const AUTO_CLEANUP_INTERVAL_MS = 86_400_000;
export const AUTO_CLEANUP_DAYS = 30;
export const AUTO_WORKTREE_DAYS = 3;
