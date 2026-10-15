// Writes a sample PR for test/tour-corpus.test.ts from two commits of a git repository:
//
//   pnpm tsx test/fixtures/prs/make-sample.ts <name> <base> <head> [repo] [description]
//
// The sample holds the base version of every file the PR touches and the PR's patch, which is
// all the static tour needs. Only take samples from code that may be published with this repo.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { formatSample } from '../../helpers/samples.js';

const [name, base, head, repo = process.cwd(), description = `${base}..${head}`] = process.argv.slice(2);
if (!name || !base || !head) {
  process.stderr.write('usage: make-sample.ts <name> <base> <head> [repo] [description]\n');
  process.exit(1);
}
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const patch = git('diff', '-M', base, head);
const touched = git('diff', '-M', '--name-status', base, head)
  .split('\n')
  .filter(Boolean)
  .map((row) => row.split('\t'))
  .filter(([status]) => !status.startsWith('A'))
  .map(([, from]) => from);
const files = Object.fromEntries(touched.map((p) => [p, git('show', `${base}:${p}`)]));

const out = path.join(path.dirname(new URL(import.meta.url).pathname), `${name}.sample`);
fs.writeFileSync(out, formatSample({ description, files, patch }));
process.stdout.write(`wrote ${out}: ${touched.length} base file(s), ${patch.split('\n').length} patch lines\n`);
