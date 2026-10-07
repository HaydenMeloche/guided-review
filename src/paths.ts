import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Everything local lives under ~/.guided-review/ (override with GR_HOME for tests).
export function grHome(): string {
  const dir = process.env.GR_HOME ?? path.join(os.homedir(), '.guided-review');
  // Owner-only: it holds the config (which may contain an API key), drafts, and clones.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode does not apply to a directory that already exists.
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // not ours to change (e.g. GR_HOME pointing at a shared dir): keep going
  }
  return dir;
}

export function repoSlug(repo: string): string {
  return repo.replace('/', '__');
}
