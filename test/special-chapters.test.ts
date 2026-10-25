import { describe, expect, it } from 'vitest';
import { chapterBatches, chapterPrompt, lockPairOf, MINOR_SUMMARY_ID, minorHunkIds } from '../src/agent/prompts.js';
import { isDependencyHunk, isDependencyManifest } from '../src/analysis/dependencies.js';
import { buildChapters, fileOrderChapters } from '../src/analysis/flows.js';
import { specialKindOf } from '../src/analysis/special.js';
import { buildSymbolIndex } from '../src/analysis/symbols.js';
import { applyChapterResult } from '../src/pipeline.js';
import { ctx } from './fixtures/invoiceFlow.js';
import { diffLines, filesFor, hunk, tour } from './fixtures/tour.js';
import type { Chapter, DiffFile } from '../src/types.js';

const edit = (del: string, add: string) => diffLines([`-${del}`, `+${add}`], 3);
const manifest = { kind: 'config', kindReason: 'package manifest' } as const;

describe('dependency detection', () => {
  it('recognizes manifests across ecosystems', () => {
    for (const p of ['package.json', 'apps/web/package.json', 'pom.xml', 'build.gradle.kts', 'gradle/libs.versions.toml', 'go.mod', 'requirements-dev.txt', 'Api.csproj', 'Gemfile']) {
      expect(isDependencyManifest(p)).toBe(true);
    }
    expect(isDependencyManifest('tsconfig.json')).toBe(false);
    expect(isDependencyManifest('package-lock.json')).toBe(false);
  });

  it('flags hunks that change a dependency line, not other manifest edits', () => {
    expect(isDependencyHunk(hunk('h1', 'package.json', edit('    "zod": "^3.22.0",', '    "zod": "^4.0.0",')))).toBe(true);
    expect(isDependencyHunk(hunk('h2', 'pom.xml', edit('      <version>5.3.0</version>', '      <version>6.1.0</version>')))).toBe(true);
    expect(isDependencyHunk(hunk('h3', 'build.gradle', edit("  implementation 'com.squareup.okhttp3:okhttp:4.9.0'", "  implementation 'com.squareup.okhttp3:okhttp:4.12.0'")))).toBe(true);
    expect(isDependencyHunk(hunk('h4', 'requirements.txt', edit('requests==2.31.0', 'requests==2.32.3')))).toBe(true);
    expect(isDependencyHunk(hunk('h5', 'package.json', edit('    "build": "tsc",', '    "build": "tsc -b",')))).toBe(false);
    expect(isDependencyHunk(hunk('h6', 'src/app.ts', edit('    "zod": "^3.22.0",', '    "zod": "^4.0.0",')))).toBe(false);
  });
});

describe('dependencies chapter', () => {
  const dep = hunk('h_dep', 'package.json', edit('    "zod": "^3.22.0",', '    "zod": "^4.0.0",'));
  const script = hunk('h_script', 'package.json', edit('    "build": "tsc",', '    "build": "tsc -b",'));
  const hunks = { [dep.id]: dep, [script.id]: script };
  const files = filesFor([dep, script], {}, {}, manifest);

  it('moves dependency hunks out of config into their own chapter', () => {
    const { chapters } = buildChapters(files, hunks, buildSymbolIndex(files, hunks, ctx));
    expect(chapters.map((c) => [c.kind, c.hunkIds])).toEqual([
      ['dependencies', [dep.id]],
      ['config', [script.id]],
    ]);
  });

  it('marks file-order chapters with dependency edits', () => {
    expect(fileOrderChapters(files, hunks)[0].kind).toBe('dependencies');
  });

  it('asks for upgrade highlights instead of a description of the edit, and never folds bumps into a minor summary', () => {
    const lock = hunk('h_lock', 'package-lock.json', []);
    const dep2 = hunk('h_dep2', 'package.json', edit('    "vite": "^5.0.0",', '    "vite": "^6.0.0",'));
    const t = tour([dep, dep2, lock], [{ kind: 'dependencies', hunkIds: [dep.id, dep2.id] }], {
      files: [...filesFor([dep, dep2], {}, {}, manifest), ...filesFor([lock], {}, {}, { ...manifest, kind: 'generated', summary: 'major: zod 3.22.0→4.0.0' })],
    });
    expect(minorHunkIds(t, t.chapters[0])).toEqual([]);
    const p = chapterPrompt(t, t.chapters[0]);
    expect(p).toContain('Do not describe the edit to the file');
    expect(p).toContain('highlights of what is new');
    expect(p).toContain('added for the first time or removed');
    expect(p).toContain('high-level overview of the package');
    expect(p).toContain('package-lock.json: major: zod 3.22.0→4.0.0');
    expect(p).not.toContain('## Minor hunks');
  });
});

describe('special chapters', () => {
  const one = (path: string, line: string, extra: Partial<DiffFile> = {}) => {
    const h = hunk(`h_${path.replace(/\W/g, '_')}`, path, [{ kind: 'add', text: line, newLine: 1 }]);
    return { h, f: filesFor([h], {}, {}, { ...manifest, ...extra })[0] };
  };

  it('classifies hunks by path, and toolchain lines into dependencies', () => {
    const cases: [string, string, Partial<DiffFile>, string | undefined][] = [
      ['db/migrate/20260101_add_status.rb', 'add_column :invoices, :status, :string', { kind: 'logic' }, 'migrations'],
      ['prisma/migrations/1_init/migration.sql', 'ALTER TABLE "User" DROP COLUMN "name";', { kind: 'logic' }, 'migrations'],
      ['test/migrations/add_status.test.ts', 'it("runs")', { kind: 'test' }, undefined],
      ['api/openapi.yaml', '  /invoices:', {}, 'api'],
      ['proto/invoice.proto', '  string status = 3;', { kind: 'logic' }, 'api'],
      ['.github/workflows/ci.yml', 'on: pull_request_target', {}, 'ci'],
      ['infra/main.tf', 'resource "aws_s3_bucket" "b" {}', {}, 'infra'],
      ['deploy/api.yaml', 'replicas: 3', {}, 'infra'],
      ['Dockerfile', 'FROM node:22-alpine', {}, 'dependencies'],
      ['Dockerfile', 'RUN npm ci', {}, undefined],
      ['.nvmrc', '22', {}, 'dependencies'],
      ['go.mod', 'go 1.23', {}, 'dependencies'],
      ['pnpm-lock.yaml', '  zod@4.0.0:', { kind: 'generated' }, 'lockfiles'],
      ['dist/bundle.js', 'x', { kind: 'generated' }, undefined],
    ];
    for (const [path, line, extra, want] of cases) {
      const { h, f } = one(path, line, extra);
      expect([path, line, specialKindOf(f, h)]).toEqual([path, line, want]);
    }
  });

  it('orders special chapters after flows and before config, with lockfiles read with their manifests in dependencies', () => {
    const parts = [
      one('db/migrations/001.sql', 'ALTER TABLE t ADD c int;', { kind: 'logic' }),
      one('.github/workflows/ci.yml', 'permissions: write-all'),
      one('package.json', '    "zod": "^4.0.0",'),
      one('pnpm-lock.yaml', '  zod@4.0.0:', { kind: 'generated' }),
      one('infra/main.tf', 'resource "x" "y" {}'),
      one('schema/openapi.json', '"paths": {}'),
      one('config/app.yml', 'port: 8080'),
    ];
    const files = parts.map((p) => p.f);
    const hunks = Object.fromEntries(parts.map((p) => [p.h.id, p.h]));
    const { chapters } = buildChapters(files, hunks, buildSymbolIndex(files, hunks, ctx));
    expect(chapters.map((c) => c.kind)).toEqual(['migrations', 'api', 'dependencies', 'infra', 'ci', 'config']);
    expect(chapters.filter((c) => c.collapsed)).toEqual([]);
    const deps = chapters.find((c) => c.kind === 'dependencies')!;
    const [manifest, lock] = [parts[2].h.id, parts[3].h.id];
    expect(deps.hunkIds).toEqual([manifest, lock]);
    expect(deps.folded).toBeUndefined();
    expect(deps.lockPairs).toEqual([{ lockfile: 'pnpm-lock.yaml', hunkIds: [manifest], lockHunkIds: [lock] }]);
  });

  it('narrates the folded lockfile hunks apart from the manifest, as one summary', () => {
    const manifest = hunk('h_pkg', 'package.json', edit('    "zod": "^3.22.0",', '    "zod": "^4.0.0",'));
    const lock = hunk('h_lock', 'pnpm-lock.yaml', [
      { kind: 'del', text: '  zod@3.22.0:', oldLine: 10 },
      { kind: 'add', text: '  zod@4.0.0:', newLine: 10 },
    ]);
    const t = tour([manifest, lock], [{ kind: 'dependencies', hunkIds: [manifest.id, lock.id], folded: [lock.id] }]);
    expect(chapterBatches(t, t.chapters[0])).toEqual([[manifest.id], [lock.id]]);
    const manifestPart = { ...t.chapters[0], hunkIds: [manifest.id] };
    const lockPart = { ...t.chapters[0], hunkIds: [lock.id] };
    expect(minorHunkIds(t, manifestPart)).toEqual([]);
    expect(chapterPrompt(t, manifestPart)).toContain('end of life');
    expect(minorHunkIds(t, lockPart)).toEqual([lock.id]);
    const p = chapterPrompt(t, lockPart);
    expect(p).toContain('Major version changes (1): zod 3.22.0 → 4.0.0');
    expect(p).toContain('narrated separately');
  });

  it('asks each special chapter about meaning rather than the edit, with no minor summary', () => {
    const asks: [Chapter['kind'], string][] = [
      ['migrations', 'can be rolled back'],
      ['api', 'breaks existing clients'],
      ['infra', 'created, destroyed or replaced'],
      ['ci', 'not pinned to a commit SHA'],
      ['dependencies', 'end of life'],
    ];
    for (const [kind, phrase] of asks) {
      const hs = [hunk('h_a', 'x', edit('a', 'b')), hunk('h_b', 'x', edit('c', 'd'))];
      const t = tour(hs, [{ kind, hunkIds: ['h_a', 'h_b'] }]);
      expect(minorHunkIds(t, t.chapters[0])).toEqual([]);
      expect(chapterPrompt(t, t.chapters[0])).toContain(phrase);
    }
  });

  it('summarizes lockfiles from parsed changes in one call', () => {
    const lock = hunk('h_lock', 'pnpm-lock.yaml', [
      { kind: 'del', text: '  zod@3.22.0:', oldLine: 10 },
      { kind: 'add', text: '  zod@4.0.0:', newLine: 10 },
      { kind: 'add', text: '  left-pad@1.3.0:', newLine: 11 },
    ]);
    const lock2 = hunk('h_lock2', 'pnpm-lock.yaml', [{ kind: 'add', text: '  ms@2.1.3:', newLine: 90 }]);
    const t = tour([lock, lock2], [{ kind: 'lockfiles', hunkIds: [lock.id, lock2.id], collapsed: true }]);
    expect(minorHunkIds(t, t.chapters[0])).toEqual([lock.id, lock2.id]);
    expect(chapterBatches(t, t.chapters[0])).toEqual([[lock.id, lock2.id]]);
    const p = chapterPrompt(t, t.chapters[0]);
    expect(p).toContain('Major version changes (1): zod 3.22.0 → 4.0.0');
    expect(p).toContain('Added (2): left-pad 1.3.0, ms 2.1.3');
    expect(p).toContain('indirect (transitive) changes');
    expect(p).toContain(`id "${MINOR_SUMMARY_ID}"`);
    expect(p).not.toContain('```diff');

    const done = applyChapterResult(t, t.chapters[0].id, { hunks: [{ id: MINOR_SUMMARY_ID, narration: '- zod 4 drops x', citesCode: false }] }, { minorIds: [lock.id, lock2.id] });
    expect([done.hunks[lock.id].narration, done.hunks[lock2.id].narration]).toEqual(['- zod 4 drops x', '- zod 4 drops x']);
  });
});

describe('lockfiles paired with their manifests', () => {
  const pkg = (path: string, del: string, add: string) => hunk(`h_${path.replace(/\W/g, '_')}_${add.replace(/\W/g, '')}`, path, edit(del, add));
  const lockHunk = (path: string, lines: [string, string][]) =>
    hunk(
      `h_${path.replace(/\W/g, '_')}`,
      path,
      lines.flatMap(([del, add], i) => [...(del ? [{ kind: 'del' as const, text: del, oldLine: 10 + i }] : []), ...(add ? [{ kind: 'add' as const, text: add, newLine: 10 + i }] : [])]),
    );
  const build = (manifests: ReturnType<typeof hunk>[], locks: ReturnType<typeof hunk>[]) => {
    const files = [...filesFor(manifests, {}, {}, manifest), ...filesFor(locks, {}, {}, { ...manifest, kind: 'generated' })];
    const hunks = Object.fromEntries([...manifests, ...locks].map((h) => [h.id, h]));
    return buildChapters(files, hunks, buildSymbolIndex(files, hunks, ctx)).chapters.find((c) => c.kind === 'dependencies')!;
  };

  it('pairs a workspace root lockfile with the manifests below it, and folds a lockfile with none', () => {
    const web = pkg('apps/web/package.json', '    "react": "^18.2.0",', '    "react": "^19.0.0",');
    const api = pkg('apps/api/package.json', '    "zod": "^3.22.0",', '    "zod": "^4.0.0",');
    const docker = hunk('h_docker', 'Dockerfile', edit('FROM node:20', 'FROM node:22'));
    const engines = pkg('apps/api/package.json', '    "node": ">=20"', '    "node": ">=22"');
    const root = lockHunk('pnpm-lock.yaml', [['  react@18.2.0:', '  react@19.0.0:']]);
    const tool = lockHunk('tools/Gemfile.lock', [['    rake (13.0.0)', '    rake (13.2.1)']]);
    const deps = build([web, api, engines, docker], [root, tool]);
    expect(deps.lockPairs).toEqual([{ lockfile: 'pnpm-lock.yaml', hunkIds: [api.id, web.id], lockHunkIds: [root.id] }]);
    // The runtime lines keep their own pages; the unpaired lockfile is the summary the chapter opens on.
    expect(deps.folded).toEqual([tool.id]);
    expect(deps.summary).toContain('tools/Gemfile.lock');
    expect(deps.summary).not.toContain('pnpm-lock.yaml');
    expect(deps.hunkIds).toEqual([api.id, web.id, engines.id, docker.id, tool.id, root.id]);
    expect(deps.collapsed).toBe(false);
  });

  it('narrates each pair in one call, apart from the other hunks, and shares the narration and risk with every hunk of the pair', () => {
    const web = pkg('package.json', '    "react": "^18.2.0",', '    "react": "^19.0.0",');
    const docker = hunk('h_docker', 'Dockerfile', edit('FROM node:20', 'FROM node:22'));
    const lock = lockHunk('pnpm-lock.yaml', [
      ['  react@18.2.0:', '  react@19.0.0:'],
      ['  scheduler@0.23.0:', '  scheduler@0.25.0:'],
      ['  loose-envify@1.4.0:', '  loose-envify@1.4.1:'],
      ['', '  left-pad@1.3.0:'],
    ]);
    const lock2 = lockHunk('pnpm-lock.yaml', [['  js-tokens@4.0.0:', '']]);
    lock2.id = 'h_lock2';
    const deps = build([web, docker], [lock, lock2]);
    const t = tour([web, docker, lock, lock2], [deps]);
    const ch = t.chapters[0];
    const batches = chapterBatches(t, ch);
    expect(batches).toEqual([[docker.id], [web.id, lock.id, lock2.id]]);
    const pairPart = { ...ch, hunkIds: batches[1] };
    expect(lockPairOf(pairPart)?.lockfile).toBe('pnpm-lock.yaml');
    expect(lockPairOf({ ...ch, hunkIds: batches[0] })).toBeUndefined();
    expect(minorHunkIds(t, { ...ch, hunkIds: batches[0] })).toEqual([]);
    expect(minorHunkIds(t, pairPart)).toEqual([web.id, lock.id, lock2.id]);

    const p = chapterPrompt(t, pairPart);
    expect(p).toContain('```diff');
    expect(p).toContain('"react": "^19.0.0"');
    expect(p).toContain('Direct (named in the manifest hunks above):\n- react 18.2.0 → 19.0.0 (major)');
    expect(p).toContain('- Major version changes (1): scheduler 0.23.0 → 0.25.0');
    expect(p).toContain('- Minor and patch changes (1): loose-envify 1.4.0 → 1.4.1');
    expect(p).toContain('- Added (1): left-pad 1.3.0');
    expect(p).toContain('- Removed (1): js-tokens 4.0.0');
    expect(p).toContain(`id "${MINOR_SUMMARY_ID}"`);
    expect(p).toContain('highlights of what is new');
    expect(p).toContain('grep the repo');
    expect(p).toContain('If you do not know a release, say so');
    expect(p).toContain('1-2 bullets on the indirect changes');
    expect(p).not.toContain('scheduler@');

    const done = applyChapterResult(
      t,
      ch.id,
      { hunks: [{ id: MINOR_SUMMARY_ID, narration: '- react 18.2.0 → 19.0.0: drops x', citesCode: false, risk: 2, riskReason: 'react 19 removes x, used here' }] },
      { minorIds: minorHunkIds(t, pairPart), sharedRiskIds: lockPairOf(pairPart)!.hunkIds },
    );
    for (const id of [web.id, lock.id, lock2.id]) expect(done.hunks[id].narration).toBe('- react 18.2.0 → 19.0.0: drops x');
    expect(done.hunks[web.id].risk).toBe(2);
    expect(done.hunks[lock.id].risk).toBe(t.hunks[lock.id].risk);
    expect(done.hunks[docker.id].narration).toBeUndefined();
  });

  it('allows a longer narration when a pair has several direct dependencies', () => {
    const web = pkg('package.json', '    "react": "^18.2.0",', '    "react": "^19.0.0",');
    const dom = pkg('package.json', '    "react-dom": "^18.2.0",', '    "react-dom": "^19.0.0",');
    dom.id = 'h_dom';
    const lock = lockHunk('pnpm-lock.yaml', [
      ['  react@18.2.0:', '  react@19.0.0:'],
      ['  react-dom@18.2.0:', '  react-dom@19.0.0:'],
    ]);
    const deps = build([web, dom], [lock]);
    const t = tour([web, dom, lock], [deps]);
    expect(chapterBatches(t, t.chapters[0])).toEqual([[web.id, dom.id, lock.id]]);
    const p = chapterPrompt(t, t.chapters[0]);
    expect(p).toContain('- react 18.2.0 → 19.0.0 (major)\n- react-dom 18.2.0 → 19.0.0 (major)');
    expect(p).toContain('about 50 more for each direct dependency after the first');
  });

  it('leaves a manifest with no changed lockfile to its own pages and the stale-lockfile flag', () => {
    const web = pkg('package.json', '    "react": "^18.2.0",', '    "react": "^19.0.0",');
    const script = pkg('svc/package.json', '    "build": "tsc",', '    "build": "tsc -b",');
    const lock = lockHunk('svc/package-lock.json', [['', '      "version": "1.0.0"']]);
    const deps = build([web, script], [lock]);
    // svc/package.json changed no dependency, so its lockfile pairs with nothing; the root
    // manifest has no lockfile of its own (svc/ is below it, not above).
    expect(deps.lockPairs).toBeUndefined();
    expect(deps.folded).toEqual([lock.id]);
    expect(deps.hunkIds).toEqual([web.id, lock.id]);
  });
});
