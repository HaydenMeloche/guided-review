// How sample PRs split into hunks and chapters. Each test/fixtures/prs/<name>.sample is built
// into a throwaway repository and toured with no model; the tour's shape is written to
// <name>.tour.txt beside it. A change to diff parsing, fusing, move detection, classification or
// chapter building shows up as a diff of those files: review it, and accept it with
// `pnpm test -u`. Add a sample with test/fixtures/prs/make-sample.ts.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildStaticTour } from '../src/pipeline.js';
import type { DiffLine, Hunk, PRInfo, Tour } from '../src/types.js';
import { parseSample, sampleRepo } from './helpers/samples.js';

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

const count = (h: Hunk, kind: DiffLine['kind']) => h.lines.filter((l) => l.kind === kind).length;

// Moved blocks in a hunk, as "N lines moved to/from file:line", one per contiguous block.
function moves(h: Hunk): string[] {
  const out: string[] = [];
  h.lines.forEach((l, i) => {
    const prev = h.lines[i - 1];
    if (!l.moved) return;
    if (prev?.moved && prev.kind === l.kind && prev.moved.file === l.moved.file && prev.moved.line + 1 === l.moved.line) {
      out[out.length - 1] = out[out.length - 1].replace(/^(\d+)/, (n) => String(+n + 1));
      return;
    }
    out.push(`1 lines moved ${l.kind === 'del' ? 'to' : 'from'} ${l.moved.file}:${l.moved.line}`);
  });
  return out;
}

function hunkLine(h: Hunk): string {
  const tags = [
    `+${count(h, 'add')} -${count(h, 'del')}`,
    `risk ${h.risk}`,
    h.coverage,
    h.parts ? `fused ${h.parts.length}` : '',
    h.lines.some((l) => l.expanded) ? `${h.lines.filter((l) => l.expanded).length} gap lines` : '',
    h.importOnly ? 'imports only' : '',
  ].filter(Boolean);
  return `${h.file}  ${h.header.replace(/ @@.*/, ' @@')}  ${tags.join(' · ')}`;
}

// A plain-text picture of the tour's structure: no ids, hashes or model output.
export function summarize(tour: Tour, description: string): string {
  const out: string[] = description.split('\n').map((l) => `# ${l}`);
  const github = tour.files.length && Object.values(tour.hunks).reduce((n, h) => n + (h.parts?.length ?? 1), 0);
  out.push(`${tour.files.length} files, ${Object.keys(tour.hunks).length} hunks (${github} GitHub hunks)`, '');
  out.push('files:');
  for (const f of tour.files) out.push(`  ${f.path}  ${f.status} · ${f.kind}${f.oldPath ? ` · from ${f.oldPath}` : ''}`);
  tour.chapters.forEach((c, i) => {
    const marks = [c.kind, c.collapsed ? 'collapsed' : '', c.optional ? 'optional' : '', c.lowConfidence ? 'low confidence' : ''].filter(Boolean).join(' · ');
    out.push('', `${i + 1}. ${c.title}  [${marks}]${c.entryPoint ? `  entry ${c.entryPoint}` : ''}`);
    for (const id of c.hunkIds) {
      const h = tour.hunks[id];
      out.push(`   ${hunkLine(h)}`);
      for (const m of moves(h)) out.push(`     ↕ ${m}`);
      for (const t of h.tests) out.push(`     test ${t.testFile} › ${t.testName} (${t.source})`);
      if (h.covers) out.push(`     covers ${h.covers.file}:${h.covers.startLine}`);
      if (c.orphanReasons[id]) out.push(`     orphan: ${c.orphanReasons[id]}`);
    }
    for (const id of c.linkedHunkIds) out.push(`   linked ${hunkLine(tour.hunks[id])}`);
    for (const item of c.checklist ?? []) out.push(`   checklist ${item.item}`);
  });
  if (tour.flags.length) out.push('', 'flags:', ...tour.flags.map((f) => `  ${f.kind}: ${f.message}`));
  if (tour.notes.length) out.push('', 'notes:', ...tour.notes.map((n) => `  ${n}`));
  return out.join('\n') + '\n';
}

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
