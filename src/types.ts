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
  moved?: { file: string; line: number };
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
  narrationShared?: boolean; // a minor hunk: narration is the chapter's shared summary of its minor hunks
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

export interface Draft {
  id: string;
  repo: string;
  pr: number;
  headSha: string;
  anchor: DraftAnchor;
  label: CommentLabel;
  body: string;
  suggestion?: string; // replacement code for the anchored line(s)
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

export type ProgressFn = (step: string, done?: boolean) => void;
