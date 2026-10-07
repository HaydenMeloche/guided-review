import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Everything local lives under ~/.guided-review/ (override with GR_HOME for tests).
export function grHome(): string {
  const dir = process.env.GR_HOME ?? path.join(os.homedir(), '.guided-review');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function repoSlug(repo: string): string {
  return repo.replace('/', '__');
}
