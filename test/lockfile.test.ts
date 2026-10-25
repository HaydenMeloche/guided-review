import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/diff/parse.js';
import { pairChanges, pairLockfiles, summarizeLockfile } from '../src/analysis/lockfile.js';

function summarize(path: string, body: string) {
  const { hunks } = parseUnifiedDiff(`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`);
  return summarizeLockfile(path, hunks);
}

describe('summarizeLockfile', () => {
  it('pnpm v9', () => {
    expect(
      summarize(
        'pnpm-lock.yaml',
        `@@ -100,4 +100,4 @@
 packages:
-  react@18.3.1:
+  react@19.0.0:
     resolution: {integrity: sha512-x}
+  '@types/node@22.1.0':
`,
      ),
    ).toBe('+1 added (@types/node), major: react 18.3.1→19.0.0');
  });

  it('yarn', () => {
    expect(
      summarize(
        'yarn.lock',
        `@@ -1,6 +1,6 @@
 "lodash@^4.17.0":
-  version "4.17.20"
+  version "4.17.21"
 left-pad@^1.0.0:
-  version "1.3.0"
`,
      ),
    ).toBe('-1 removed (left-pad), 1 minor/patch bump');
  });

  it('go.sum and Cargo.lock', () => {
    expect(
      summarize(
        'go.sum',
        `@@ -1,2 +1,2 @@
-github.com/pkg/errors v0.8.1 h1:abc=
-github.com/pkg/errors v0.8.1/go.mod h1:def=
+github.com/pkg/errors v0.9.1 h1:abc=
+github.com/pkg/errors v0.9.1/go.mod h1:def=
`,
      ),
    ).toBe('major: github.com/pkg/errors v0.8.1→v0.9.1');
    expect(
      summarize(
        'Cargo.lock',
        `@@ -1,4 +1,4 @@
 [[package]]
 name = "serde"
-version = "1.0.100"
+version = "1.0.200"
`,
      ),
    ).toBe('1 minor/patch bump');
  });

  it('falls back when nothing parses', () => {
    expect(summarize('poetry.lock', '@@ -1 +1 @@\n-content-hash = "a"\n+content-hash = "b"\n')).toBe('lockfile: 2 changed lines, no package changes detected');
  });
});

describe('pairLockfiles', () => {
  it('pairs a lockfile with the manifest in its own directory', () => {
    expect(pairLockfiles(['package-lock.json', 'svc/go.sum'], ['package.json', 'svc/go.mod'])).toEqual([
      { lockfile: 'package-lock.json', manifests: ['package.json'] },
      { lockfile: 'svc/go.sum', manifests: ['svc/go.mod'] },
    ]);
  });

  it('pairs a workspace root lockfile with the manifests below it that have no nearer lockfile', () => {
    expect(pairLockfiles(['pnpm-lock.yaml', 'apps/legacy/yarn.lock'], ['package.json', 'apps/web/package.json', 'packages/ui/package.json', 'apps/legacy/package.json'])).toEqual([
      { lockfile: 'apps/legacy/yarn.lock', manifests: ['apps/legacy/package.json'] },
      { lockfile: 'pnpm-lock.yaml', manifests: ['apps/web/package.json', 'package.json', 'packages/ui/package.json'] },
    ]);
    expect(pairLockfiles(['Cargo.lock'], ['crates/core/Cargo.toml'])).toEqual([{ lockfile: 'Cargo.lock', manifests: ['crates/core/Cargo.toml'] }]);
  });

  it('pairs go.sum, Gemfile.lock and the like only in their own directory', () => {
    expect(pairLockfiles(['go.sum', 'Gemfile.lock'], ['tools/go.mod', 'engines/x/Gemfile'])).toEqual([]);
  });

  it('leaves out a lockfile with no manifest, and a manifest of another kind', () => {
    expect(pairLockfiles(['yarn.lock'], [])).toEqual([]);
    expect(pairLockfiles(['yarn.lock'], ['Cargo.toml', 'web/package.jsonx'])).toEqual([]);
    // A manifest pairs with one lockfile, even when two of its kind changed beside it.
    expect(pairLockfiles(['package-lock.json', 'yarn.lock'], ['package.json'])).toEqual([{ lockfile: 'package-lock.json', manifests: ['package.json'] }]);
  });
});

describe('pairChanges', () => {
  const hunks = (path: string, body: string) => parseUnifiedDiff(`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`).hunks;

  it('splits the package changes into those each manifest hunk names and the indirect rest', () => {
    const lock = hunks(
      'pnpm-lock.yaml',
      `@@ -1,6 +1,6 @@
 packages:
-  react@18.3.1:
+  react@19.0.0:
-  scheduler@0.23.2:
+  scheduler@0.25.0:
+  '@types/node@22.1.0':
-  requests_toolbelt@1.0.0:
`,
    );
    const [web] = hunks('apps/web/package.json', `@@ -2,3 +2,3 @@\n   "dependencies": {\n-    "react": "^18.3.1",\n+    "react": "^19.0.0",\n`);
    const [api] = hunks('apps/api/package.json', `@@ -2,3 +2,4 @@\n   "dependencies": {\n-    "react": "^18.3.1",\n+    "react": "^19.0.0",\n+    "@types/node": "^22.1.0",\n`);
    web.id = 'web';
    api.id = 'api';
    const c = pairChanges('pnpm-lock.yaml', lock, [web, api]);
    expect(c.total).toBe(4);
    expect(c.direct.get('web')!.map((p) => p.name)).toEqual(['react']);
    expect(c.direct.get('api')!.map((p) => p.name)).toEqual(['react', '@types/node']);
    expect(c.indirect).toEqual([
      { name: 'scheduler', change: 'major', from: '0.23.2', to: '0.25.0' },
      { name: 'requests_toolbelt', change: 'removed', from: '1.0.0' },
    ]);
  });

  it('matches Python names loosely, and Go module paths', () => {
    const lock = hunks('uv.lock', `@@ -1,4 +1,4 @@\n [[package]]\n name = "Requests"\n-version = "2.31.0"\n+version = "2.32.3"\n`);
    const [manifest] = hunks('pyproject.toml', `@@ -1,2 +1,2 @@\n dependencies = [\n-  "requests>=2.31",\n+  "requests>=2.32",\n`);
    expect(pairChanges('uv.lock', lock, [manifest]).indirect).toEqual([]);
    const sum = hunks('go.sum', `@@ -1,2 +1,2 @@\n-github.com/x/y v1.2.0 h1:abc=\n+github.com/x/y v1.3.0 h1:def=\n`);
    const [mod] = hunks('go.mod', `@@ -3,2 +3,2 @@\n require (\n-\tgithub.com/x/y v1.2.0\n+\tgithub.com/x/y v1.3.0\n`);
    const c = pairChanges('go.sum', sum, [mod]);
    expect(c.direct.get(mod.id)).toEqual([{ name: 'github.com/x/y', change: 'minor', from: 'v1.2.0', to: 'v1.3.0' }]);
  });
});
