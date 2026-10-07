import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/diff/parse.js';
import { summarizeLockfile } from '../src/analysis/lockfile.js';

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
