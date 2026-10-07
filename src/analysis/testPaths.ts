import { matchGlob } from '../util/glob.js';
import { extensionsWhere } from '../util/language.js';

// Test file conventions. Each name rule matches a basename and captures the stem of the file
// it tests, so detection and pairing cannot disagree.

const JS = extensionsWhere((l) => l.family === 'js');
const C = extensionsWhere((l) => l.family === 'c-family');
const JVM_LIKE = extensionsWhere((l) => l.family === 'jvm' || l.family === 'dotnet' || l.family === 'swift');

const TEST_DIR = /(^|\/)(test|tests|__tests__|spec|specs)\//;
// In the order the stem is taken: the first match wins.
const NAME_RULES = [
  new RegExp(`^(.*)\\.(?:test|spec)\\.(?:${JS})$`),
  /^(.*)_test\.go$/,
  /^test_(.*)\.py$/,
  /^(.*)_test\.py$/,
  /^(.*)_spec\.rb$/,
  /^(.*)_test\.rb$/,
  /^test_(.*)\.rb$/,
  new RegExp(`^(.*)\\.(?:test|spec)\\.(?:${C})$`),
  new RegExp(`^(?:(.*)[_-])?test\\.(?:${C})$`),
  new RegExp(`^test_(.*)\\.(?:${C})$`),
  new RegExp(`^(.*)(?:Tests?|Spec|IT)\\.(?:${JVM_LIKE})$`),
];

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

// `extra` holds the repository's own test globs (config.testPatterns).
export function isTestPath(p: string, extra: string[] = []): boolean {
  const base = basename(p);
  return TEST_DIR.test(p) || NAME_RULES.some((re) => re.test(base)) || extra.some((g) => matchGlob(g, p));
}

// The stem of the source file a test file covers: foo.test.ts, test_foo.py and FooTest.java give foo/Foo.
export function testStem(p: string): string {
  const base = basename(p);
  for (const re of NAME_RULES) {
    const m = re.exec(base);
    if (m) return m[1] ?? '';
  }
  return base.replace(/\.(test|spec)(\.[^.]+)+$/, '').replace(/\.[^.]+$/, '');
}
