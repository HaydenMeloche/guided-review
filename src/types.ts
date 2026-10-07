// Shared data model. The tour is plain data so the TUI (and later a web viewer
// or an exported PR comment) all render the same thing.

export type FileKind = 'logic' | 'test' | 'config' | 'mechanical' | 'generated' | 'vendored';

export type ChapterKind =
  | 'flow'
  | 'supporting'
  | 'tests'
  | 'config'
  | 'mechanical'
  | 'generated'
  | 'vendored';

export type Risk = 0 | 1 | 2 | 3; // none, low, medium, high

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export type LinkSource = 'coverage' | 'static-call' | 'naming';

export interface TestLink {
  testFile: string;
  testName: string; // the it()/test() title, or the file name when no case matched
  startLine: number; // 1-based line in the head version of testFile
  lines: string[]; // the test case's source
  source: LinkSource;
  confidence: number; // 0..1
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
  risk: Risk;
  riskReasons: string[];
  tests: TestLink[];
  coverage: Coverage;
  // Test hunks whose subject did not change: the unchanged code they cover, so
  // the reviewer can tell whether a test was loosened.
  covers?: { file: string; startLine: number; lines: string[]; symbol?: string };
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
}

export type FlagKind =
  | 'scope-creep'
  | 'missing-tests'
  | 'generated-out-of-sync'
  | 'large-pr'
  | 'no-entry-point'
  | 'model-unavailable'
  | 'info';

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
  author: string;
  body: string;
  createdAt: string;
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
  flags: Flag[];
  notes: string[];
  overview?: Graph;
  chapters: Chapter[];
  files: DiffFile[];
  hunks: Record<string, Hunk>;
  blastRadius: BlastItem[];
  existingThreads: ExistingThread[];
  rereview?: ReReview;
  agentSessionId?: string; // reused for live Q&A and comment polishing
}

// Repo-level rules from .claude/guided-review.json
export interface KindRule {
  pattern: string; // glob, matched against the repo-relative path
  kind: FileKind;
}

export interface RepoConfig {
  kinds: KindRule[];
  testPatterns: string[];
  model?: string;
}

export type ProgressFn = (step: string, done?: boolean) => void;
