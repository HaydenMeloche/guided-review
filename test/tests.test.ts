import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/diff/parse.js';
import { classifyFiles } from '../src/analysis/kinds.js';
import { extractTestCases, namingTestFiles, pairTests } from '../src/analysis/tests.js';
import { isTestPath, testStem } from '../src/analysis/testPaths.js';
import type { Hunk } from '../src/types.js';

const INVOICE_TEST = `import { describe, it, expect } from 'vitest';
import { total, applyDiscount } from '../../src/billing/invoice';

describe('invoice', () => {
  it('sums items', () => {
    expect(total([{ price: 2 }, { price: 3 }])).toBe(5);
  });

  it.each([[1], [2]])('handles %s', (n) => {
    expect(n).toBeTruthy();
  });
});

test("unrelated", () => {
  const s = "}) not a close";
  expect(1).toBe(1);
});
`;

describe('extractTestCases', () => {
  it('extracts JS cases with describe prefixes and brace matching', () => {
    const cases = extractTestCases('t.test.ts', INVOICE_TEST);
    expect(cases.map((c) => [c.name, c.startLine, c.endLine])).toEqual([
      ['invoice > sums items', 5, 7],
      ['invoice > handles %s', 9, 11],
      ['unrelated', 14, 17],
    ]);
    expect(cases[0].lines[1]).toContain('total(');
  });

  it('extracts python and go cases', () => {
    const py = 'import pytest\n\ndef test_total():\n    assert total([]) == 0\n\n    x = 1\n\ndef helper():\n    pass\n';
    expect(extractTestCases('test_invoice.py', py).map((c) => [c.name, c.startLine, c.endLine])).toEqual([['test_total', 3, 6]]);
    const go = 'package x\n\nfunc TestTotal(t *testing.T) {\n\tif total() != 0 {\n\t\tt.Fatal()\n\t}\n}\n';
    expect(extractTestCases('x_test.go', go).map((c) => [c.name, c.startLine, c.endLine])).toEqual([['TestTotal', 3, 7]]);
  });

  it('extracts Java, C++, and Ruby cases', () => {
    const java = 'class StoreTest {\n  @Test\n  void saves() {\n    save(1);\n  }\n}\n';
    expect(extractTestCases('StoreTest.java', java).map((c) => c.name)).toEqual(['saves']);
    const cpp = 'TEST(Store, Saves) {\n  save(1);\n}\n';
    expect(extractTestCases('store_test.cpp', cpp).map((c) => c.name)).toEqual(['Store.Saves']);
    const ruby = 'describe Store do\n  it "saves" do\n    save(1)\n  end\nend\n';
    expect(extractTestCases('store_spec.rb', ruby).map((c) => [c.name, c.startLine, c.endLine])).toEqual([['saves', 2, 4]]);
  });
});

describe('namingTestFiles', () => {
  it('finds conventional test files', () => {
    const all = [
      'src/billing/invoice.ts',
      'src/billing/invoice.test.ts',
      'src/billing/__tests__/invoice.ts',
      'test/billing/invoice.test.ts',
      'src/other/invoice.py',
      'src/index.ts',
      'src/other/index.test.ts',
    ];
    expect(namingTestFiles('src/billing/invoice.ts', all)).toEqual(['src/billing/invoice.test.ts', 'src/billing/__tests__/invoice.ts', 'test/billing/invoice.test.ts']);
    // generic stems need a directory match
    expect(namingTestFiles('src/index.ts', all)).toEqual([]);
    expect(namingTestFiles('src/store.cpp', ['src/store_test.cpp', 'src/store_test.java'])).toEqual(['src/store_test.cpp']);
  });

  it('pairs C# and Swift tests with their sources', () => {
    expect(namingTestFiles('src/Store.cs', ['src/Store.cs', 'tests/StoreTests.cs', 'Tests/StoreTests.swift'])).toEqual(['tests/StoreTests.cs']);
    expect(namingTestFiles('Sources/App/Store.swift', ['Sources/App/Store.swift', 'Tests/AppTests/StoreTests.swift', 'tests/StoreTests.cs'])).toEqual(['Tests/AppTests/StoreTests.swift']);
  });
});

describe('test paths', () => {
  it('detects tests and the stem they cover with the same rules', () => {
    for (const [p, stem] of [
      ['src/invoice.test.ts', 'invoice'],
      ['pkg/server_test.go', 'server'],
      ['tests/test_api.py', 'api'],
      ['spec/store_spec.rb', 'store'],
      ['src/store_test.cc', 'store'],
      ['src/store-test.hpp', 'store'],
      ['src/FooTest.java', 'Foo'],
      ['src/FooTests.cs', 'Foo'],
      ['src/FooSpec.swift', 'Foo'],
    ]) {
      expect(isTestPath(p), p).toBe(true);
      expect(testStem(p), p).toBe(stem);
    }
    expect(isTestPath('src/invoice.ts')).toBe(false);
    expect(isTestPath('qa/invoice.ts', ['qa/**'])).toBe(true);
  });
});

function setup(diff: string, heads: Record<string, string>, extraFiles: string[] = [], root = '/nonexistent', symbols: string[][] = []) {
  const { files, hunks } = parseUnifiedDiff(diff);
  hunks.forEach((h, i) => (h.symbols = symbols[i] ?? []));
  const map: Record<string, Hunk> = Object.fromEntries(hunks.map((h) => [h.id, h]));
  const readHead = (p: string) => heads[p];
  classifyFiles(files, map, { gitattributes: '', readHead, config: { kinds: [], testPatterns: [], checklists: [] } });
  pairTests(files, map, { root, readHead, listFiles: () => [...new Set([...Object.keys(heads), ...extraFiles])] });
  return { files, hunks: map, list: hunks };
}

const SRC_DIFF = `diff --git a/src/billing/invoice.ts b/src/billing/invoice.ts
--- a/src/billing/invoice.ts
+++ b/src/billing/invoice.ts
@@ -1,3 +1,7 @@
 export function total(items) {
   return items.reduce((s, i) => s + i.price, 0);
 }
+
+export function applyDiscount(amount, pct) {
+  return amount * (1 - pct);
+}
@@ -20,2 +24,3 @@
 export function refund() {
+  log('refund');
 }
`;

describe('pairTests', () => {
  it('pairs by name with files matched by the repository test patterns', () => {
    const diff = 'diff --git a/src/store.ts b/src/store.ts\n--- a/src/store.ts\n+++ b/src/store.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n';
    const run = (testPatterns?: string[]) => {
      const { files, hunks } = parseUnifiedDiff(diff);
      const map: Record<string, Hunk> = Object.fromEntries(hunks.map((h) => [h.id, h]));
      files[0].kind = 'logic';
      pairTests(files, map, { root: '/nonexistent', readHead: () => undefined, listFiles: () => ['src/store.ts', 'qa/store.ts'], testPatterns });
      return hunks[0].tests.map((t) => t.testFile);
    };
    expect(run()).toEqual([]);
    expect(run(['qa/**'])).toEqual(['qa/store.ts']);
  });

  it('attaches added test lines as a diff beside matching code', () => {
    const testDiff = `diff --git a/src/billing/invoice.test.ts b/src/billing/invoice.test.ts
new file mode 100644
--- /dev/null
+++ b/src/billing/invoice.test.ts
@@ -0,0 +1,3 @@
+it('sums', () => {
+  expect(total([{ price: 2 }])).toBe(2);
+});
`;
    const { list } = setup(
      SRC_DIFF + testDiff,
      {
        'src/billing/invoice.ts': 'export function total(items) {}',
        'src/billing/invoice.test.ts': "it('sums', () => {\n  expect(total([{ price: 2 }])).toBe(2);\n});\n",
      },
      [],
      '/nonexistent',
      [['total']],
    );
    expect(list[0].tests[0]).toMatchObject({ testFileStatus: 'added', testChange: 'new', diffHunks: [{ lines: [{ kind: 'add' }, { kind: 'add' }, { kind: 'add' }] }] });
  });

  it('shows removed and added lines for a changed case, leaving unchanged cases as source', () => {
    const testDiff = `diff --git a/src/billing/invoice.test.ts b/src/billing/invoice.test.ts
--- a/src/billing/invoice.test.ts
+++ b/src/billing/invoice.test.ts
@@ -1,7 +1,7 @@
 it('sums', () => {
-  expect(total([{ price: 2 }])).toBe(1);
+  expect(total([{ price: 2 }])).toBe(2);
 });
 
 it('empty', () => {
   expect(total([])).toBe(0);
 });
`;
    const { list } = setup(
      SRC_DIFF + testDiff,
      {
        'src/billing/invoice.ts': 'export function total(items) {}',
        'src/billing/invoice.test.ts': "it('sums', () => {\n  expect(total([{ price: 2 }])).toBe(2);\n});\n\nit('empty', () => {\n  expect(total([])).toBe(0);\n});\n",
      },
      [],
      '/nonexistent',
      [['total']],
    );
    const changed = list[0].tests.find((t) => t.testName === 'sums');
    const unchanged = list[0].tests.find((t) => t.testName === 'empty');
    expect(changed?.diffHunks?.[0].lines.map((l) => l.kind)).toEqual(['ctx', 'del', 'add', 'ctx']);
    expect(changed?.testChange).toBe('modified');
    expect(unchanged?.diffHunks).toBeUndefined();
  });

  it('labels a new case in an existing test file as new', () => {
    const testDiff = `diff --git a/src/billing/invoice.test.ts b/src/billing/invoice.test.ts
--- a/src/billing/invoice.test.ts
+++ b/src/billing/invoice.test.ts
@@ -1 +1,5 @@
 // existing tests
+it('sums', () => {
+  expect(total([{ price: 2 }])).toBe(2);
+});
+
`;
    const { list } = setup(
      SRC_DIFF + testDiff,
      {
        'src/billing/invoice.ts': 'export function total(items) {}',
        'src/billing/invoice.test.ts': "// existing tests\nit('sums', () => {\n  expect(total([{ price: 2 }])).toBe(2);\n});\n",
      },
      [],
      '/nonexistent',
      [['total']],
    );
    expect(list[0].tests[0].testChange).toBe('new');
  });
  it('links by name match, falls back to naming, and computes coverage', () => {
    const { list } = setup(SRC_DIFF, { 'src/billing/invoice.ts': 'export function total() {}', 'test/billing/invoice.test.ts': INVOICE_TEST }, [], '/nonexistent', [['total']]);
    const [h1, h2] = list;
    // total is called by a case; applyDiscount (declared in added lines) is only imported → partial.
    expect(h1.tests[0]).toMatchObject({ testFile: 'test/billing/invoice.test.ts', source: 'name-match', testName: 'invoice > sums items' });
    expect(h1.coverage).toBe('partial');
    // no symbols declared in h2's added lines and none indexed → naming fallback → partial
    expect(h2.tests[0]).toMatchObject({ source: 'naming', confidence: 0.4 });
    expect(h2.coverage).toBe('partial');
  });

  it('marks untested when nothing links', () => {
    const { list } = setup(SRC_DIFF, { 'src/billing/invoice.ts': '' });
    expect(list.every((h) => h.coverage === 'untested' && h.tests.length === 0)).toBe(true);
  });

  it('keeps name-matched tests partial without execution coverage', () => {
    const heads = {
      'src/billing/invoice.ts': '',
      'src/billing/invoice.test.ts': "it('discounts', () => { expect(applyDiscount(10, 0.5)).toBe(5); });\n",
    };
    const { list } = setup(SRC_DIFF, heads);
    expect(list[0].coverage).toBe('partial');
    expect(list[0].tests[0]).toMatchObject({ source: 'name-match', testName: 'discounts', startLine: 1 });
  });

  it('uses coverage data when present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-cov-'));
    fs.mkdirSync(path.join(root, 'coverage'));
    fs.writeFileSync(path.join(root, 'coverage', 'lcov.info'), `SF:${path.join(root, 'src/billing/invoice.ts')}\nDA:5,1\nDA:6,1\nDA:25,0\nend_of_record\n`);
    const { list } = setup(SRC_DIFF, { 'src/billing/invoice.ts': '' }, [], root);
    expect(list[0].coverage).toBe('tested');
    expect(list[0].tests[0].source).toBe('coverage');
    expect(list[1].coverage).toBe('untested');
  });

  it('shows the unchanged code a test-only change covers', () => {
    const testDiff = `diff --git a/src/billing/invoice.test.ts b/src/billing/invoice.test.ts
--- a/src/billing/invoice.test.ts
+++ b/src/billing/invoice.test.ts
@@ -1,3 +1,3 @@
 it('sums', () => {
-  expect(total([{ price: 2 }])).toBe(2);
+  expect(total([{ price: 2 }])).toBeGreaterThan(0);
 });
`;
    const { list, files } = setup(testDiff, {
      'src/billing/invoice.test.ts': "import { total } from './invoice';\nit('sums', () => {});\n",
      'src/billing/invoice.ts': 'const x = 1;\n\nexport function total(items) {\n  return items.length;\n}\n',
    });
    expect(files[0].kind).toBe('test');
    expect(list[0].covers).toEqual({
      file: 'src/billing/invoice.ts',
      startLine: 3,
      lines: ['export function total(items) {', '  return items.length;', '}'],
      symbol: 'total',
    });
  });
});
