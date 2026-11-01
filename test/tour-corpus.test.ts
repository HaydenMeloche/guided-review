// How sample PRs split into hunks and chapters. Each test/fixtures/prs/<name>.sample is built
// into a throwaway repository and toured with no model; the tour's shape is written to
// <name>.tour.txt beside it. A change to diff parsing, fusing, move detection, classification or
// chapter building shows up as a diff of those files: review it, and accept it with
// `pnpm test -u`. Add a sample with test/fixtures/prs/make-sample.ts.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildStaticTour } from '../src/pipeline.js';
import type { PRInfo } from '../src/types.js';
import { parseSample, sampleRepo } from './helpers/samples.js';
import { summarize } from './helpers/summarize.js';

const DIR = path.join(import.meta.dirname, 'fixtures', 'prs');
const samples = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.sample'))
  .map((f) => f.replace(/\.sample$/, ''))
  .sort();

const pr = (base: string, head: string): PRInfo => ({
  repo: 'samples/repo',
  number: 1,
  title: 'Sample',
  body: '',
  url: 'https://github.com/samples/repo/pull/1',
  author: 'author',
  baseRef: 'main',
  headRef: 'feature',
  baseSha: base,
  headSha: head,
  commits: [],
  linkedIssues: [],
});

describe('tour corpus', () => {
  it.each(samples)(
    '%s',
    async (name) => {
      const sample = parseSample(fs.readFileSync(path.join(DIR, `${name}.sample`), 'utf8'));
      const repo = sampleRepo(sample);
      try {
        const tour = await buildStaticTour(pr(repo.base, repo.head), repo.diff, repo.root, () => {}, undefined, { mergeBase: repo.base });
        await expect(summarize(tour, sample.description)).toMatchFileSnapshot(path.join(DIR, `${name}.tour.txt`));
      } finally {
        repo.cleanup();
      }
    },
    60_000,
  );
});
