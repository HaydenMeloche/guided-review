// The GitHub API over HTTPS with a personal access token: what gr uses instead of `gh api`
// when config.json names a token.

export const DEFAULT_API_URL = 'https://api.github.com';

// A token and the API root it is sent to: api.github.com, or a GitHub Enterprise Server's
// https://<host>/api/v3.
export interface TokenAuth {
  token: string;
  apiUrl: string;
}

// GitHub Enterprise Server serves GraphQL at /api/graphql, beside the REST root /api/v3.
function graphqlUrl(apiUrl: string): string {
  return /\/api\/v3$/.test(apiUrl) ? apiUrl.replace(/\/v3$/, '/graphql') : `${apiUrl}/graphql`;
}

// A request GitHub answered with an error status.
export class GitHubHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubHttpError';
  }
}

export interface RestOptions {
  method?: string;
  body?: unknown;
  accept?: string;
  signal?: AbortSignal;
}

async function request(auth: TokenAuth, url: string, opts: RestOptions = {}): Promise<Response> {
  const method = opts.method ?? 'GET';
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Accept: opts.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'guided-review',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let detail = text.slice(0, 300);
    try {
      detail = (JSON.parse(text) as { message?: string }).message ?? detail;
    } catch {
      // not JSON: keep the text
    }
    const hint = response.status === 401 ? ' (the GitHub token was rejected; check it or run gr config)' : '';
    throw new GitHubHttpError(`GitHub API ${method} ${new URL(url).pathname} failed: HTTP ${response.status}: ${detail}${hint}`, response.status);
  }
  return response;
}

// `path` is relative to the API root, like the paths `gh api` takes.
export async function restText(auth: TokenAuth, path: string, opts: RestOptions = {}): Promise<string> {
  return (await request(auth, `${auth.apiUrl}/${path}`, opts)).text();
}

export async function restJson<T>(auth: TokenAuth, path: string, opts: RestOptions = {}): Promise<T> {
  return (await (await request(auth, `${auth.apiUrl}/${path}`, opts)).json()) as T;
}

// Every page of a list endpoint, following the Link header like `gh api --paginate --slurp`.
export async function restPages<T>(auth: TokenAuth, path: string, opts: RestOptions = {}): Promise<T[][]> {
  const pages: T[][] = [];
  const origin = new URL(auth.apiUrl).origin;
  let url: string | undefined = `${auth.apiUrl}/${path}`;
  while (url) {
    const response = await request(auth, url, opts);
    pages.push((await response.json()) as T[]);
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
    // Only ever send the token back to the API host.
    url = next && new URL(next).origin === origin ? next : undefined;
  }
  return pages;
}

export async function graphqlRequest<T>(auth: TokenAuth, query: string, variables: Record<string, string | number>, signal?: AbortSignal): Promise<{ data: T; errors?: { message: string }[] }> {
  const response = await request(auth, graphqlUrl(auth.apiUrl), { method: 'POST', body: { query, variables }, signal });
  return (await response.json()) as { data: T; errors?: { message: string }[] };
}

// The web host git clones from for an API root: github.com for api.github.com, otherwise the
// Enterprise Server's own host.
export function webHost(apiUrl: string): string {
  const host = new URL(apiUrl).host;
  return host === 'api.github.com' ? 'github.com' : host;
}
