// Shared data model. The tour is plain data so the TUI (and later a web viewer
// or an exported PR comment) all render the same thing.

export type FileKind = 'logic' | 'test' | 'config' | 'mechanical' | 'generated' | 'vendored';

export type ChapterKind = 'flow' | 'supporting' | 'tests' | 'imports' | 'migrations' | 'api' | 'dependencies' | 'lockfiles' | 'infra' | 'ci' | 'config' | 'mechanical' | 'generated' | 'vendored';

export type ChapterOrder = 'flow' | 'risk' | 'size' | 'file';

export type Risk = 0 | 1 | 2 | 3; // none, low, medium, high

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
  oldLine?: number;
  newLine?: number;
  // Context read from the file, not part of the PR's diff (the gap between two fused hunks, or
  // lines the reader expanded): GitHub cannot take a review comment on it.
  expanded?: boolean;
  // Part of a block moved within the PR: for a removed line, where it now is in the head; for an
  // added line, where it was in the base.
  moved?: MovedTo;
}

export interface MovedTo {
  file: string;
  line: number;
  // reindented: it stayed put and code around it changed its indent; copied: the same lines were
  // also added elsewhere (`also`); merged: they were only removed elsewhere too, copies folded
  // into one.
  kind: 'moved' | 'reindented' | 'copied' | 'merged';
  indent: number; // columns the block shifted right (negative: left), a tab counting as four
  also: { file: string; line: number; side: 'add' | 'del' }[];
}

export type LinkSource = 'coverage' | 'name-match' | 'naming';

export interface TestLink {
  testFile: string;
  testName: string; // the it()/test() title, or the file name when no case matched
  startLine: number; // 1-based line in the head version of testFile
  lines: string[]; // the test case's source
  source: LinkSource;
  confidence: number; // 0..1
  diffHunks?: { header: string; lines: DiffLine[] }[]; // changed lines in this test case
  testFileStatus?: DiffFile['status'];
  testChange?: 'new' | 'modified';
}

export type Coverage = 'tested' | 'partial' | 'untested' | 'n/a';

export interface Hunk {
  id: string; // stable for (path, header) within a head commit
  contentHash: string; // path + changed lines only, no line numbers; used for re-review delta
  // A fused hunk: the content hash of each GitHub hunk it joins. Read state, moves and re-review
  // go by these (see hunkKeys), so they hold when the hunks fuse differently on another head.
  parts?: string[];
  file: string;
  oldFile?: string;
  header: string; // the @@ ... @@ line
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  symbols: string[]; // enclosing declarations in the head (or base, for pure deletions)
  narration?: string;
  narrationInferred?: boolean; // true when the narration cites no code
  narrationShared?: boolean; // narration is shared with other hunks: a chapter's summary of its minor hunks, or a lockfile pair's one narration
  risk: Risk;
  riskReasons: string[];
  tests: TestLink[];
  coverage: Coverage;
  // Test hunks whose subject did not change: the unchanged code they cover, so
  // the reviewer can tell whether a test was loosened.
  covers?: { file: string; startLine: number; lines: string[]; symbol?: string };
  importOnly?: boolean; // every changed line is an import: optional to review
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary: boolean;
  kind: FileKind;
  kindReason: string;
  additions: number;
  deletions: number;
  hunkIds: string[];
  summary?: string; // one-line summary for collapsed kinds (lockfile diff, rename, etc.)
}

export type DiagramKind = 'call' | 'before-after' | 'state' | 'entity' | 'deps';

export interface GraphNode {
  id: string;
  label: string;
  changed?: boolean;
  hunkId?: string; // selecting the node jumps to this hunk
  group?: string; // e.g. 'before' / 'after' columns
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  confidence?: LinkSource | 'model';
}

export interface Graph {
  kind: DiagramKind;
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// A changed lockfile read with the changed manifests it locks (see pairLockfiles). Each manifest
// hunk is a page that lists the lockfile's parsed package changes under its diff; the lockfile's
// hunks have no page of their own. Every hunk of the pair shares one narration.
export interface LockPair {
  lockfile: string; // its path
  hunkIds: string[]; // the manifests' dependency hunks, in reading order
  lockHunkIds: string[]; // the lockfile's hunks
}

export interface Chapter {
  id: string;
  kind: ChapterKind;
  title: string;
  entryPoint?: string;
  summary?: string;
  diagram?: Graph;
  risk: Risk;
  hunkIds: string[]; // reading order
  linkedHunkIds: string[]; // shared code owned by an earlier chapter, linked from here
  orphanReasons: Record<string, string>; // supporting chapter: hunkId -> one-line reason
  untestedBranches: string[];
  collapsed: boolean; // low-priority kinds start collapsed to one-line summaries
  folded?: string[]; // hunks read as one summary on the chapter's opening page (lockfiles with no changed manifest, in the dependencies chapter); the rest follow it
  lockPairs?: LockPair[]; // dependencies chapter: lockfiles read on the pages of the manifests they lock
  lowConfidence?: boolean; // flow edges from naming/model only
  optional?: boolean; // low-value chapter (import-only changes): not stepped into by n/p, not counted as unread
  checklist?: ChecklistItem[]; // team checklist items whose path pattern matches this chapter
  narrated?: boolean; // the narration step for this chapter finished; an incomplete tour resumes from the others
}

export type FlagKind = 'scope-creep' | 'missing-tests' | 'generated-out-of-sync' | 'large-pr' | 'no-entry-point' | 'model-unavailable' | 'missing-change' | 'info';

export interface Flag {
  kind: FlagKind;
  message: string;
  hunkIds?: string[];
}

export interface CallerRef {
  file: string;
  line: number;
  text: string;
}

export interface BlastItem {
  symbol: string;
  hunkId: string;
  callers: CallerRef[];
}

export interface ThreadComment {
  id?: string;
  nodeId?: string;
  author: string;
  body: string;
  createdAt: string;
  reactionGroups?: ReactionGroup[];
  url?: string;
}

export type ReactionContent = 'THUMBS_UP' | 'THUMBS_DOWN' | 'LAUGH' | 'CONFUSED' | 'HEART' | 'HOORAY' | 'ROCKET' | 'EYES';

export interface ReactionGroup {
  content: ReactionContent;
  reactors: { totalCount: number };
  viewerHasReacted: boolean;
}

export interface ExistingThread {
  id: string;
  path: string;
  line?: number;
  originalLine?: number;
  isResolved: boolean;
  isOutdated: boolean;
  comments: ThreadComment[];
  // Where the thread was written: originalLine (and originalStartLine) are lines of this commit,
  // not of the base or the head.
  originalCommit?: string;
  startLine?: number;
  originalStartLine?: number;
  side?: 'LEFT' | 'RIGHT';
  subjectType?: 'LINE' | 'FILE';
  diffHunk?: string; // the first comment's diff hunk, ending at the commented line
  viewerCanResolve?: boolean;
  viewerCanUnresolve?: boolean;
  // An outdated thread followed to its line at the head (see placeThread), so it shows where
  // the code it was about is now. Computed after loading; never from GitHub.
  placed?: { line: number; side: 'LEFT' | 'RIGHT' };
}

// A comment on the PR's conversation, not on a line.
export interface IssueComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface ExistingReview {
  id: number;
  author: string;
  state: string;
  body: string;
  submittedAt: string;
  url: string;
}

export type ReadState = 'unread' | 'read' | 'skipped' | 'deferred';

export type CommentLabel = 'blocking' | 'question' | 'suggestion' | 'nit';

export type DraftAnchor =
  | { type: 'line'; hunkId: string; file: string; line: number; side: 'LEFT' | 'RIGHT' }
  | { type: 'range'; hunkId: string; file: string; startLine: number; line: number; side: 'LEFT' | 'RIGHT' }
  | { type: 'chapter'; chapterId: string }
  | { type: 'node'; chapterId: string; nodeId: string };

// The target of a code reference in a draft's body, an inline code span holding exactly its
// label: a place in the code pinned to a commit, so its permalink never breaks; after a new head
// it may only be outdated. The review payload turns each such span into an inline link; the label
// never contains whitespace or a backtick. A ref whose span leaves the body is dropped when the
// draft is saved.
export interface CodeRef {
  id: string;
  kind: 'symbol' | 'file' | 'range' | 'thread';
  path: string; // repo-relative
  commitSha: string; // the head SHA, or the base SHA for code the PR deletes
  startLine?: number;
  endLine?: number;
  symbol?: string; // qualified name, e.g. "InventoryService.releaseInventory"
  label: string; // unique within the draft, no whitespace: "releaseInventory()", "stock.ts:84-96"
  linesHash?: string; // hash of the referenced lines when inserted, for stale detection
  threadUrl?: string; // kind 'thread': the discussion's URL on the PR
}

export interface SuggestionMeta {
  source: 'manual' | 'ai';
  headSha: string; // the head the suggestion was written against
  originalHash: string; // hash of the anchored lines it replaces, at headSha
  model?: import('./agent/types.js').ModelStamp;
  explanation?: string;
  assumptions?: string[];
}

export interface Draft {
  id: string;
  repo: string;
  pr: number;
  headSha: string;
  anchor: DraftAnchor;
  label: CommentLabel;
  body: string;
  suggestion?: string; // replacement code for the anchored line(s)
  suggestionMeta?: SuggestionMeta;
  refs?: CodeRef[]; // the targets of the body's code references, linked only when the review is built
  posted: boolean;
  createdAt: string;
  note?: string; // e.g. "moved to nearest line: original line left the diff"
}

export interface CommentStatus {
  body: string;
  path?: string;
  line?: number;
  addressed: boolean;
  reason: string;
}

export interface ReReview {
  previousHead: string;
  newHunkIds: string[]; // new or changed since previousHead
  comments: CommentStatus[];
}

export interface PRInfo {
  repo: string; // owner/name
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  commits: { sha: string; message: string }[];
  linkedIssues: { title: string; body: string; url: string }[];
}

export interface Tour {
  version: 1;
  repo: string;
  pr: number;
  title: string;
  url: string;
  author: string;
  baseSha: string;
  headSha: string;
  createdAt: string;
  mode: 'agent' | 'plain';
  intent: string; // 2-3 sentence goal
  description?: string; // the PR body as the author wrote it
  flags: Flag[];
  notes: string[];
  overview?: Graph;
  chapters: Chapter[];
  files: DiffFile[];
  hunks: Record<string, Hunk>;
  blastRadius: BlastItem[];
  existingThreads: ExistingThread[];
  existingReviews?: ExistingReview[];
  viewer?: string;
  mentionUsers?: string[];
  rereview?: ReReview;
  agentSessions?: Partial<Record<import('./agent/types.js').AgentRole, string>>;
  agentIdentity?: string; // effective model routing used for this cached tour
  modelUsage?: Record<string, import('./agent/types.js').ModelStamp>;
  complete?: boolean; // every analysis step finished; cached tours with this set are reused
  source?: 'shared'; // imported from a tour CI posted to the PR, not built on this machine
}

// Repo-level rules from .guided-review.json
export interface KindRule {
  pattern: string; // glob, matched against the repo-relative path
  kind: FileKind;
}

export interface ChecklistRule {
  pattern: string; // glob over changed paths, e.g. "db/**"
  items: string[];
}

export interface RepoConfig {
  kinds: KindRule[];
  testPatterns: string[];
  checklists: ChecklistRule[];
}

export type ChecklistStatus = 'pass' | 'fail' | 'unknown';

export interface ChecklistItem {
  id: string; // stable: hash of pattern + item
  item: string;
  pattern: string;
  status: ChecklistStatus; // the agent's pre-check
  reason?: string; // with a file:line citation when the agent checked it
  confirmed?: boolean; // the reviewer's confirmation (stored separately, merged in by the UI)
}

// `count` carries a step's done and total items (chapters narrated), so a caller can show a percentage.
export type ProgressFn = (step: string, done?: boolean, count?: { done: number; total: number }) => void;
