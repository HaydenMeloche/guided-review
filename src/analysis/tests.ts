import path from 'node:path';
import { addedText } from '../diff/lines.js';
import { familyOf, languageOf } from '../util/language.js';
import { escapeRe } from '../util/regex.js';
import { isTestPath, testStem } from './testPaths.js';
import { safeReadFile } from './safeRead.js';
import type { Coverage, DiffFile, Hunk, TestLink } from '../types.js';

interface TestCase {
  name: string;
  startLine: number; // 1-based
  endLine: number; // inclusive
  lines: string[];
}

interface PairContext {
  root: string;
  readHead: (p: string) => string | undefined;
  listFiles: () => string[];
  testPatterns?: string[]; // the repository's own test globs (config.testPatterns)
  // Coverage files the PR itself changed: committed by the author, so not trusted.
  untrustedCoverage?: string[];
}

export const COVERAGE_FILES = ['coverage/coverage-final.json', 'coverage/lcov.info'];
const MAX_COVERAGE_BYTES = 32 * 1024 * 1024;
// Upper bound on line-range expansion across a whole coverage file.
const MAX_COVERAGE_LINES = 2_000_000;

const MAX_LINKS = 6;
const GENERIC_STEMS = new Set(['index', 'main', 'mod', 'utils', 'util', 'types', '__init__', 'lib', 'helpers', 'common']);
const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'return',
  'await',
  'async',
  'new',
  'typeof',
  'const',
  'let',
  'var',
  'class',
  'import',
  'export',
  'default',
  'this',
  'super',
  'true',
  'false',
  'null',
  'undefined',
  'void',
  'def',
  'func',
  'self',
  'expect',
  'describe',
  'it',
  'test',
  'constructor',
  'get',
  'set',
  'static',
  'public',
  'private',
  'protected',
  'readonly',
  'type',
  'interface',
  'enum',
  'string',
  'number',
  'boolean',
  'any',
  'unknown',
  'from',
  'as',
]);

// ---------------------------------------------------------------------------
// Source scanning helpers

// Index of the bracket closing the one at `open`, skipping strings and comments.
function matchBracket(src: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) return -1;
      i = nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) {
        if (src[i] === '\\') i++;
        if (c !== '`' && src[i] === '\n') break;
      }
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

// Offsets where each line of `src` starts; lineStarts(src)[0] is always 0.
export function lineStarts(src: string): number[] {
  const starts = [0];
  for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

// 1-based line of offset `idx`: the number of line starts at or before it (binary search).
export function lineAt(starts: number[], idx: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= idx) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, lo);
}

function indentBlockEnd(lines: string[], start: number): number {
  const indent = lines[start].match(/^\s*/)![0].length;
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (lines[i].match(/^\s*/)![0].length <= indent) break;
    end = i;
  }
  return end;
}

// `starts` is lineStarts(src).
function braceBlockEnd(src: string, starts: number[], lines: string[], startLine: number): number {
  // startLine is 0-based; find the first '{' at or after the start of that line.
  let offset = 0;
  for (let i = 0; i < startLine; i++) offset += lines[i].length + 1;
  const brace = src.indexOf('{', offset);
  if (brace < 0) return Math.min(lines.length - 1, startLine + 40);
  const close = matchBracket(src, brace);
  return close < 0 ? Math.min(lines.length - 1, startLine + 40) : lineAt(starts, close) - 1;
}

export function extractTestCases(file: string, content: string): TestCase[] {
  const lines = content.split('\n');
  const starts = lineStarts(content);
  const lang = languageOf(file)?.id;
  const cases: TestCase[] = [];
  const mk = (name: string, s: number, e: number): TestCase => ({
    name,
    startLine: s + 1,
    endLine: e + 1,
    lines: lines.slice(s, e + 1),
  });

  if (lang === 'python') {
    // pytest functions, and test methods inside `class TestX:` (named TestX::test_y).
    let cls: { name: string; indent: number } | undefined;
    lines.forEach((l, i) => {
      const indent = l.match(/^\s*/)![0].length;
      if (cls && l.trim() && indent <= cls.indent) cls = undefined;
      const c = l.match(/^(\s*)class\s+(Test\w*)\b/);
      if (c) cls = { name: c[2], indent: c[1].length };
      const m = l.match(/^\s*(?:async\s+)?def\s+(test_?\w*)\s*\(/);
      if (m && (m[1].startsWith('test_') || m[1] === 'test' || cls)) {
        if (cls && !m[1].startsWith('test')) return;
        cases.push(mk(cls && indent > cls.indent ? `${cls.name}::${m[1]}` : m[1], i, indentBlockEnd(lines, i)));
      }
    });
    return cases;
  }
  if (lang === 'kotlin') {
    const TEST_ANNOTATION = /@(Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|Property)\b/;
    const KOTEST = /^\s*(?:"((?:\\.|[^"\\])+)"|(?:test|should|it|describe|context|given|when|then|scenario|feature|expect)\s*\(\s*"((?:\\.|[^"\\])+)"\s*\))\s*(?:\.config\([^)]*\)\s*)?\{/;
    lines.forEach((l, i) => {
      const f = l.match(/^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|internal|private|protected|suspend|open|override)\s+)*fun\s+(`[^`]+`|\w+)\s*\(/);
      if (f) {
        // Only the run of annotation lines directly above this function counts.
        let annotated = TEST_ANNOTATION.test(l.slice(0, l.indexOf('fun')));
        for (let j = i - 1; j >= 0 && /^\s*@/.test(lines[j]); j--) if (TEST_ANNOTATION.test(lines[j])) annotated = true;
        const name = f[1].replace(/`/g, '');
        if (annotated || /^test/.test(name)) cases.push(mk(name, i, braceBlockEnd(content, starts, lines, i)));
        return;
      }
      const k = l.match(KOTEST);
      if (k) cases.push(mk(k[1] ?? k[2], i, braceBlockEnd(content, starts, lines, i)));
    });
    return cases;
  }
  if (lang === 'java') {
    lines.forEach((l, i) => {
      const m = /\b(?:void|[A-Za-z_]\w*(?:<[^>]+>)?)\s+(\w+)\s*\(/.exec(l);
      if (!m) return;
      const testAnnotation = /@(?:org\.junit\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/;
      let annotated = testAnnotation.test(l);
      for (let j = i - 1; j >= 0; j--) {
        const prior = lines[j].trim();
        if (!prior) continue;
        if (!prior.startsWith('@')) break;
        if (testAnnotation.test(prior)) annotated = true;
      }
      if (annotated || /^test[A-Z_]/.test(m[1])) cases.push(mk(m[1], i, braceBlockEnd(content, starts, lines, i)));
    });
    return cases;
  }
  if (lang === 'c' || lang === 'cpp') {
    lines.forEach((l, i) => {
      const gtest = /\b(?:TEST|TEST_F|TEST_P|TYPED_TEST|TYPED_TEST_P)\s*\(\s*([\w:]+)\s*,\s*([\w:]+)\s*\)/.exec(l);
      const catch2 = /\bTEST_CASE\s*\(\s*"([^"]+)"/.exec(l);
      const native = /\b(?:void|int|bool)\s+(test_\w+)\s*\(/.exec(l);
      const name = gtest ? `${gtest[1]}.${gtest[2]}` : (catch2?.[1] ?? native?.[1]);
      if (name) cases.push(mk(name, i, braceBlockEnd(content, starts, lines, i)));
    });
    return cases;
  }
  if (lang === 'ruby') {
    lines.forEach((l, i) => {
      const rspec = /^\s*(?:it|specify|scenario)\s*(?:\(\s*)?["']([^"']+)["']/.exec(l);
      const minitest = /^\s*def\s+(test_\w+)/.exec(l);
      const name = rspec?.[1] ?? minitest?.[1];
      if (!name) return;
      const indent = l.match(/^\s*/)![0].length;
      const end = lines.findIndex((next, j) => j > i && /^\s*end\b/.test(next) && next.match(/^\s*/)![0].length <= indent);
      cases.push(mk(name, i, end < 0 ? i : end));
    });
    return cases;
  }
  if (lang === 'go') {
    lines.forEach((l, i) => {
      const m = l.match(/^func\s+(Test\w*|Benchmark\w*|Fuzz\w*)\s*\(/);
      if (m) cases.push(mk(m[1], i, braceBlockEnd(content, starts, lines, i)));
    });
    return cases;
  }

  // JS/TS style: it(), test(), describe() incl. .only/.skip/.each(...)
  const re = /(^|[^\w$.])(it|test|describe|context|specify)((?:\.\w+)*)(?:\([^()]*\))?\s*\(\s*(['"`])((?:\\.|(?!\4).)*)\4/gm;
  type Raw = { kind: string; name: string; start: number; end: number };
  const raw: Raw[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const callStart = m.index + m[1].length;
    const paren = content.indexOf('(', callStart + m[2].length + m[3].length);
    // .each(...)( : skip to the second open paren if present
    let open = paren;
    if (m[3].includes('each')) {
      const firstClose = matchBracket(content, paren);
      const next = content.indexOf('(', firstClose);
      if (firstClose > 0 && next > 0) open = next;
    }
    const close = matchBracket(content, open);
    const s = lineAt(starts, callStart) - 1;
    const e = close < 0 ? s : lineAt(starts, close) - 1;
    raw.push({ kind: m[2], name: m[5], start: s, end: e });
  }
  const suites = raw.filter((r) => r.kind === 'describe' || r.kind === 'context');
  const tests = raw.filter((r) => r.kind !== 'describe' && r.kind !== 'context');
  const qualify = (r: Raw) =>
    suites
      .filter((d) => d !== r && d.start <= r.start && d.end >= r.end)
      .map((d) => d.name)
      .concat(r.name)
      .join(' > ');
  for (const t of tests.length ? tests : suites) cases.push(mk(qualify(t), t.start, t.end));
  return cases;
}

// ---------------------------------------------------------------------------
// Naming conventions

function splitPath(p: string) {
  const dir = path.posix.dirname(p);
  const base = path.posix.basename(p);
  const ext = path.posix.extname(base);
  return { dir: dir === '.' ? '' : dir, base, ext, stem: base.slice(0, base.length - ext.length) };
}

function sameLanguage(source: string, test: string): boolean {
  const a = familyOf(source);
  return a !== undefined && a === familyOf(test);
}

// Gradle/Maven source sets: src/main/kotlin/a/B.kt ↔ src/test/kotlin/a/BTest.kt.
function sourceSetMirror(dir: string): string | undefined {
  const m = /^(.*?)(^|\/)src\/(main|test|testFixtures|integrationTest|it|commonMain|commonTest|jvmMain|jvmTest)\/(.*)$/.exec(dir);
  return m ? `${m[1]}${m[2]}src/*/${m[4]}` : undefined;
}

function sameSourceSet(a: string, b: string): boolean {
  const ma = sourceSetMirror(a);
  return ma !== undefined && ma === sourceSetMirror(b);
}

// Repo files bucketed by stem: test files by the stem they test, other files by their own stem.
interface NamingIndex {
  tests: Map<string, string[]>;
  sources: Map<string, string[]>;
}

function buildNamingIndex(all: string[], testPatterns: string[] = []): NamingIndex {
  const index: NamingIndex = { tests: new Map(), sources: new Map() };
  const add = (m: Map<string, string[]>, k: string, f: string) => {
    const bucket = m.get(k);
    if (bucket) bucket.push(f);
    else m.set(k, [f]);
  };
  for (const f of all) {
    if (isTestPath(f, testPatterns)) add(index.tests, testStem(f), f);
    else add(index.sources, splitPath(f).stem, f);
  }
  return index;
}

// `index` must be built from `all`; pass one when calling this for many sources.
export function namingTestFiles(source: string, all: string[], index: NamingIndex = buildNamingIndex(all)): string[] {
  const { dir, stem } = splitPath(source);
  const out: string[] = [];
  for (const f of index.tests.get(stem) ?? []) {
    if (f === source) continue;
    const fd = splitPath(f).dir;
    const sameDir = fd === dir || fd === `${dir ? dir + '/' : ''}__tests__` || fd === `${dir ? dir + '/' : ''}tests`;
    // Generic stems (index, utils) need the same directory or a mirrored tree (test/x ↔ src/x).
    const mirrored = fd.replace(/^(tests?|specs?|__tests__)(\/|$)/, '');
    const isMirror = (fd !== mirrored && (mirrored === dir || mirrored === dir.replace(/^(src|lib)(\/|$)/, ''))) || sameSourceSet(fd, dir);
    if (GENERIC_STEMS.has(stem) && !sameDir && !isMirror) continue;
    // Language must agree loosely.
    if (!sameLanguage(source, f)) continue;
    out.push(f);
  }
  // Same directory first, then a tests folder beside it, then shorter paths.
  const near = (f: string) => {
    const fd = splitPath(f).dir;
    if (fd === dir) return 0;
    if (sameSourceSet(fd, dir)) return 1;
    return fd.startsWith(dir ? dir + '/' : '') && /(^|\/)(__tests__|tests?)$/.test(fd) ? 1 : 2;
  };
  return out.sort((a, b) => near(a) - near(b) || a.length - b.length);
}

function namingSourceFiles(testFile: string, index: NamingIndex): string[] {
  const stem = testStem(testFile);
  const { dir } = splitPath(testFile);
  const parentDir = dir.replace(/\/?(__tests__|tests?|specs?)$/, '');
  const mirror = dir.replace(/^(tests?|specs?)(\/|$)/, 'src$2');
  const sourceSet = sourceSetMirror(dir);
  return (index.sources.get(stem) ?? [])
    .filter((f) => f !== testFile)
    .filter((f) => sameLanguage(f, testFile))
    .sort((a, b) => {
      const score = (f: string) => {
        const d = splitPath(f).dir;
        return d === dir ? 0 : d === parentDir ? 1 : d === mirror || d.endsWith(mirror) || (sourceSet !== undefined && sourceSetMirror(d) === sourceSet) ? 2 : 3;
      };
      return score(a) - score(b) || a.length - b.length;
    });
}

// Relative imports of a test file, resolved against the repo file list.
function importedFiles(testFile: string, content: string, all: Set<string>): string[] {
  const out: string[] = [];
  const re = /(?:from\s+|require\(\s*|import\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  const dir = splitPath(testFile).dir;
  while ((m = re.exec(content))) {
    const target = path.posix.normalize(path.posix.join(dir, m[1]));
    const noJs = target.replace(/\.[cm]?js$/, '');
    const cands = [target, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].flatMap((e) => [noJs + e, `${target}/index${e}`])];
    const hit = cands.find((c) => all.has(c));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Symbols

const DECL_RE = [
  /(?:function\*?\s+|class\s+|interface\s+|type\s+|enum\s+)([A-Za-z_$][\w$]*)/g,
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/g,
  /^\s*(?:export\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/g,
  /\bdef\s+([A-Za-z_]\w*)/g,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g,
  /\bfun\s+(?:<[^>]*>\s*)?(?:[\w.<>?]+\.)?([A-Za-z_]\w*)\s*\(/g, // Kotlin, incl. extension functions
  /\b(?:class|object)\s+([A-Z]\w*)/g,
];

function declaredIdentifiers(lines: string[]): string[] {
  const out = new Set<string>();
  for (const l of lines) {
    for (const re of DECL_RE) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(l))) if (m[1].length > 2 && !KEYWORDS.has(m[1])) out.add(m[1]);
    }
  }
  return [...out];
}

function hunkSymbols(h: Hunk): string[] {
  const fromIndex = h.symbols.map((s) => s.split(/[.#:]/).pop() ?? s);
  const added = declaredIdentifiers(addedText(h));
  return [...new Set([...fromIndex, ...added])].filter((s) => s.length > 2 && !KEYWORDS.has(s));
}

// ---------------------------------------------------------------------------
// Coverage data (istanbul json or lcov). Line -> hit count, keyed by repo-relative path.

type LineHits = Map<number, number>;

interface CoverageOptions {
  skip?: string[]; // repo-relative coverage files to ignore
  only?: Set<string>; // repo-relative source paths worth keeping
  lineCount?: (rel: string) => number | undefined; // clamps statement ranges to the file
}

export function loadCoverage(root: string, opts: CoverageOptions = {}): Map<string, LineHits> | undefined {
  const out = new Map<string, LineHits>();
  const rel = (p: string) => {
    const r = path.isAbsolute(p) ? path.relative(root, p) : p;
    return r.split(path.sep).join('/').replace(/^\.\//, '');
  };
  const read = (p: string) => (opts.skip?.includes(p) ? undefined : safeReadFile(root, p, MAX_COVERAGE_BYTES));
  const wanted = (p: string) => !opts.only || opts.only.has(p);
  let budget = MAX_COVERAGE_LINES;
  const jsonText = read(COVERAGE_FILES[0]);
  if (jsonText !== undefined) {
    try {
      const json = JSON.parse(jsonText) as Record<string, { path?: string; statementMap: Record<string, { start: { line: number }; end: { line: number } }>; s: Record<string, number> }>;
      for (const [key, cov] of Object.entries(json)) {
        const file = rel(String(cov?.path ?? key));
        if (!wanted(file)) continue;
        const hits: LineHits = new Map();
        const max = opts.lineCount?.(file);
        for (const [id, loc] of Object.entries(cov?.statementMap ?? {})) {
          const n = Number(cov.s?.[id] ?? 0) || 0;
          const from = Math.max(1, Math.floor(Number(loc?.start?.line)));
          let to = Math.floor(Number(loc?.end?.line));
          if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
          to = Math.min(to, max ?? from + 1000);
          for (let l = from; l <= to && budget > 0; l++, budget--) hits.set(l, Math.max(hits.get(l) ?? 0, n));
        }
        out.set(file, hits);
      }
      return out;
    } catch {
      // fall through to lcov
    }
  }
  const text = read(COVERAGE_FILES[1]);
  if (text === undefined) return undefined;
  let cur: LineHits | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      const file = rel(line.slice(3).trim());
      cur = wanted(file) ? new Map() : undefined;
      if (cur) out.set(file, cur);
    } else if (line.startsWith('DA:') && cur) {
      const [ln, n] = line.slice(3).split(',');
      cur.set(+ln, +n);
    }
  }
  return out.size ? out : undefined;
}

function coverageFor(h: Hunk, hits: LineHits | undefined): 'full' | 'some' | 'none' | undefined {
  if (!hits) return undefined;
  const lines = h.lines.filter((l) => l.kind === 'add' && l.newLine !== undefined && hits.has(l.newLine));
  if (!lines.length) return undefined; // nothing executable added
  const covered = lines.filter((l) => (hits.get(l.newLine!) ?? 0) > 0).length;
  return covered === lines.length ? 'full' : covered ? 'some' : 'none';
}

// ---------------------------------------------------------------------------

// Show the actual PR delta for a linked test case. A changed file can contain
// unchanged cases, so only mark the link as a diff when this case changed.
export function attachChangedTestDiffs(files: DiffFile[], hunks: Record<string, Hunk>): void {
  const changedTests = new Map(files.filter((f) => f.kind === 'test' && f.status !== 'deleted').map((f) => [f.path, f]));
  for (const h of Object.values(hunks)) {
    for (const link of h.tests) {
      delete link.diffHunks;
      delete link.testFileStatus;
      delete link.testChange;
      const file = changedTests.get(link.testFile);
      if (!file) continue;
      const start = link.startLine;
      const end = start + link.lines.length - 1;
      const wholeFile = link.source === 'naming' || !link.lines.length;
      const diffHunks: NonNullable<TestLink['diffHunks']> = [];
      for (const id of file.hunkIds) {
        const testHunk = hunks[id];
        if (!testHunk) continue;
        let nextNew = testHunk.newStart;
        const lines = testHunk.lines.filter((line) => {
          if (line.kind === 'del') return wholeFile || (nextNew >= start && nextNew <= end + 1);
          nextNew = (line.newLine ?? nextNew) + 1;
          return wholeFile || (line.newLine !== undefined && line.newLine >= start && line.newLine <= end);
        });
        if (lines.some((line) => line.kind !== 'ctx')) diffHunks.push({ header: testHunk.header, lines });
      }
      if (diffHunks.length) {
        link.diffHunks = diffHunks;
        link.testFileStatus = file.status;
        const changes = diffHunks.flatMap((diff) => diff.lines).filter((line) => line.kind !== 'ctx');
        link.testChange = file.status === 'added' || (changes.every((line) => line.kind === 'add') && changes.some((line) => line.newLine === start)) ? 'new' : 'modified';
      }
    }
  }
}

export function pairTests(files: DiffFile[], hunks: Record<string, Hunk>, ctx: PairContext): void {
  const all = ctx.listFiles();
  const allSet = new Set(all);
  const namingIndex = buildNamingIndex(all, ctx.testPatterns);
  const changedTests = files.filter((f) => f.kind === 'test' && f.status !== 'deleted').map((f) => f.path);
  const changedTestSet = new Set(changedTests);
  const caseCache = new Map<string, TestCase[]>();
  const casesOf = (f: string): TestCase[] => {
    if (!caseCache.has(f)) {
      const c = ctx.readHead(f);
      caseCache.set(f, c === undefined ? [] : extractTestCases(f, c));
    }
    return caseCache.get(f)!;
  };
  // Hot loop below: join each case body and compile each symbol's pattern once.
  const bodies = new WeakMap<TestCase, string>();
  const bodyOf = (tc: TestCase): string => {
    let body = bodies.get(tc);
    if (body === undefined) bodies.set(tc, (body = tc.lines.join('\n')));
    return body;
  };
  const symbolRes = new Map<string, RegExp>();
  const symbolRe = (s: string): RegExp => {
    let re = symbolRes.get(s);
    if (!re) symbolRes.set(s, (re = new RegExp(`(?<![\\w$])${escapeRe(s)}(?![\\w$])`)));
    return re;
  };
  const covData = loadCoverage(ctx.root, {
    skip: ctx.untrustedCoverage,
    only: new Set(files.filter((f) => f.kind === 'logic').map((f) => f.path)),
    lineCount: (p) => ctx.readHead(p)?.split('\n').length,
  });

  for (const f of files) {
    if (f.kind !== 'logic') {
      for (const id of f.hunkIds) if (hunks[id]) hunks[id].coverage = 'n/a';
      continue;
    }
    const naming = namingTestFiles(f.path, all, namingIndex);
    const namingSet = new Set(naming);
    // Changed test files first (most likely to exercise new behavior), then naming matches.
    const candidates = [...new Set([...changedTests.filter((tf) => sameLanguage(f.path, tf)), ...naming])];

    for (const id of f.hunkIds) {
      const h = hunks[id];
      if (!h) continue;
      const links: TestLink[] = [];
      const syms = hunkSymbols(h);

      for (const tf of candidates) {
        for (const tc of casesOf(tf)) {
          const body = bodyOf(tc);
          const hit = syms.filter((s) => symbolRe(s).test(body));
          if (!hit.length) continue;
          links.push({
            testFile: tf,
            testName: tc.name,
            startLine: tc.startLine,
            lines: tc.lines,
            source: 'name-match',
            confidence: namingSet.has(tf) || changedTestSet.has(tf) ? 0.65 : 0.55,
          });
        }
      }

      const cov = coverageFor(h, covData?.get(f.path));
      if (cov === 'full' || cov === 'some') {
        // Coverage confirms execution; upgrade static links, or record the run itself.
        if (links.length) links.forEach((l) => ((l.source = 'coverage'), (l.confidence = 0.95)));
        else
          links.push({
            testFile: naming[0] ?? 'coverage',
            testName: cov === 'full' ? 'all added lines executed in coverage run' : 'some added lines executed in coverage run',
            startLine: 1,
            lines: [],
            source: 'coverage',
            confidence: 0.95,
          });
      }

      if (!links.length && naming.length) {
        const tf = naming[0];
        const content = ctx.readHead(tf);
        links.push({
          testFile: tf,
          testName: path.posix.basename(tf),
          startLine: 1,
          lines: content ? content.split('\n').slice(0, 40) : [],
          source: 'naming',
          confidence: 0.4,
        });
      }

      // Most confident first, changed test files before others.
      links.sort((a, b) => b.confidence - a.confidence || +changedTestSet.has(b.testFile) - +changedTestSet.has(a.testFile));
      h.tests = links.slice(0, MAX_LINKS);

      let coverage: Coverage;
      if (cov === 'full') coverage = 'tested';
      else if (cov === 'some') coverage = 'partial';
      else if (cov === 'none') coverage = 'untested';
      else if (!links.length) coverage = 'untested';
      else coverage = 'partial'; // A reference in a test is not execution evidence.
      h.coverage = coverage;
    }
  }

  // Test-only changes: show the unchanged code they cover.
  const changedSources = new Set(files.filter((f) => f.kind === 'logic').map((f) => f.path));
  for (const f of files) {
    if (f.kind !== 'test' || f.status === 'deleted') continue;
    const content = ctx.readHead(f.path) ?? '';
    const sources = [...importedFiles(f.path, content, allSet), ...namingSourceFiles(f.path, namingIndex)].filter((s, i, arr) => arr.indexOf(s) === i);
    if (!sources.length || sources.some((s) => changedSources.has(s))) continue;
    for (const id of f.hunkIds) {
      const h = hunks[id];
      if (!h) continue;
      h.coverage = 'n/a';
      h.covers = findCovered(h, sources, ctx);
    }
  }
  attachChangedTestDiffs(files, hunks);
}

function findCovered(h: Hunk, sources: string[], ctx: PairContext): Hunk['covers'] {
  const called = new Set<string>();
  for (const l of h.lines) {
    if (l.kind === 'del') continue;
    const re = /([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l.text))) if (m[1].length > 2 && !KEYWORDS.has(m[1]) && !/^(toBe|toEqual|to[A-Z]\w*|assert\w*|mock\w*|vi|jest)$/.test(m[1])) called.add(m[1]);
  }
  for (const src of sources) {
    const content = ctx.readHead(src);
    if (content === undefined) continue;
    const lines = content.split('\n');
    for (const name of called) {
      const decl = new RegExp(
        `(?:function\\*?\\s+${escapeRe(name)}\\b|(?:const|let|var)\\s+${escapeRe(name)}\\s*[:=]|^\\s*(?:export\\s+)?(?:public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+)*${escapeRe(name)}\\s*\\(|\\bdef\\s+${escapeRe(name)}\\b|\\bfunc\\s+(?:\\([^)]*\\)\\s*)?${escapeRe(name)}\\b|class\\s+${escapeRe(name)}\\b)`,
      );
      const i = lines.findIndex((l) => decl.test(l) && !/^\s*(\/\/|#|\*)/.test(l));
      if (i < 0) continue;
      const end = familyOf(src) === 'python' ? indentBlockEnd(lines, i) : braceBlockEnd(content, lineStarts(content), lines, i);
      return { file: src, startLine: i + 1, lines: lines.slice(i, Math.min(end + 1, i + 80)), symbol: name };
    }
  }
  const src = sources[0];
  const content = ctx.readHead(src);
  return content === undefined ? undefined : { file: src, startLine: 1, lines: content.split('\n').slice(0, 40) };
}
