import type { ExistingReview, ExistingThread, IssueComment, PRInfo, ReactionContent, ReactionGroup } from '../types.js';
import { run, type ExecError, type RunOptions } from '../util/exec.js';
import { repoFromRemote } from '../git/git.js';
import { git } from '../git/git.js';
import { githubAuth, githubWebHost, resetGitHubAuth } from './auth.js';
import { escapeRe } from '../util/regex.js';
import { GitHubHttpError, type TokenAuth, graphqlRequest, restJson, restPages, restText } from './api.js';

export interface ReviewPayload {
  commit_id: string;
  body: string;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  comments: {
    path: string;
    body: string;
    line: number;
    side: 'LEFT' | 'RIGHT';
    start_line?: number;
    start_side?: 'LEFT' | 'RIGHT';
  }[];
}

export interface ReviewRequest {
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  updatedAt: string;
  isDraft: boolean;
  labels: string[];
}

export interface PRPreview {
  title: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  isDraft: boolean;
  reviewDecision: string; // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or ''
  mergeable: string;
  mergeStateStatus?: string; // CLEAN, UNSTABLE, BLOCKED, … (see MergeStatus)
  labels: string[];
  body: string;
  checks: Pick<CheckSummary, 'passed' | 'failed' | 'pending' | 'failedNames'> & { items?: CheckItem[] };
  files: { path: string; additions: number; deletions: number }[];
}

interface PRPreviewRaw {
  title: string;
  author: { login: string } | null; // null for a deleted account
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  isDraft: boolean;
  reviewDecision: string | null;
  mergeable: string;
  mergeStateStatus?: string | null;
  labels: { name: string }[];
  body: string;
  statusCheckRollup: CheckContext[] | null;
  files: { path: string; additions: number; deletions: number }[] | null;
}

// What the picker's preview pane shows.
const PR_PREVIEW_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      title author { login } headRefName baseRefName headRefOid additions deletions changedFiles isDraft reviewDecision mergeable mergeStateStatus body
      labels(first: 100) { nodes { name } }
      files(first: 100) { nodes { path additions deletions } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        ... on CheckRun { name status conclusion detailsUrl startedAt completedAt checkSuite { app { name } workflowRun { event workflow { name } } } }
        ... on StatusContext { context state targetUrl description createdAt }
      } } } } } }
    }
  }
}`;

// GraphQL, through gh or a token: `gh pr view --json` leaves out what started each workflow run,
// which telling a check's latest run from an older one needs.
async function prPreviewRaw(repo: string, number: number): Promise<PRPreviewRaw> {
  const { owner, name } = splitRepo(repo);
  type Raw = Omit<PRPreviewRaw, 'labels' | 'files' | 'statusCheckRollup'> & {
    labels: { nodes: { name: string }[] };
    files: { nodes: { path: string; additions: number; deletions: number }[] } | null;
    commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: NonNullable<PRPreviewRaw['statusCheckRollup']> } } | null } }[] };
  };
  const data = await graphql<{ repository: { pullRequest: Raw } }>(PR_PREVIEW_QUERY, { owner, name, number });
  const { labels, files, commits, ...pr } = data.repository.pullRequest;
  return {
    ...pr,
    labels: labels.nodes,
    files: files?.nodes ?? null,
    statusCheckRollup: commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? null,
  };
}

// Everything the picker's preview pane shows, in one call.
export async function fetchPRPreview(repo: string, number: number): Promise<PRPreview> {
  const r = await prPreviewRaw(repo, number);
  const { passed, failed, pending, failedNames, items } = summarizeChecks(r.statusCheckRollup ?? []);
  const checks = { passed, failed, pending, failedNames, items };
  return {
    title: r.title,
    author: r.author?.login ?? 'ghost',
    headRefName: r.headRefName,
    baseRefName: r.baseRefName,
    headSha: r.headRefOid,
    additions: r.additions,
    deletions: r.deletions,
    changedFiles: r.changedFiles,
    isDraft: r.isDraft,
    reviewDecision: r.reviewDecision ?? '',
    mergeable: r.mergeable,
    mergeStateStatus: r.mergeStateStatus ?? undefined,
    labels: r.labels.map((l) => l.name),
    body: r.body ?? '',
    checks,
    files: r.files ?? [],
  };
}

export function parsePRArg(arg: string, cwdRepo?: string, host = githubWebHost()): { repo: string; number: number } {
  const s = arg.trim();
  const url = s.match(new RegExp(`^https?://${escapeRe(host)}/([^/]+/[^/]+)/pull/(\\d+)`, 'i'));
  if (url) return { repo: url[1], number: Number(url[2]) };
  const qualified = s.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  if (qualified) return { repo: qualified[1], number: Number(qualified[2]) };
  const bare = s.match(/^#?(\d+)$/);
  if (bare) {
    if (!cwdRepo) throw new Error(`PR ${s} needs a repository: run inside a clone or pass owner/name#${bare[1]}`);
    return { repo: cwdRepo, number: Number(bare[1]) };
  }
  throw new Error(`Not a PR number or URL: ${arg}`);
}

// Every gh call goes through here. Rejects with an ExecError. Callers check githubAuth()
// first: with a token configured, they call the API over HTTPS instead.
export function gh(args: string[], opts: RunOptions = {}): Promise<string> {
  return run('gh', args, opts);
}

// The HTTP status of a failed `gh api` call, read from the "HTTP 404" gh prints on stderr,
// or of a failed token request.
export function ghHttpStatus(e: unknown): number | undefined {
  if (e instanceof GitHubHttpError) return e.status;
  const m = /\bHTTP (\d{3})\b/.exec((e as Partial<ExecError>).stderr ?? '');
  return m ? Number(m[1]) : undefined;
}

// gh missing or signed out, as an error worth showing; undefined for any other failure.
// Lookups that read a failure as "nothing found" rethrow this instead.
function ghUnavailable(e: unknown): Error | undefined {
  const err = e as Partial<ExecError>;
  if (err.code === 'ENOENT') return new Error('the GitHub CLI (gh) is not installed or not on PATH; install it, or run `gr config` to use a personal access token', { cause: e });
  if (e instanceof GitHubHttpError) return e.status === 401 ? e : undefined;
  if (/gh auth login|not logged in|HTTP 401|authentication/i.test(err.stderr ?? '')) return e as Error;
  return undefined;
}

async function graphql<T>(query: string, vars: Record<string, string | number>, signal?: AbortSignal): Promise<T> {
  const auth = githubAuth();
  if (auth) {
    const parsed = await graphqlRequest<T>(auth, query, vars, signal);
    if (parsed.errors?.length) throw new Error(parsed.errors.map((e) => e.message).join('; '));
    return parsed.data;
  }
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  }
  const out = await gh(args, { signal });
  const parsed = JSON.parse(out) as { data: T; errors?: { message: string }[] };
  if (parsed.errors?.length) throw new Error(parsed.errors.map((e) => e.message).join('; '));
  return parsed.data;
}

// A GET of `gh api <args>`, or of the args' path with a token.
async function apiJson<T>(args: string[], opts: { signal?: AbortSignal } = {}): Promise<T> {
  const auth = githubAuth();
  if (auth) return restJson<T>(auth, args[args.length - 1], opts);
  return JSON.parse(await gh(args, opts)) as T;
}

// Every page of a list endpoint, as `gh api --paginate --slurp` returns them.
export async function apiPages<T>(path: string, signal?: AbortSignal, maxBuffer?: number): Promise<T[][]> {
  const auth = githubAuth();
  if (auth) return restPages<T>(auth, path, { signal });
  return JSON.parse(await gh(['api', '--paginate', '--slurp', path], { signal, maxBuffer })) as T[][];
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');
  return { owner, name };
}

// The GitHub repo of the clone at cwd. Reads the git remotes first, which needs no network:
// a remote picked with `gh repo set-default`, or the only GitHub remote. With several GitHub
// remotes and no default (a fork with upstream), gh's own resolution decides.
// With a token there is no gh to ask, so the remote names gh prefers decide instead.
export async function currentRepo(cwd: string): Promise<string | undefined> {
  const local = await repoFromRemotes(cwd);
  if (local) return local;
  if (githubAuth()) {
    for (const remote of ['upstream', 'github', 'origin']) {
      const url = await git(cwd, ['remote', 'get-url', remote]).catch(() => '');
      const repo = url && repoFromRemote(url);
      if (repo) return repo;
    }
    return undefined;
  }
  try {
    const out = await gh(['repo', 'view', '--json', 'nameWithOwner'], { cwd });
    return (JSON.parse(out) as { nameWithOwner: string }).nameWithOwner;
  } catch (e) {
    const unavailable = ghUnavailable(e);
    if (unavailable) throw unavailable;
    return undefined;
  }
}

export async function repoFromRemotes(cwd: string): Promise<string | undefined> {
  let out: string;
  try {
    out = await git(cwd, ['config', '--get-regexp', '^remote\\..*\\.(url|gh-resolved)$']);
  } catch {
    return undefined;
  }
  const remotes = new Map<string, { repo?: string; resolved?: string }>();
  for (const line of out.split('\n')) {
    const m = line.match(/^remote\.(.+)\.(url|gh-resolved) (.*)$/i);
    if (!m) continue;
    const r = remotes.get(m[1]) ?? {};
    if (m[2].toLowerCase() === 'url') r.repo ??= repoFromRemote(m[3]);
    else r.resolved = m[3].trim();
    remotes.set(m[1], r);
  }
  const resolved = [...remotes.values()].find((r) => r.resolved);
  if (resolved) return resolved.resolved === 'base' ? resolved.repo : resolved.resolved;
  const github = [...new Set([...remotes.values()].map((r) => r.repo).filter(Boolean))];
  return github.length === 1 ? github[0] : undefined;
}

// Runs fn over items with at most `limit` in flight; results keep the input order.
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const ISSUE_CONCURRENCY = 4;

const PR_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      title body url
      author { login }
      baseRefName headRefName baseRefOid headRefOid
      commits(first: 100) { nodes { commit { oid message } } }
      closingIssuesReferences(first: 10) { nodes { title body url number } }
    }
  }
}`;

interface PRQueryResult {
  repository: {
    pullRequest: {
      title: string;
      body: string;
      url: string;
      author: { login: string } | null;
      baseRefName: string;
      headRefName: string;
      baseRefOid: string;
      headRefOid: string;
      commits: { nodes: { commit: { oid: string; message: string } }[] };
      closingIssuesReferences: { nodes: { title: string; body: string; url: string; number: number }[] };
    };
  };
}

// Issue references written in the PR body: "Fixes #12", "closes owner/repo#3",
// plus Linear and Jira links (kept as URLs; we cannot read those without their APIs).
export function findIssueRefs(body: string, repo: string): { github: { repo: string; number: number }[]; urls: string[] } {
  const github: { repo: string; number: number }[] = [];
  const re = /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?|refs?|part of)\s*:?\s+([\w.-]+\/[\w.-]+)?#(\d+)/gi;
  for (const m of body.matchAll(re)) {
    github.push({ repo: m[1] ?? repo, number: Number(m[2]) });
  }
  const urls = [...body.matchAll(/https?:\/\/linear\.app\/[^\s)\]]+/g), ...body.matchAll(/https?:\/\/[\w.-]+\.atlassian\.net\/browse\/[A-Z][A-Z0-9]+-\d+/g)].map((m) => m[0]);
  return { github, urls: [...new Set(urls)] };
}

// owner/name as GitHub allows it; '.' and '..' would turn an API path into a traversal.
export function isValidRepoSlug(slug: string): boolean {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(slug)) return false;
  return slug.split('/').every((part) => part !== '.' && part !== '..');
}

// Which body refs to fetch with the reviewer's token: only issues in the PR's own repo, so a
// PR body cannot pull a private issue from another repo the reviewer can read into the tour
// (and from there into the model prompt). Other well-formed refs are kept as plain links.
export function partitionIssueRefs(
  refs: { repo: string; number: number }[],
  prRepo: string,
): {
  fetch: { repo: string; number: number }[];
  linkOnly: { repo: string; number: number }[];
} {
  const fetch: { repo: string; number: number }[] = [];
  const linkOnly: { repo: string; number: number }[] = [];
  for (const ref of refs) {
    if (!isValidRepoSlug(ref.repo) || !Number.isSafeInteger(ref.number) || ref.number <= 0) continue;
    (ref.repo.toLowerCase() === prRepo.toLowerCase() ? fetch : linkOnly).push(ref);
  }
  return { fetch, linkOnly };
}

export async function fetchPR(repo: string, number: number, signal?: AbortSignal): Promise<PRInfo> {
  const { owner, name } = splitRepo(repo);
  const data = await graphql<PRQueryResult>(PR_QUERY, { owner, name, number }, signal);
  const pr = data.repository.pullRequest;
  const linkedIssues: PRInfo['linkedIssues'] = pr.closingIssuesReferences.nodes.map((i) => ({
    title: i.title,
    body: i.body,
    url: i.url,
  }));
  const seen = new Set(linkedIssues.map((i) => i.url));
  const refs = findIssueRefs(pr.body ?? '', repo);
  const { fetch, linkOnly } = partitionIssueRefs(refs.github, repo);
  const host = githubWebHost();
  const toFetch = fetch.filter((ref) => {
    const url = `https://${host}/${ref.repo}/issues/${ref.number}`;
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
  const fetched = await mapConcurrent(toFetch, ISSUE_CONCURRENCY, async (ref) => {
    try {
      const issue = await apiJson<{ title: string; body: string | null; html_url: string }>(['api', `repos/${ref.repo}/issues/${ref.number}`], { signal });
      return { title: issue.title, body: issue.body ?? '', url: issue.html_url };
    } catch {
      return undefined; // Unreadable or missing issue: skip it rather than failing the whole fetch.
    }
  });
  for (const issue of fetched) if (issue) linkedIssues.push(issue);
  for (const ref of linkOnly) {
    const url = `https://${host}/${ref.repo}/issues/${ref.number}`;
    if (seen.has(url)) continue;
    seen.add(url);
    linkedIssues.push({ title: `${ref.repo}#${ref.number}`, body: '', url });
  }
  for (const url of refs.urls) {
    if (!seen.has(url)) linkedIssues.push({ title: url, body: '', url });
  }
  return {
    repo,
    number,
    title: pr.title,
    body: pr.body ?? '',
    url: pr.url,
    author: pr.author?.login ?? 'ghost',
    baseRef: pr.baseRefName,
    headRef: pr.headRefName,
    baseSha: pr.baseRefOid,
    headSha: pr.headRefOid,
    commits: pr.commits.nodes.map((n) => ({ sha: n.commit.oid, message: n.commit.message })),
    linkedIssues,
  };
}

export async function fetchDiff(repo: string, number: number, signal?: AbortSignal): Promise<string> {
  const auth = githubAuth();
  if (auth) return restText(auth, `repos/${repo}/pulls/${number}`, { accept: 'application/vnd.github.v3.diff', signal });
  return gh(['api', '-H', 'Accept: application/vnd.github.v3.diff', `repos/${repo}/pulls/${number}`], {
    maxBuffer: 200 * 1024 * 1024,
    signal,
  });
}

// One thread's fields, shared by the PR's thread list and the paging of a long thread's comments.
const COMMENT_FIELDS = 'id fullDatabaseId url author { login } body createdAt reactionGroups { content reactors { totalCount } viewerHasReacted }';

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id path line originalLine startLine originalStartLine diffSide subjectType isResolved isOutdated viewerCanResolve viewerCanUnresolve
          first: comments(first: 1) { nodes { originalCommit { oid } diffHunk } }
          comments(first: 50) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } }
        }
      }
    }
  }
}`;

const THREAD_COMMENTS_QUERY = `
query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ${COMMENT_FIELDS} } }
    }
  }
}`;

interface RawComment {
  id: string;
  fullDatabaseId: string | number | null;
  url: string | null;
  author: { login: string } | null;
  body: string;
  createdAt: string;
  reactionGroups: ReactionGroup[] | null;
}

interface CommentPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: RawComment[];
}

interface RawThread {
  id: string;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine: number | null;
  originalStartLine: number | null;
  diffSide: 'LEFT' | 'RIGHT' | null;
  subjectType: 'LINE' | 'FILE' | null;
  isResolved: boolean;
  isOutdated: boolean;
  viewerCanResolve: boolean | null;
  viewerCanUnresolve: boolean | null;
  first?: { nodes: { originalCommit: { oid: string } | null; diffHunk: string | null }[] };
  comments: Omit<CommentPage, 'pageInfo'> & { pageInfo?: CommentPage['pageInfo'] };
}

interface ThreadsQueryResult {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: RawThread[];
      };
    };
  };
}

// A thread's comments past the first page: long design discussions run past 50.
async function restOfComments(threadId: string, cursor: string, signal?: AbortSignal): Promise<RawComment[]> {
  const out: RawComment[] = [];
  let next: string | null = cursor;
  while (next) {
    const data: { node: { comments: CommentPage } | null } = await graphql(THREAD_COMMENTS_QUERY, { id: threadId, cursor: next }, signal);
    if (!data.node) break;
    out.push(...data.node.comments.nodes);
    next = data.node.comments.pageInfo.hasNextPage ? data.node.comments.pageInfo.endCursor : null;
  }
  return out;
}

const optional = <T>(v: T | null | undefined): T | undefined => v ?? undefined;

export async function fetchThreads(repo: string, number: number, signal?: AbortSignal): Promise<ExistingThread[]> {
  const { owner, name } = splitRepo(repo);
  const nodes: RawThread[] = [];
  let cursor: string | null = null;
  do {
    const data: ThreadsQueryResult = await graphql<ThreadsQueryResult>(THREADS_QUERY, { owner, name, number, ...(cursor ? { cursor } : {}) }, signal);
    const page: ThreadsQueryResult['repository']['pullRequest']['reviewThreads'] = data.repository.pullRequest.reviewThreads;
    nodes.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  const long = nodes.filter((t) => t.comments.pageInfo?.hasNextPage && t.comments.pageInfo.endCursor);
  const more = new Map(await mapConcurrent(long, ISSUE_CONCURRENCY, async (t) => [t.id, await restOfComments(t.id, t.comments.pageInfo!.endCursor!, signal)] as const));
  return nodes.map((t) => {
    const first = t.first?.nodes[0];
    return {
      id: t.id,
      path: t.path,
      line: optional(t.line),
      originalLine: optional(t.originalLine),
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      startLine: optional(t.startLine),
      originalStartLine: optional(t.originalStartLine),
      side: optional(t.diffSide),
      subjectType: optional(t.subjectType),
      originalCommit: optional(first?.originalCommit?.oid),
      diffHunk: optional(first?.diffHunk),
      viewerCanResolve: optional(t.viewerCanResolve),
      viewerCanUnresolve: optional(t.viewerCanUnresolve),
      comments: [...t.comments.nodes, ...(more.get(t.id) ?? [])].map((c) => ({
        id: c.fullDatabaseId == null ? undefined : String(c.fullDatabaseId),
        nodeId: c.id,
        author: c.author?.login ?? 'ghost',
        body: c.body,
        createdAt: c.createdAt,
        reactionGroups: c.reactionGroups ?? [],
        url: optional(c.url),
      })),
    };
  });
}

// The PR's conversation: comments that are not on a line.
export async function fetchIssueComments(repo: string, number: number, signal?: AbortSignal): Promise<IssueComment[]> {
  const pages = await apiPages<{ id: number; user: { login: string } | null; body: string | null; created_at: string; html_url: string }>(
    `repos/${repo}/issues/${number}/comments?per_page=100`,
    signal,
  );
  return pages.flat().map((c) => ({ id: c.id, author: c.user?.login ?? 'ghost', body: c.body ?? '', createdAt: c.created_at, url: c.html_url }));
}

export async function fetchReviews(repo: string, number: number, signal?: AbortSignal): Promise<ExistingReview[]> {
  const pages = await apiPages<{ id: number; user: { login: string } | null; state: string; body: string | null; submitted_at: string | null; html_url: string }>(
    `repos/${repo}/pulls/${number}/reviews`,
    signal,
  );
  return pages
    .flat()
    .filter((r) => r.submitted_at && r.state !== 'PENDING')
    .map((r) => ({
      id: r.id,
      author: r.user?.login ?? 'ghost',
      state: r.state,
      body: r.body ?? '',
      submittedAt: r.submitted_at!,
      url: r.html_url,
    }));
}

// GitHub includes direct collaborators, team members, and people with access
// through organization defaults in this list.
export async function fetchRepoMentionUsers(repo: string, signal?: AbortSignal): Promise<string[]> {
  const pages = await apiPages<{ login?: string }>(`repos/${repo}/collaborators?affiliation=all&per_page=100`, signal);
  return [
    ...new Set(
      pages
        .flat()
        .filter((user) => user.login)
        .map((user) => user.login!),
    ),
  ].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

const MENTION_TTL_MS = 10 * 60 * 1000;
const mentionCache = new Map<string, { at: number; users: Promise<string[]> }>();

// fetchRepoMentionUsers, memoized per repo for MENTION_TTL_MS. Concurrent callers share one
// request; a failed request is not cached. Call it lazily (e.g. when the mention picker opens):
// the list is paginated and can take a while on large orgs.
export function getMentionUsers(repo: string): Promise<string[]> {
  const key = repo.toLowerCase();
  const hit = mentionCache.get(key);
  if (hit && Date.now() - hit.at < MENTION_TTL_MS) return hit.users;
  const users = fetchRepoMentionUsers(repo);
  const entry = { at: Date.now(), users };
  mentionCache.set(key, entry);
  users.catch(() => {
    if (mentionCache.get(key) === entry) mentionCache.delete(key);
  });
  return users;
}

export async function replyToThread(repo: string, number: number, commentId: string, body: string): Promise<void> {
  const path = `repos/${repo}/pulls/${number}/comments/${commentId}/replies`;
  const auth = githubAuth();
  if (auth) await restJson(auth, path, { method: 'POST', body: { body } });
  else await gh(['api', '-X', 'POST', path, '--input', '-'], { input: JSON.stringify({ body }) });
}

// A comment on the PR's conversation, not on a line.
export async function postIssueComment(repo: string, number: number, body: string): Promise<{ url: string }> {
  const path = `repos/${repo}/issues/${number}/comments`;
  const auth = githubAuth();
  const res = auth
    ? await restJson<{ html_url: string }>(auth, path, { method: 'POST', body: { body } })
    : (JSON.parse(await gh(['api', '-X', 'POST', path, '--input', '-'], { input: JSON.stringify({ body }) })) as { html_url: string });
  return { url: res.html_url };
}

export async function setCommentReaction(nodeId: string, content: ReactionContent, remove: boolean): Promise<ReactionGroup[]> {
  const action = remove ? 'removeReaction' : 'addReaction';
  const data = await graphql<Record<string, { reactionGroups: ReactionGroup[] }>>(
    `mutation($subject: ID!, $content: ReactionContent!) {
      ${action}(input: { subjectId: $subject, content: $content }) {
        reactionGroups { content reactors { totalCount } viewerHasReacted }
      }
    }`,
    { subject: nodeId, content },
  );
  return data[action].reactionGroups;
}

export async function fetchHeadSha(repo: string, number: number): Promise<string> {
  const auth = githubAuth();
  if (auth) return (await restJson<{ head: { sha: string } }>(auth, `repos/${repo}/pulls/${number}`)).head.sha;
  const out = await gh(['api', `repos/${repo}/pulls/${number}`, '--jq', '.head.sha']);
  return out.trim();
}

let viewer: Promise<string> | undefined;

// The signed-in user's login. Fetched once per process; a failed request is retried next call.
export function viewerLogin(signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(signal.reason as Error);
  if (!viewer) {
    const p = Promise.resolve()
      .then(githubAuth)
      .then((auth) => (auth ? restJson<{ login: string }>(auth, 'user').then((u) => u.login) : gh(['api', 'user', '--jq', '.login']).then((out) => out.trim())));
    viewer = p;
    p.catch(() => {
      if (viewer === p) viewer = undefined;
    });
  }
  if (!signal) return viewer;
  const shared = viewer;
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// Tests only: forget memoized gh lookups.
export function resetGhCaches(): void {
  viewer = undefined;
  mentionCache.clear();
  resetGitHubAuth();
}

// `gh search prs` through the REST search API.
async function searchReviewRequests(auth: TokenAuth): Promise<ReviewRequest[]> {
  const q = encodeURIComponent('type:pr state:open review-requested:@me');
  const res = await restJson<{
    items: { number: number; title: string; html_url: string; updated_at: string; user: { login: string } | null; repository_url: string; draft?: boolean; labels?: { name: string }[] }[];
  }>(auth, `search/issues?q=${q}&per_page=50`);
  return res.items
    .map((r) => ({
      repo: r.repository_url.replace(/^.*\/repos\//, ''),
      number: r.number,
      title: r.title,
      author: r.user?.login ?? 'ghost',
      url: r.html_url,
      updatedAt: r.updated_at,
      isDraft: !!r.draft,
      labels: (r.labels ?? []).map((l) => l.name),
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listReviewRequests(): Promise<ReviewRequest[]> {
  const auth = githubAuth();
  if (auth) return searchReviewRequests(auth);
  const out = await gh(['search', 'prs', '--review-requested=@me', '--state=open', '--limit', '50', '--json', 'number,title,url,updatedAt,author,repository,isDraft,labels']);
  const rows = JSON.parse(out) as {
    number: number;
    title: string;
    url: string;
    updatedAt: string;
    author: { login: string };
    repository: { nameWithOwner: string };
    isDraft?: boolean;
    labels?: { name: string }[];
  }[];
  return rows
    .map((r) => ({
      repo: r.repository.nameWithOwner,
      number: r.number,
      title: r.title,
      author: r.author?.login ?? 'ghost',
      url: r.url,
      updatedAt: r.updatedAt,
      isDraft: !!r.isDraft,
      labels: (r.labels ?? []).map((l) => l.name),
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// The PR for the checked-out branch, as `gh pr view` finds it: by the branch it pushes to, open
// PRs first.
async function branchPRWithAuth(auth: TokenAuth, cwd: string): Promise<{ repo: string; number: number } | undefined> {
  const quiet = (args: string[]) =>
    git(cwd, args).then(
      (s) => s.trim(),
      () => '',
    );
  const branch = await quiet(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch) return undefined;
  const repo = await currentRepo(cwd);
  if (!repo) return undefined;
  const remote = await quiet(['config', '--get', `branch.${branch}.remote`]);
  const merge = (await quiet(['config', '--get', `branch.${branch}.merge`])).replace(/^refs\/heads\//, '');
  const headRepo = (remote && repoFromRemote(await quiet(['remote', 'get-url', remote]))) || repo;
  const head = encodeURIComponent(`${splitRepo(headRepo).owner}:${merge || branch}`);
  try {
    const pulls = await restJson<{ number: number; state: string }[]>(auth, `repos/${repo}/pulls?head=${head}&state=all&per_page=30`);
    const pr = pulls.find((p) => p.state === 'open') ?? pulls[0];
    return pr && { repo, number: pr.number };
  } catch (e) {
    const unavailable = ghUnavailable(e);
    if (unavailable) throw unavailable;
    return undefined;
  }
}

export async function currentBranchPR(cwd: string): Promise<{ repo: string; number: number } | undefined> {
  const auth = githubAuth();
  if (auth) return branchPRWithAuth(auth, cwd);
  try {
    const out = await gh(['pr', 'view', '--json', 'number,url'], { cwd });
    const { url } = JSON.parse(out) as { number: number; url: string };
    return parsePRArg(url);
  } catch (e) {
    const unavailable = ghUnavailable(e);
    if (unavailable) throw unavailable;
    return undefined;
  }
}

export async function postReview(repo: string, number: number, payload: ReviewPayload): Promise<{ id: number; url: string }> {
  const path = `repos/${repo}/pulls/${number}/reviews`;
  const auth = githubAuth();
  const res = auth
    ? await restJson<{ id: number; html_url: string }>(auth, path, { method: 'POST', body: payload })
    : (JSON.parse(await gh(['api', '-X', 'POST', path, '--input', '-'], { input: JSON.stringify(payload) })) as { id: number; html_url: string });
  return { id: res.id, url: res.html_url };
}

export async function setThreadResolved(threadId: string, resolved: boolean): Promise<boolean> {
  const action = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  const data = await graphql<Record<string, { thread: { isResolved: boolean } }>>(`mutation($id: ID!) { ${action}(input: { threadId: $id }) { thread { isResolved } } }`, { id: threadId });
  return data[action].thread.isResolved;
}

export interface ThreadReply {
  threadId: string;
  commentId?: string; // the thread's first comment, for the one-by-one fallback
  body: string;
}

const PENDING_REVIEW_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id reviews(states: PENDING, first: 5) { nodes { id viewerDidAuthor } } }
  }
}`;

// Thrown when replies posted one by one stop partway: `posted` are the threads that did get a
// reply, so a retry must not send those again.
export class PartialSendError extends Error {
  constructor(
    message: string,
    readonly posted: string[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PartialSendError';
  }
}

async function postOneByOne(repo: string, number: number, replies: ThreadReply[]): Promise<void> {
  const posted: string[] = [];
  for (const r of replies) {
    try {
      if (!r.commentId) throw new Error('A thread has no GitHub comment ID to reply to.');
      await replyToThread(repo, number, r.commentId, r.body);
      posted.push(r.threadId);
    } catch (e) {
      throw new PartialSendError((e as Error).message, posted, { cause: e });
    }
  }
}

export interface PostRepliesResult {
  batched: boolean;
  url?: string;
  fallbackReason?: string; // batching failed and the replies went one by one
}

// The viewer has a pending review on the PR (one started on GitHub). GitHub takes no reply while
// it is pending: a REST reply is refused (422, one pending review per user), and a GraphQL reply
// joins the pending review unposted. Submitting or discarding it there is the only way on.
export class PendingReviewError extends Error {
  constructor() {
    super('You have a pending review on this PR, started on GitHub. GitHub takes no replies while it is pending: submit or discard it there, then send again.');
    this.name = 'PendingReviewError';
  }
}

// The batched review was submitted, or probably was, but GitHub's answer was lost: the pending
// review could not be deleted afterwards, which means it is no longer pending. Nothing was
// posted again, since that would duplicate every reply.
export class UncertainSendError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UncertainSendError';
  }
}

// Replies to several threads as one "comment" review, so each reviewer gets one notification
// rather than one per reply. The replies sit in a pending review until it is submitted; if any
// step fails the pending review is deleted, so nothing half-posts, and the replies go one by
// one instead. When the viewer already has a pending review of their own (one started on
// GitHub), nothing can be posted (PendingReviewError, checked live). A failure partway through
// the one-by-one path throws a PartialSendError naming what did post.
export async function postThreadReplies(repo: string, number: number, headSha: string, replies: ThreadReply[]): Promise<PostRepliesResult> {
  if (!replies.length) return { batched: false };
  const { owner, name } = splitRepo(repo);
  const pr = (await graphql<{ repository: { pullRequest: { id: string; reviews: { nodes: { id: string; viewerDidAuthor: boolean }[] } } } }>(PENDING_REVIEW_QUERY, { owner, name, number })).repository
    .pullRequest;
  if (pr.reviews.nodes.some((r) => r.viewerDidAuthor)) throw new PendingReviewError();
  let reviewId: string | undefined;
  let submitting = false;
  try {
    const created = await graphql<{ addPullRequestReview: { pullRequestReview: { id: string } } }>(
      `
        mutation ($pr: ID!, $head: GitObjectID!) {
          addPullRequestReview(input: { pullRequestId: $pr, commitOID: $head }) {
            pullRequestReview {
              id
            }
          }
        }
      `,
      { pr: pr.id, head: headSha },
    );
    reviewId = created.addPullRequestReview.pullRequestReview.id;
    for (const r of replies) {
      await graphql(
        `
          mutation ($review: ID!, $thread: ID!, $body: String!) {
            addPullRequestReviewThreadReply(input: { pullRequestReviewId: $review, pullRequestReviewThreadId: $thread, body: $body }) {
              comment {
                id
              }
            }
          }
        `,
        { review: reviewId, thread: r.threadId, body: r.body },
      );
    }
    submitting = true;
    const submitted = await graphql<{ submitPullRequestReview: { pullRequestReview: { url: string } } }>(
      `
        mutation ($review: ID!) {
          submitPullRequestReview(input: { pullRequestReviewId: $review, event: COMMENT }) {
            pullRequestReview {
              url
            }
          }
        }
      `,
      { review: reviewId },
    );
    return { batched: true, url: submitted.submitPullRequestReview.pullRequestReview.url };
  } catch (e) {
    if (reviewId) {
      const deleted = await graphql(
        `
          mutation ($review: ID!) {
            deletePullRequestReview(input: { pullRequestReviewId: $review }) {
              clientMutationId
            }
          }
        `,
        { review: reviewId },
      ).then(
        () => true,
        () => false,
      );
      // Only a pending review can be deleted. One that can't be after the submit step was
      // submitted, and the answer was lost on the way back: posting again would duplicate it.
      if (submitting && !deleted) {
        throw new UncertainSendError(`GitHub's answer to the send was lost (${(e as Error).message}). The replies were probably posted: check the PR before sending again.`, { cause: e });
      }
    }
    await postOneByOne(repo, number, replies);
    return { batched: false, fallbackReason: (e as Error).message };
  }
}

// Asks these people (and teams, by slug in the repository owner's organization) to review;
// GitHub notifies each of them. Asking someone who already reviewed asks them again.
export async function requestReviewers(repo: string, number: number, logins: string[], teams: string[] = []): Promise<void> {
  if (!logins.length && !teams.length) return;
  await reviewRequests('POST', repo, number, logins, teams);
}

// Withdraws review requests that have not been answered yet.
export async function removeReviewRequests(repo: string, number: number, logins: string[], teams: string[] = []): Promise<void> {
  if (!logins.length && !teams.length) return;
  await reviewRequests('DELETE', repo, number, logins, teams);
}

async function reviewRequests(method: 'POST' | 'DELETE', repo: string, number: number, logins: string[], teams: string[]): Promise<void> {
  const path = `repos/${repo}/pulls/${number}/requested_reviewers`;
  const body = { reviewers: logins, team_reviewers: teams };
  const auth = githubAuth();
  if (auth) await restText(auth, path, { method, body });
  else await gh(['api', '-X', method, path, '--input', '-'], { input: JSON.stringify(body) });
}

// The teams of the repository owner's organization the viewer can see, by slug, to ask for a
// review. A team with no access to the repository is refused by GitHub when asked. A repository
// owned by a user has no teams.
export async function fetchOrgTeams(repo: string, signal?: AbortSignal): Promise<string[]> {
  const pages = await apiPages<{ slug: string }>(`orgs/${splitRepo(repo).owner}/teams?per_page=100`, signal).catch(() => [] as { slug: string }[][]);
  return pages.flat().map((t) => t.slug);
}

export interface PendingReviewers {
  author: string;
  users: string[]; // asked to review, and not answered since
  teams: string[]; // team slugs in the repository owner's organization
}

export async function fetchPendingReviewers(repo: string, number: number, signal?: AbortSignal): Promise<PendingReviewers> {
  type Raw = { user: { login: string } | null; requested_reviewers?: { login: string }[]; requested_teams?: { slug: string }[] };
  const path = `repos/${repo}/pulls/${number}`;
  const auth = githubAuth();
  const raw = auth ? await restJson<Raw>(auth, path, { signal }) : (JSON.parse(await gh(['api', path], { signal })) as Raw);
  return {
    author: raw.user?.login ?? 'ghost',
    users: (raw.requested_reviewers ?? []).map((u) => u.login),
    teams: (raw.requested_teams ?? []).map((t) => t.slug),
  };
}

// ---------- merging ----------

export type MergeMethod = 'squash' | 'merge' | 'rebase';

export type CheckState = 'passed' | 'failed' | 'pending' | 'skipped';

// One check on the head commit: a check run (GitHub Actions jobs and other apps) or a commit
// status.
export interface CheckItem {
  name: string;
  state: CheckState;
  outcome: string; // GitHub's conclusion or state, such as FAILURE, CANCELLED, IN_PROGRESS
  required: boolean;
  workflow?: string; // the Actions workflow that ran it
  event?: string; // what started that workflow run: push, pull_request, …
  app?: string; // the check's app, such as GitHub Actions; unset for a commit status
  jobId?: number; // an Actions job, whose log can be read
  url?: string; // the check's page
  description?: string; // a commit status's one-line description
  startedAt?: string;
  completedAt?: string;
}

export interface CheckSummary {
  passed: number;
  failed: number;
  pending: number;
  failedNames: string[];
  requiredFailed: string[];
  requiredPending: string[];
  items: CheckItem[];
}

export interface MergeStatus {
  id?: string; // the PR's node id
  repo: string;
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  viewerCanUpdate?: boolean; // the author or someone with write access: may mark a draft ready
  viewerCanUpdateBranch?: boolean; // the head is behind its base and the viewer may bring it up to date
  mergeable: string; // MERGEABLE, CONFLICTING or UNKNOWN (GitHub is still computing)
  mergeStateStatus: string; // CLEAN, UNSTABLE, BLOCKED, BEHIND, DIRTY, DRAFT, HAS_HOOKS or UNKNOWN
  reviewDecision: string; // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or ''
  headSha: string;
  headRef: string;
  baseRef: string;
  headRepo?: string; // owner/name of the head branch; unset when its repository is gone
  methods: MergeMethod[]; // what the repository allows, in GitHub's order
  viewerCanMerge: boolean; // write access or more
  deleteBranchOnMerge: boolean;
  checks: CheckSummary;
  unresolvedThreads: number;
  unresolvedThreadsAtLeast?: boolean; // the PR has more than the 100 threads read: the count is a lower bound
  commitCount: number;
  headCommittedAt?: string; // when the head commit was made (GitHub does not expose push time reliably)
}

const MERGE_STATUS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge
    pullRequest(number: $number) {
      id title state isDraft viewerCanUpdate viewerCanUpdateBranch mergeable mergeStateStatus reviewDecision headRefOid headRefName baseRefName
      headRepository { nameWithOwner }
      commits { totalCount }
      reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { isResolved } }
      last: commits(last: 1) { nodes { commit { committedDate statusCheckRollup { contexts(first: 100) { nodes {
        ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) databaseId detailsUrl startedAt completedAt
          checkSuite { app { name } workflowRun { event workflow { name } } } }
        ... on StatusContext { context state isRequired(pullRequestNumber: $number) targetUrl description createdAt }
      } } } } } }
    }
  }
}`;

type CheckContext = {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string | null;
  isRequired?: boolean;
  databaseId?: number | null;
  detailsUrl?: string | null;
  targetUrl?: string | null;
  description?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt?: string | null;
  workflowName?: string; // gh pr view's name for the check suite's workflow
  checkSuite?: { app?: { name: string } | null; workflowRun?: { event?: string; workflow?: { name: string } | null } | null } | null;
};

const PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];
const FAILED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];

// A check's identity across its runs: a re-run, or a workflow started again by a new event of
// the same kind (a label added, say), adds a run for the same job. A workflow that runs on
// both push and pull_request keeps one of each, as GitHub's checks list does.
function checkKey(c: CheckContext): string {
  if (c.context !== undefined) return `status\0${c.context}`;
  const run = c.checkSuite?.workflowRun;
  return `run\0${run?.workflow?.name ?? c.workflowName ?? c.checkSuite?.app?.name ?? ''}\0${c.name ?? ''}\0${run?.event ?? ''}`;
}

// The latest run of each check, as GitHub's checks list shows them. The API, and the rollup's
// own state, also count runs a later one replaced: an old failure keeps the rollup FAILURE
// after its re-run passed. A run not yet started is the newest.
export function latestChecks(contexts: CheckContext[]): CheckContext[] {
  const at = (c: CheckContext) => {
    const t = c.startedAt ?? c.createdAt;
    return t ? Date.parse(t) : Infinity;
  };
  const latest = new Map<string, CheckContext>();
  for (const c of contexts) {
    const k = checkKey(c);
    const seen = latest.get(k);
    if (!seen || at(c) >= at(seen)) latest.set(k, c);
  }
  return contexts.filter((c) => latest.get(checkKey(c)) === c);
}

// The rollup state of the checks' latest runs: FAILURE, PENDING, SUCCESS, or '' with none.
export function rollupState(checks: Pick<CheckSummary, 'passed' | 'failed' | 'pending'>): string {
  return checks.failed ? 'FAILURE' : checks.pending ? 'PENDING' : checks.passed ? 'SUCCESS' : '';
}

export function summarizeChecks(contexts: CheckContext[]): CheckSummary {
  const checks: CheckSummary = { passed: 0, failed: 0, pending: 0, failedNames: [], requiredFailed: [], requiredPending: [], items: [] };
  for (const c of latestChecks(contexts)) {
    const name = c.name ?? c.context ?? 'check';
    const running = !!c.status && c.status !== 'COMPLETED';
    const outcome = (running ? c.status! : (c.conclusion ?? c.state ?? '')).toUpperCase();
    let state: CheckState;
    if (running || !(PASSED.includes(outcome) || FAILED.includes(outcome))) {
      state = 'pending';
      checks.pending++;
      if (c.isRequired) checks.requiredPending.push(name);
    } else if (PASSED.includes(outcome)) {
      state = outcome === 'SUCCESS' ? 'passed' : 'skipped';
      checks.passed++;
    } else {
      state = 'failed';
      checks.failed++;
      checks.failedNames.push(name);
      if (c.isRequired) checks.requiredFailed.push(name);
    }
    const run = c.checkSuite?.workflowRun;
    const workflow = run?.workflow?.name ?? (c.workflowName || undefined);
    const app = c.checkSuite?.app?.name;
    checks.items.push({
      name,
      state,
      outcome,
      required: !!c.isRequired,
      ...(workflow ? { workflow } : {}),
      ...(run?.event ? { event: run.event } : {}),
      ...(app ? { app } : {}),
      ...(run && c.databaseId ? { jobId: c.databaseId } : {}),
      ...((c.detailsUrl ?? c.targetUrl) ? { url: (c.detailsUrl ?? c.targetUrl)! } : {}),
      ...(c.description ? { description: c.description } : {}),
      ...((c.startedAt ?? c.createdAt) ? { startedAt: (c.startedAt ?? c.createdAt)! } : {}),
      ...(c.completedAt ? { completedAt: c.completedAt } : {}),
    });
  }
  return checks;
}

export async function fetchMergeStatus(repo: string, number: number, signal?: AbortSignal): Promise<MergeStatus> {
  const { owner, name } = splitRepo(repo);
  type Raw = {
    repository: {
      viewerPermission: string | null;
      mergeCommitAllowed: boolean;
      squashMergeAllowed: boolean;
      rebaseMergeAllowed: boolean;
      deleteBranchOnMerge: boolean;
      pullRequest: {
        id: string;
        title: string;
        state: MergeStatus['state'];
        isDraft: boolean;
        viewerCanUpdate: boolean;
        viewerCanUpdateBranch: boolean;
        mergeable: string;
        mergeStateStatus: string;
        reviewDecision: string | null;
        headRefOid: string;
        headRefName: string;
        baseRefName: string;
        headRepository: { nameWithOwner: string } | null;
        commits: { totalCount: number };
        reviewThreads: { pageInfo: { hasNextPage: boolean }; nodes: { isResolved: boolean }[] };
        last: { nodes: { commit: { committedDate: string; statusCheckRollup: { contexts: { nodes: CheckContext[] } } | null } }[] };
      };
    };
  };
  const r = (await graphql<Raw>(MERGE_STATUS_QUERY, { owner, name, number }, signal)).repository;
  const pr = r.pullRequest;
  const methods: MergeMethod[] = [];
  if (r.mergeCommitAllowed) methods.push('merge');
  if (r.squashMergeAllowed) methods.push('squash');
  if (r.rebaseMergeAllowed) methods.push('rebase');
  return {
    id: pr.id,
    repo,
    number,
    title: pr.title,
    state: pr.state,
    isDraft: pr.isDraft,
    viewerCanUpdate: pr.viewerCanUpdate,
    viewerCanUpdateBranch: pr.viewerCanUpdateBranch,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision ?? '',
    headSha: pr.headRefOid,
    headRef: pr.headRefName,
    baseRef: pr.baseRefName,
    headRepo: pr.headRepository?.nameWithOwner,
    methods,
    viewerCanMerge: ['ADMIN', 'MAINTAIN', 'WRITE'].includes(r.viewerPermission ?? ''),
    deleteBranchOnMerge: r.deleteBranchOnMerge,
    checks: summarizeChecks(pr.last.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []),
    unresolvedThreads: pr.reviewThreads.nodes.filter((t) => !t.isResolved).length,
    ...(pr.reviewThreads.pageInfo.hasNextPage ? { unresolvedThreadsAtLeast: true } : {}),
    commitCount: pr.commits.totalCount,
    headCommittedAt: pr.last.nodes[0]?.commit.committedDate,
  };
}

// A GitHub Actions job's log, as plain text with a timestamp on each line. Logs can run to
// megabytes (exec's buffer allows 64 MB); GitHub redirects the request to where the log is stored.
export async function fetchJobLog(repo: string, jobId: number, signal?: AbortSignal): Promise<string> {
  const path = `repos/${repo}/actions/jobs/${jobId}/logs`;
  const auth = githubAuth();
  if (auth) return restText(auth, path, { accept: '*/*', signal });
  // gh refuses output with escape sequences unless told; gr sanitizes the log itself. Older gh
  // versions lack the flag, and pass escape sequences through without it.
  try {
    return await gh(['api', '--allow-escape-sequences', path], { signal });
  } catch (e) {
    if (!/unknown flag/i.test((e as Partial<ExecError>).stderr ?? '')) throw e;
    return gh(['api', path], { signal });
  }
}

// Takes a draft PR out of draft, which notifies its requested reviewers.
export async function markReadyForReview(prId: string): Promise<void> {
  await graphql(
    `
      mutation ($id: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $id }) {
          pullRequest {
            isDraft
          }
        }
      }
    `,
    { id: prId },
  );
}

export type BranchUpdateMethod = 'MERGE' | 'REBASE';

// Brings the PR's head branch up to date with its base, as GitHub's "Update branch" button
// does: a merge commit from the base, or a rebase onto it. Naming the head the viewer saw makes
// GitHub refuse the update if someone pushed in the meantime.
export async function updateBranch(prId: string, expectedHeadOid: string, method: BranchUpdateMethod): Promise<void> {
  await graphql(
    `
      mutation ($id: ID!, $head: GitObjectID!, $method: PullRequestBranchUpdateMethod!) {
        updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $head, updateMethod: $method }) {
          pullRequest {
            headRefOid
          }
        }
      }
    `,
    { id: prId, head: expectedHeadOid, method },
  );
}

export interface MergeRequest {
  method: MergeMethod;
  headSha: string; // GitHub refuses the merge if the head moved since
  title?: string; // squash and merge commits only
  message?: string;
}

export async function mergePR(repo: string, number: number, req: MergeRequest): Promise<{ sha: string }> {
  const path = `repos/${repo}/pulls/${number}/merge`;
  const body: Record<string, string> = { merge_method: req.method, sha: req.headSha };
  // Rebase replays the PR's commits as they are: GitHub ignores a message for it.
  if (req.method !== 'rebase') {
    if (req.title !== undefined) body.commit_title = req.title;
    if (req.message !== undefined) body.commit_message = req.message;
  }
  const auth = githubAuth();
  const res = auth
    ? await restJson<{ sha: string }>(auth, path, { method: 'PUT', body })
    : (JSON.parse(await gh(['api', '-X', 'PUT', path, '--input', '-'], { input: JSON.stringify(body) })) as { sha: string });
  return { sha: res.sha };
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  const path = `repos/${repo}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
  const auth = githubAuth();
  if (auth) await restText(auth, path, { method: 'DELETE' });
  else await gh(['api', '-X', 'DELETE', path]);
}

// ---------- your own PRs ----------

export interface AuthoredPR extends ReviewRequest {
  openThreads: number; // unresolved, and a reviewer has the last word
  unresolvedThreads: number;
  unresolvedThreadsAtLeast?: boolean; // more than the 100 threads read: the counts are lower bounds
  reviewDecision: string;
  mergeStateStatus: string;
  newReview: boolean; // a review submitted after the latest commit
  noReviewers: boolean; // in a repository you don't own: ready for review, yet nobody has been asked to review it and nobody has
  checks: string; // the head's rollup: SUCCESS, FAILURE, PENDING, ERROR, EXPECTED, or ''
}

const AUTHORED_QUERY = `
query($q: String!, $after: String) {
  viewer { login }
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url updatedAt isDraft reviewDecision mergeStateStatus
        author { login }
        repository { nameWithOwner owner { login } }
        labels(first: 10) { nodes { name } }
        reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { isResolved comments(last: 1) { nodes { author { login } } } } }
        latestReviews(first: 20) { nodes { author { login } submittedAt } }
        reviewRequests { totalCount }
        commits(last: 1) { nodes { commit { committedDate statusCheckRollup { contexts(first: 100) { nodes {
          ... on CheckRun { name status conclusion startedAt checkSuite { app { name } workflowRun { event workflow { name } } } }
          ... on StatusContext { context state createdAt }
        } } } } } }
      }
    }
  }
}`;

export const AUTHORED_LIMIT = 200;
const AUTHORED_PAGE = 50;

// The viewer's open PRs, a page of the search at a time up to AUTHORED_LIMIT: what each needs
// from its author. `truncated` says there were more than that.
export async function listAuthoredPRs(signal?: AbortSignal): Promise<{ prs: AuthoredPR[]; truncated: boolean }> {
  type Node = {
    number: number;
    title: string;
    url: string;
    updatedAt: string;
    isDraft: boolean;
    reviewDecision: string | null;
    mergeStateStatus: string | null;
    author: { login: string } | null;
    repository: { nameWithOwner: string; owner: { login: string } };
    labels: { nodes: { name: string }[] };
    reviewThreads: { pageInfo: { hasNextPage: boolean }; nodes: { isResolved: boolean; comments: { nodes: { author: { login: string } | null }[] } }[] };
    latestReviews: { nodes: { author: { login: string } | null; submittedAt: string | null }[] };
    reviewRequests: { totalCount: number };
    commits: { nodes: { commit: { committedDate: string; statusCheckRollup: { contexts: { nodes: CheckContext[] } } | null } }[] };
  };
  type Page = { viewer: { login: string }; search: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (Node | Record<string, never>)[] } };
  const nodes: Node[] = [];
  let me = '';
  let after = '';
  let more = false;
  for (let page = 0; page < AUTHORED_LIMIT / AUTHORED_PAGE; page++) {
    const data = await graphql<Page>(AUTHORED_QUERY, { q: 'is:pr is:open author:@me archived:false sort:updated-desc', ...(after ? { after } : {}) }, signal);
    me = data.viewer.login;
    nodes.push(...data.search.nodes.filter((n): n is Node => 'number' in n));
    more = data.search.pageInfo.hasNextPage && !!data.search.pageInfo.endCursor;
    if (!more) break;
    after = data.search.pageInfo.endCursor!;
  }
  const prs = nodes.map((n) => {
    const unresolved = n.reviewThreads.nodes.filter((t) => !t.isResolved);
    const lastCommit = n.commits.nodes[0]?.commit;
    return {
      repo: n.repository.nameWithOwner,
      number: n.number,
      title: n.title,
      author: n.author?.login ?? me,
      url: n.url,
      updatedAt: n.updatedAt,
      isDraft: n.isDraft,
      labels: n.labels.nodes.map((l) => l.name),
      unresolvedThreads: unresolved.length,
      ...(n.reviewThreads.pageInfo.hasNextPage ? { unresolvedThreadsAtLeast: true } : {}),
      openThreads: unresolved.filter((t) => (t.comments.nodes[0]?.author?.login ?? '') !== me).length,
      reviewDecision: n.reviewDecision ?? '',
      mergeStateStatus: n.mergeStateStatus ?? '',
      // Only in a repository that isn't yours: on your own, nobody is asked, and that is normal.
      noReviewers: n.repository.owner.login.toLowerCase() !== me.toLowerCase() && !n.isDraft && !n.reviewRequests.totalCount && !n.latestReviews.nodes.some((r) => r.author?.login !== me),
      newReview: n.latestReviews.nodes.some((r) => r.author?.login !== me && r.submittedAt && lastCommit && r.submittedAt > lastCommit.committedDate),
      checks: rollupState(summarizeChecks(lastCommit?.statusCheckRollup?.contexts.nodes ?? [])),
    };
  });
  return { prs, truncated: more };
}
