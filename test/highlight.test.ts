import { describe, expect, it } from 'vitest';
import { clearHighlightCache, highlightCacheKeys, highlightHunkCached, peekHunkHighlights } from '../src/tui/highlightCache.js';
import { highlightDiffLines, highlightFileLines, highlightHunk, highlightLanguage, highlightSourceLines, type SyntaxSpan } from '../src/tui/highlight.js';
import { hunk } from './fixtures/tour.js';

function coloredText(text: string, spans: SyntaxSpan[]) {
  return spans.map((s) => text.slice(s.start, s.end)).join('');
}

describe('diff syntax highlighting', () => {
  it('recognizes common source and config languages and falls back for unknown files', async () => {
    expect(highlightLanguage('src/app.tsx')).toBe('tsx');
    expect(highlightLanguage('src/lib.rs')).toBe('rust');
    expect(highlightLanguage('config/app.yaml')).toBe('yaml');
    expect(highlightLanguage('image.png')).toBeUndefined();
    expect(highlightLanguage('docker/Dockerfile')).toBe('dockerfile');
    expect(highlightLanguage('Dockerfile.dev')).toBe('dockerfile');
    expect(highlightLanguage('Makefile')).toBe('make');
    expect(highlightLanguage('README')).toBeUndefined();
    expect(await highlightHunk(hunk('h', 'image.png', [{ kind: 'add', text: 'anything', newLine: 1 }]))).toBeUndefined();
    for (const file of [
      'x.tsx',
      'x.ts',
      'x.js',
      'x.py',
      'x.go',
      'x.kt',
      'x.rs',
      'x.rb',
      'x.java',
      'x.cs',
      'x.swift',
      'x.c',
      'x.cpp',
      'x.php',
      'x.sh',
      'x.json',
      'x.yaml',
      'x.toml',
      'x.css',
      'x.html',
      'x.lua',
      'x.sql',
      'x.scala',
      'x.ex',
      'x.clj',
      'x.dart',
      'x.m',
      'x.mm',
      'x.scss',
      'x.less',
      'x.md',
      'x.xml',
      'x.csproj',
      'x.graphql',
      'x.proto',
      'x.tf',
      'x.hcl',
      'x.vue',
      'x.svelte',
      'x.mk',
      'Dockerfile',
      'deploy/Dockerfile.prod',
      'Makefile',
    ]) {
      expect(await highlightHunk(hunk('h', file, [{ kind: 'add', text: 'x', newLine: 1 }]))).toBeDefined();
    }
  });

  it('colors tokens in added Rust lines and deleted Python lines', async () => {
    const rust = 'fn greet() { println!("hi"); }';
    const added = await highlightHunk(hunk('h', 'lib.rs', [{ kind: 'add', text: rust, newLine: 1 }]));
    expect(coloredText(rust, added![0])).toContain('fn');
    expect(coloredText(rust, added![0])).toContain('hi');

    const python = 'return "old"';
    const deleted = await highlightHunk(hunk('h', 'app.py', [{ kind: 'del', text: python, oldLine: 1 }]));
    expect(coloredText(python, deleted![0])).toContain('return');
    expect(coloredText(python, deleted![0])).toContain('old');
  });

  it('uses colors distinct from diff green for Kotlin keywords and strings', async () => {
    const text = 'fun greet() = "hello"';
    const result = await highlightHunk(hunk('h', 'Greeting.kt', [{ kind: 'add', text, newLine: 1 }]));
    const keyword = result![0].find((span) => text.slice(span.start, span.end) === 'fun');
    const string = result![0].find((span) => text.slice(span.start, span.end).includes('hello'));
    expect(keyword?.color.toLowerCase()).toBe('#3e8fb0');
    expect(string?.color.toLowerCase()).toBe('#f6c177');
  });

  it('uses full-file context for multiline comments', async () => {
    const text = 'still a comment */';
    const result = await highlightHunk(hunk('h', 'app.ts', [{ kind: 'add', text, newLine: 2 }]), {
      head: `/* begins above\n${text}\nconst x = 1;`,
    });
    expect(coloredText(text, result![0])).toBe(text);
  });

  it('highlights SQL keywords and strings', async () => {
    const text = "SELECT id FROM users WHERE name = 'ada';";
    const result = await highlightHunk(hunk('h', 'db/query.sql', [{ kind: 'add', text, newLine: 1 }]));
    expect(coloredText(text, result![0])).toContain('SELECT');
    expect(coloredText(text, result![0])).toContain("'ada'");
  });

  it('highlights YAML keys and comments', async () => {
    const text = 'retries: 3 # maximum';
    const result = await highlightHunk(hunk('h', 'config.yml', [{ kind: 'add', text, newLine: 1 }]));
    expect(coloredText(text, result![0])).toContain('retries');
    expect(coloredText(text, result![0])).toContain('3');
    expect(coloredText(text, result![0])).toContain('# maximum');
  });
});

describe('test pane syntax highlighting', () => {
  it('colors added and removed test lines by the test file language', async () => {
    const added = 'fun verifiesTotal() = assertEquals(42, total)';
    const removed = 'fun verifiesTotal() = assertEquals(41, total)';
    const spans = await highlightDiffLines('src/test/kotlin/TotalTest.kt', [
      { kind: 'del', text: removed, oldLine: 10 },
      { kind: 'add', text: added, newLine: 10 },
    ]);
    expect(coloredText(removed, spans![0])).toContain('fun');
    expect(coloredText(added, spans![1])).toContain('assertEquals');
    expect(spans![1].some((span) => span.color.toLowerCase() === '#3e8fb0')).toBe(true);
  });

  it('colors test snippets by their own file language', async () => {
    const ts = 'expect(save(1)).toBe(1); // verified';
    const ruby = 'expect(save(1)).to eq(1) # verified';
    const tsSpans = await highlightSourceLines('test/store.test.ts', [ts]);
    const rubySpans = await highlightSourceLines('spec/store_spec.rb', [ruby]);
    expect(coloredText(ts, tsSpans![0])).toContain('verified');
    expect(coloredText(ruby, rubySpans![0])).toContain('verified');
    expect(await highlightSourceLines('test/data.unknown', [ts])).toBeUndefined();
  });

  it('keeps offsets relative to each displayed test line', async () => {
    const lines = ['describe("store", () => {', '  it("saves", () => save(1));', '});'];
    const spans = await highlightSourceLines('test/store.test.ts', lines);
    expect(coloredText(lines[1], spans![1])).toContain('saves');
    expect(spans![1].every((span) => span.start >= 0 && span.end <= lines[1].length)).toBe(true);
  });

  it('offsets a tab-indented file line on the line as shown, tabs as two spaces (the reference preview)', async () => {
    const spans = await highlightFileLines('src/a.ts', 'function f() {\n\treturn x;\n}');
    const shown = '  return x;';
    const words = spans![1].map((s) => shown.slice(s.start, s.end));
    expect(words).toContain('return');
  });

  it('highlights in the theme it is given, and caches each theme apart', async () => {
    const h = hunk('h', 'a.ts', [{ kind: 'add', text: 'const x = "s";', newLine: 1 }]);
    const colors = async (theme?: string) => (await highlightHunkCached({ hunk: h, headSha: 'x', baseSha: 'y' }, theme))!.flat().map((sp) => sp.color);
    const byDefault = await colors();
    const light = await colors('github-light');
    expect(light).not.toEqual(byDefault);
    expect(
      peekHunkHighlights({ hunk: h, headSha: 'x', baseSha: 'y' }, 'github-light')
        ?.value?.flat()
        .map((sp) => sp.color),
    ).toEqual(light);
  });

  it('keeps previewed themes out of the cache for the theme in use', async () => {
    clearHighlightCache();
    const h = hunk('p', 'b.ts', [{ kind: 'add', text: 'let y = 1;', newLine: 1 }]);
    const req = { hunk: h, headSha: 'x', baseSha: 'y' };
    await highlightHunkCached(req, 'nord', true);
    expect(peekHunkHighlights(req, 'nord', true)).toBeDefined();
    expect(peekHunkHighlights(req, 'nord')).toBeUndefined();
    expect(highlightCacheKeys().hunks).toHaveLength(0);
  });
});
