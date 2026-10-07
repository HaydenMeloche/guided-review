import type { ExistingReview, ExistingThread, PRInfo, ReactionContent, ReactionGroup } from '../types.js';
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
  headRefName: string;
  baseRefName: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  isDraft: boolean;
  reviewDecision: string; // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or ''
  mergeable: string;
  labels: string[];
  body: string;
  checks: { passed: number; failed: number; pending: number; failedNames: string[] };
  files: { path: string; additions: number; deletions: number }[];
}

interface PRPreviewRaw {
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  isDraft: boolean;
  reviewDecision: string | null;
  mergeable: string;
  labels: { name: string }[];
  body: string;
  statusCheckRollup: { name?: string; context?: string; status?: string; conclusion?: string | null; state?: string | null }[] | null;
  files: { path: string; additions: number; deletions: number }[] | null;
}

// The fields of `gh pr view --json` that fetchPRPreview reads, through GraphQL.
const PR_PREVIEW_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefName baseRefName headRefOid additions deletions changedFiles isDraft reviewDecision mergeable body
      labels(first: 100) { nodes { name } }
      files(first: 100) { nodes { path additions deletions } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        ... on CheckRun { name status conclusion }
        ... on StatusContext { context state }
      } } } } } }
    }
  }
}`;

async function prPreviewRaw(repo: string, number: number): Promise<PRPreviewRaw> {
  if (githubAuth()) {
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
  const out = await gh([
    'pr',
    'view',
    String(number),
    '-R',
    repo,
    '--json',
    'headRefName,baseRefName,headRefOid,additions,deletions,changedFiles,isDraft,reviewDecision,mergeable,labels,body,statusCheckRollup,files',
  ]);
  return JSON.parse(out) as PRPreviewRaw;
}

// Everything the picker's preview pane shows, in one call.
export async function fetchPRPreview(repo: string, number: number): Promise<PRPreview> {
  const r = await prPreviewRaw(repo, number);
  const checks = { passed: 0, failed: 0, pending: 0, failedNames: [] as string[] };
  for (const c of r.statusCheckRollup ?? []) {
    const outcome = (c.conclusion ?? c.state ?? '').toUpperCase();
    if (c.status && c.status !== 'COMPLETED') checks.pending++;
    else if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(outcome)) checks.passed++;
    else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(outcome)) {
      checks.failed++;
      checks.failedNames.push(c.name ?? c.context ?? 'check');
    } else checks.pending++;
  }
  return {
    headRefName: r.headRefName,
    baseRefName: r.baseRefName,
    headSha: r.headRefOid,
    additions: r.additions,
    deletions: r.deletions,
    changedFiles: r.changedFiles,
    isDraft: r.isDraft,
    reviewDecision: r.reviewDecision ?? '',
    mergeable: r.mergeable,
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

const THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id path line originalLine isResolved isOutdated
          comments(first: 50) { nodes { id fullDatabaseId author { login } body createdAt reactionGroups { content reactors { totalCount } viewerHasReacted } } }
        }
      }
    }
  }
}`;

interface ThreadsQueryResult {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          id: string;
          path: string;
          line: number | null;
          originalLine: number | null;
          isResolved: boolean;
          isOutdated: boolean;
          comments: { nodes: { id: string; fullDatabaseId: string | number | null; author: { login: string } | null; body: string; createdAt: string; reactionGroups: ReactionGroup[] | null }[] };
        }[];
      };
    };
  };
}

export async function fetchThreads(repo: string, number: number, signal?: AbortSignal): Promise<ExistingThread[]> {
  const { owner, name } = splitRepo(repo);
  const nodes: ThreadsQueryResult['repository']['pullRequest']['reviewThreads']['nodes'] = [];
  let cursor: string | null = null;
  do {
    const data: ThreadsQueryResult = await graphql<ThreadsQueryResult>(THREADS_QUERY, { owner, name, number, ...(cursor ? { cursor } : {}) }, signal);
    const page: ThreadsQueryResult['repository']['pullRequest']['reviewThreads'] = data.repository.pullRequest.reviewThreads;
    nodes.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return nodes.map((t) => ({
    id: t.id,
    path: t.path,
    line: t.line ?? undefined,
    originalLine: t.originalLine ?? undefined,
    isResolved: t.isResolved,
    isOutdated: t.isOutdated,
    comments: t.comments.nodes.map((c) => ({
      id: c.fullDatabaseId == null ? undefined : String(c.fullDatabaseId),
      nodeId: c.id,
      author: c.author?.login ?? 'ghost',
      body: c.body,
      createdAt: c.createdAt,
      reactionGroups: c.reactionGroups ?? [],
    })),
  }));
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
