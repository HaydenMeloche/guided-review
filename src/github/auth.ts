import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGitHubConfig, type GitHubConfig } from '../config.js';
import { DEFAULT_API_URL, webHost, type TokenAuth } from './api.js';

// GitHub access goes through the gh CLI unless config.json names a personal access token
// ("github": { "tokenEnv": ... } or { "tokenFile": ... }, plus an optional "apiUrl" for GitHub
// Enterprise Server); then gr calls the API over HTTPS.

export function expandHome(file: string): string {
  return file === '~' || file.startsWith('~/') ? path.join(os.homedir(), file.slice(1)) : file;
}

// The token a GitHub config points at. Throws when it names a variable or file that is unset or
// empty, rather than quietly falling back to gh.
export function readGitHubToken(config: GitHubConfig | undefined): string | undefined {
  if (config?.tokenEnv) {
    const token = process.env[config.tokenEnv]?.trim();
    if (!token) throw new Error(`the GitHub token variable $${config.tokenEnv} is not set; set it, or run gr config to change where the token is read from`);
    return token;
  }
  if (config?.tokenFile) {
    let token: string;
    try {
      token = fs.readFileSync(expandHome(config.tokenFile), 'utf8').trim();
    } catch (e) {
      throw new Error(`could not read the GitHub token file ${config.tokenFile}: ${(e as Error).message}; run gr config to change it`, { cause: e });
    }
    if (!token) throw new Error(`the GitHub token file ${config.tokenFile} is empty`);
    return token;
  }
  return undefined;
}

// The token and API root a GitHub config names, or undefined for gh.
export function resolveGitHubAuth(config: GitHubConfig | undefined): TokenAuth | undefined {
  const token = readGitHubToken(config);
  return token ? { token, apiUrl: config?.apiUrl ?? DEFAULT_API_URL } : undefined;
}

let cached: { auth?: TokenAuth; error?: Error } | undefined;

// The configured personal access token, or undefined to use gh. Read once per process.
export function githubAuth(): TokenAuth | undefined {
  if (!cached) {
    try {
      cached = { auth: resolveGitHubAuth(loadGitHubConfig()) };
    } catch (e) {
      cached = { error: e as Error };
    }
  }
  if (cached.error) throw cached.error;
  return cached.auth;
}

// The host PR links, issue links and remotes are on: github.com, or the Enterprise Server a
// token's apiUrl points at. An unreadable token is reported by the calls that need it.
export function githubWebHost(): string {
  try {
    const auth = githubAuth();
    return auth ? webHost(auth.apiUrl) : 'github.com';
  } catch {
    return 'github.com';
  }
}

// Tests only.
export function resetGitHubAuth(): void {
  cached = undefined;
}

// With a token, git clones and fetches over HTTPS from the GitHub host send it as a header. It
// goes through GIT_CONFIG_* so it is neither on the command line nor saved in the clone's config.
export function gitAuthEnv(): Record<string, string> | undefined {
  const auth = githubAuth();
  if (!auth) return undefined;
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.https://${webHost(auth.apiUrl)}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${auth.token}`).toString('base64')}`,
  };
}
