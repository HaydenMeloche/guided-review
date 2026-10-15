// Sample PRs for the tour corpus test: the base version of each file a PR touches, and the PR's
// patch, in one plain-text file (test/fixtures/prs/*.sample) that no linter or test runner reads.
//
//   # what the PR is and where it came from
//   === file src/a.ts
//   <the file at the base>
//   === patch
//   diff --git a/src/a.ts b/src/a.ts
//   ...
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Sample {
  description: string;
  files: Record<string, string>; // path -> content at the base
  patch: string;
}

const FILE = '=== file ';
const PATCH = '=== patch';

export function formatSample(s: Sample): string {
  const description = s.description
    .split('\n')
    .map((l) => `# ${l}`)
    .join('\n');
  const files = Object.entries(s.files).map(([p, text]) => `${FILE}${p}\n${text.endsWith('\n') ? text : text + '\n'}`);
  return `${description}\n${files.join('')}${PATCH}\n${s.patch}`;
}

export function parseSample(text: string): Sample {
  const lines = text.split('\n');
  const description: string[] = [];
  const files: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length && lines[i].startsWith('#'); i++) description.push(lines[i].replace(/^# ?/, ''));
  while (i < lines.length && lines[i] !== PATCH) {
    if (!lines[i].startsWith(FILE)) throw new Error(`sample: expected "${FILE}<path>" or "${PATCH}" at line ${i + 1}`);
    const file = lines[i++].slice(FILE.length);
    const body: string[] = [];
    while (i < lines.length && lines[i] !== PATCH && !lines[i].startsWith(FILE)) body.push(lines[i++]);
    files[file] = body.join('\n') + '\n';
  }
  if (lines[i] !== PATCH) throw new Error(`sample: no "${PATCH}" section`);
  return { description: description.join('\n'), files, patch: lines.slice(i + 1).join('\n') };
}

// A throwaway repository with the base committed and the patch applied on top. Returns the two
// commits and the diff between them, as git (and GitHub) produce it.
export function sampleRepo(sample: Sample): { root: string; base: string; head: string; diff: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-sample-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', input: '' });
  git('init', '-q', '-b', 'main');
  for (const [p, text] of Object.entries(sample.files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), text);
  }
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  const patchFile = path.join(root, '.git', 'sample.patch');
  fs.writeFileSync(patchFile, sample.patch);
  git('apply', '--index', patchFile);
  git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD').trim();
  return { root, base, head, diff: git('diff', '-M', base, head), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
