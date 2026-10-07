import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/diff/parse.js';
import { matchGlob } from '../src/util/glob.js';

const DIFF = `diff --git a/src/billing/invoice.ts b/src/billing/invoice.ts
index 1111111..2222222 100644
--- a/src/billing/invoice.ts
+++ b/src/billing/invoice.ts
@@ -1,5 +1,6 @@
 import { db } from '../db';
-export function total(items: Item[]) {
+export function total(items: Item[], tax = 0) {
+  const base = items.reduce((s, i) => s + i.price, 0);
   return items.reduce((s, i) => s + i.price, 0);
 }
 
@@ -20,3 +21,3 @@ export function send() {
   const x = 1;
-  return x;
+  return x + 1;
 }
\\ No newline at end of file
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const gone = true;
diff --git a/src/a.ts b/src/moved/a.ts
similarity index 100%
rename from src/a.ts
rename to src/moved/a.ts
diff --git a/logo.png b/logo.png
index 5555555..6666666 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`;

describe('parseUnifiedDiff', () => {
  const { files, hunks } = parseUnifiedDiff(DIFF);

  it('parses files and statuses', () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['src/billing/invoice.ts', 'modified'],
      ['src/new.ts', 'added'],
      ['src/old.ts', 'deleted'],
      ['src/moved/a.ts', 'renamed'],
      ['logo.png', 'modified'],
      ['run.sh', 'modified'],
    ]);
    expect(files[3].oldPath).toBe('src/a.ts');
    expect(files[3].hunkIds).toEqual([]);
    expect(files[4].binary).toBe(true);
  });

  it('numbers lines and counts changes', () => {
    const inv = files[0];
    expect(inv.additions).toBe(3);
    expect(inv.deletions).toBe(2);
    const h = hunks[0];
    expect(h.lines[0]).toEqual({ kind: 'ctx', text: "import { db } from '../db';", oldLine: 1, newLine: 1 });
    expect(h.lines[1]).toMatchObject({ kind: 'del', oldLine: 2 });
    expect(h.lines[2]).toMatchObject({ kind: 'add', newLine: 2 });
    expect(h.lines[3]).toMatchObject({ kind: 'add', newLine: 3 });
    expect(h.lines[4]).toMatchObject({ kind: 'ctx', oldLine: 3, newLine: 4 });
    expect(h.lines[6]).toMatchObject({ kind: 'ctx', text: '', oldLine: 5, newLine: 6 });
    const h2 = hunks[1];
    expect(h2.newStart).toBe(21);
    expect(h2.lines.at(-1)).toMatchObject({ kind: 'ctx', text: '}', newLine: 23 });
  });

  it('gives stable ids and content hashes independent of line numbers', () => {
    expect(hunks[0].id).toMatch(/^h_[0-9a-f]{10}$/);
    const again = parseUnifiedDiff(DIFF);
    expect(again.hunks[0].id).toBe(hunks[0].id);
    const shifted = parseUnifiedDiff(DIFF.replace('@@ -20,3 +21,3 @@', '@@ -40,3 +41,3 @@'));
    expect(shifted.hunks[1].contentHash).toBe(hunks[1].contentHash);
    expect(shifted.hunks[1].id).not.toBe(hunks[1].id);
  });

  it('sets defaults', () => {
    expect(hunks[0]).toMatchObject({ risk: 0, riskReasons: [], tests: [], coverage: 'n/a', symbols: [] });
    expect(files[0].kind).toBe('logic');
  });

  it('handles counts omitted from hunk headers', () => {
    const { hunks } = parseUnifiedDiff(`diff --git a/x b/x
--- a/x
+++ b/x
@@ -3 +3 @@
-a
+b
`);
    expect(hunks[0]).toMatchObject({ oldLines: 1, newLines: 1, oldStart: 3 });
    expect(hunks[0].lines).toHaveLength(2);
  });
});

describe('matchGlob', () => {
  it('matches globs', () => {
    expect(matchGlob('*.ts', 'src/a/b.ts')).toBe(true);
    expect(matchGlob('src/**/*.gen.ts', 'src/a/b/c.gen.ts')).toBe(true);
    expect(matchGlob('src/**/*.gen.ts', 'src/c.gen.ts')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/a/b.ts')).toBe(false);
    expect(matchGlob('{a,b}/*.js', 'b/x.js')).toBe(true);
    expect(matchGlob('docs/', 'docs/x/y.md')).toBe(true);
    expect(matchGlob('file?.txt', 'file1.txt')).toBe(true);
  });
});
