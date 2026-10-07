import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultBaseRef, hasCommit, prDiff, mergeBaseOf } from '../src/git/worktree.js';
import { parseUnifiedDiff } from '../src/diff/parse.js';
import { clearBaseCache, primeBaseCache, readBase, readBlobs } from '../src/git/blobs.js';

// Real git on a temp repo: main and a feature branch that diverged after main moved on.
let dir: string;
let repo: string;
let base: string;
let head: string;
let mainTip: string;

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-git-'));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write('src/a.ts', Array.from({ length: 40 }, (_, i) => `export const a${i} = ${i};`).join('\n') + '\n');
  write('src/b.ts', 'export function b() {\n  return 1;\n}\n');
  write('docs/old-name.md', Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n');
  write('big.txt', 'x'.repeat(5000));
  write('ünïcode.ts', 'export const s = "héllo";\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-qb', 'feature');
  write('src/a.ts', fs.readFileSync(path.join(repo, 'src/a.ts'), 'utf8').replace('a3 = 3', 'a3 = 33').replace('a30 = 30', 'a30 = 300'));
  fs.rmSync(path.join(repo, 'src/b.ts'));
  git(repo, 'mv', 'docs/old-name.md', 'docs/new-name.md');
  write('src/c.ts', 'export const c = 3;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'feature');
  head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  write('src/main-only.ts', 'export const m = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'main moves on');
  mainTip = git(repo, 'rev-parse', 'HEAD');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('prDiff', () => {
  it("matches GitHub's three-dot diff even with user diff settings that would change it", async () => {
    // What GitHub serves for the PR: git's default three-dot diff, 11-char abbreviations.
    const github = git(repo, 'diff', '--abbrev=11', `${mainTip}...${head}`) + '\n';
    // The reviewer's own config must not leak into the tour's diff.
    git(repo, 'config', 'diff.noprefix', 'true');
    git(repo, 'config', 'diff.algorithm', 'histogram');
    git(repo, 'config', 'diff.context', '8');
    git(repo, 'config', 'diff.renames', 'false');
    try {
      const mb = await mergeBaseOf(repo, mainTip, head);
      expect(mb).toBe(base);
      const local = await prDiff(repo, mb!, head);
      expect(local).toBe(github);
      expect(local).toContain('rename from docs/old-name.md');
      expect(local).not.toContain('main-only');
    } finally {
      for (const k of ['diff.noprefix', 'diff.algorithm', 'diff.context', 'diff.renames']) git(repo, 'config', '--unset', k);
    }
  });

  it('diffs against the working tree without a head, with uncommitted changes and pinned prefixes (gr preview)', async () => {
    git(repo, 'config', 'diff.noprefix', 'true');
    git(repo, 'config', 'diff.mnemonicPrefix', 'true');
    write('src/main-only.ts', 'export const m = 2;\n');
    try {
      const diff = await prDiff(repo, base);
      expect(diff).toContain('diff --git a/src/main-only.ts b/src/main-only.ts');
      expect(diff).toContain('+export const m = 2;'); // uncommitted
      expect(parseUnifiedDiff(diff).files.map((f) => f.path)).toEqual(['src/main-only.ts']);
    } finally {
      git(repo, 'checkout', '--', 'src/main-only.ts');
      for (const k of ['diff.noprefix', 'diff.mnemonicPrefix']) git(repo, 'config', '--unset', k);
    }
  });

  it('includes untracked files without touching the real index (gr preview)', async () => {
    write('src/brand-new.ts', 'export const fresh = 1;\n');
    const indexBefore = fs.readFileSync(path.join(repo, '.git', 'index'));
    try {
      const diff = await prDiff(repo, base);
      expect(diff).toContain('diff --git a/src/brand-new.ts b/src/brand-new.ts');
      expect(diff).toContain('new file mode');
      expect(diff).toContain('+export const fresh = 1;');
      expect(fs.readFileSync(path.join(repo, '.git', 'index')).equals(indexBefore)).toBe(true);
      expect(git(repo, 'status', '--porcelain')).toContain('?? src/brand-new.ts');
    } finally {
      fs.rmSync(path.join(repo, 'src/brand-new.ts'));
    }
  });

  it('reports no merge base for an unknown commit', async () => {
    expect(await mergeBaseOf(repo, 'f'.repeat(40), head)).toBeUndefined();
  });

  it('rejects instead of reporting no merge base when aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(mergeBaseOf(repo, mainTip, head, controller.signal)).rejects.toThrow('stop');
    await expect(hasCommit(repo, head, controller.signal)).rejects.toThrow('stop');
  });
});

describe('defaultBaseRef', () => {
  const noRepo = async () => undefined;

  it('uses the local default branch when there is no remote', async () => {
    expect(await defaultBaseRef(repo, noRepo)).toEqual({ name: 'main', ref: 'refs/heads/main' });
  });

  it("prefers origin's copy of the branch origin/HEAD names", async () => {
    const clone = path.join(dir, 'clone-head');
    git(dir, 'clone', '-q', repo, clone);
    expect(await defaultBaseRef(clone, noRepo)).toEqual({ name: 'main', ref: 'refs/remotes/origin/main' });
    // Without origin/HEAD it still finds origin/main by name.
    git(clone, 'remote', 'set-head', 'origin', '-d');
    expect(await defaultBaseRef(clone, noRepo)).toEqual({ name: 'main', ref: 'refs/remotes/origin/main' });
  });

  it('ignores init.defaultBranch and falls back to master', async () => {
    const other = path.join(dir, 'trunk');
    fs.mkdirSync(other);
    git(other, 'init', '-q', '-b', 'trunk');
    git(other, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(other, 'config', 'init.defaultBranch', 'trunk'); // the user's preference, not the repo's default
    expect(await defaultBaseRef(other, noRepo)).toBeUndefined();
    git(other, 'branch', 'master');
    expect(await defaultBaseRef(other, noRepo)).toEqual({ name: 'master', ref: 'refs/heads/master' });
  });

  it('asks origin for its default branch when origin/HEAD is unset', async () => {
    const upstream = path.join(dir, 'upstream-master');
    fs.mkdirSync(upstream);
    git(upstream, 'init', '-q', '-b', 'master');
    git(upstream, 'commit', '-q', '--allow-empty', '-m', 'init');
    const clone = path.join(dir, 'clone-master');
    git(dir, 'clone', '-q', upstream, clone);
    git(clone, 'remote', 'set-head', 'origin', '-d');
    git(clone, 'branch', 'main'); // a stray local main must not win over origin's master
    expect(await defaultBaseRef(clone, noRepo)).toEqual({ name: 'master', ref: 'refs/remotes/origin/master' });
  });

  it("prefers origin's main or master over either local branch when nothing names a default", async () => {
    const other = path.join(dir, 'unreachable');
    fs.mkdirSync(other);
    git(other, 'init', '-q', '-b', 'main');
    git(other, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(other, 'remote', 'add', 'origin', path.join(dir, 'does-not-exist'));
    git(other, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
    expect(await defaultBaseRef(other, noRepo)).toEqual({ name: 'master', ref: 'refs/remotes/origin/master' });
    git(other, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(await defaultBaseRef(other, noRepo)).toEqual({ name: 'main', ref: 'refs/remotes/origin/main' });
  });
});

describe('readBlobs', () => {
  it('reads many files at a revision in one batch, with caps and misses', async () => {
    const out = await readBlobs(repo, base, ['src/a.ts', 'src/b.ts', 'ünïcode.ts', 'src/c.ts', 'big.txt', 'src', 'nope/x.ts'], undefined, { maxBytes: 4096 });
    expect(out.get('src/a.ts')).toBe(git(repo, 'show', `${base}:src/a.ts`) + '\n');
    expect(out.get('src/b.ts')).toBe('export function b() {\n  return 1;\n}\n');
    expect(out.get('ünïcode.ts')).toBe('export const s = "héllo";\n');
    expect(out.get('src/c.ts')).toBeUndefined(); // added later
    expect(out.get('big.txt')).toBeUndefined(); // over the cap
    expect(out.get('src')).toBeUndefined(); // a tree
    expect(out.get('nope/x.ts')).toBeUndefined();
  });

  it('returns undefined for everything outside a repository', async () => {
    const out = await readBlobs(dir, base, ['src/a.ts']);
    expect(out.get('src/a.ts')).toBeUndefined();
  });

  it('rejects when aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(readBlobs(repo, base, ['src/a.ts'], controller.signal)).rejects.toThrow('stop');
  });

  it('fetches the missing blobs of a blobless clone in one request', async () => {
    const clone = path.join(dir, 'blobless.git');
    const uploadPack = 'git -c uploadpack.allowFilter=true -c uploadpack.allowAnySHA1InWant=true upload-pack';
    git(dir, 'clone', '-q', '--bare', '--filter=blob:none', '--no-local', '-u', uploadPack, `file://${repo}`, clone);
    git(clone, 'config', 'remote.origin.uploadpack', uploadPack);
    const oid = git(repo, 'rev-parse', `${base}:src/a.ts`);
    // Not present locally before the read.
    expect(() => execFileSync('git', ['cat-file', '-e', oid], { cwd: clone, env: { ...env, GIT_NO_LAZY_FETCH: '1' }, stdio: 'ignore' })).toThrow();
    const out = await readBlobs(clone, base, ['src/a.ts', 'src/b.ts', 'docs/old-name.md']);
    expect(out.get('src/a.ts')).toBe(git(repo, 'show', `${base}:src/a.ts`) + '\n');
    expect(out.get('src/b.ts')).toBe('export function b() {\n  return 1;\n}\n');
    expect(out.get('docs/old-name.md')).toContain('line 19');
    git(clone, 'cat-file', '-e', oid); // now local
  });
});

describe('readBase', () => {
  it('serves primed files from memory and batches the rest', async () => {
    clearBaseCache();
    primeBaseCache(repo, base, new Map([['src/b.ts', 'primed']]));
    const [b, a, again] = await Promise.all([readBase(repo, base, 'src/b.ts'), readBase(repo, base, 'src/a.ts'), readBase(repo, base, 'src/a.ts')]);
    expect(b).toBe('primed');
    expect(a).toContain('export const a0 = 0;');
    expect(again).toBe(a);
    expect(await readBase(repo, base, 'missing.ts')).toBeUndefined();
  });
});
