import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CodeRef, Draft, Hunk } from '../src/types.js';
import type { RepoIndex, SymbolResults } from '../src/analysis/repoIndex.js';
import { linesHash } from '../src/review/refs.js';
import { findCompletion, rowSegments, type CompletionHint, type CompletionItem } from '../src/tui/completion.js';
import { callerInput, committedLines, makeRef, MAX_RECENT, mergeRefs, pathLike, pushRecent, rangeInput, referenceCompleter, refHighlight, refTarget, threadInput } from '../src/tui/references.js';
import { draftFrom, initComposer, suggestionStillApplies } from '../src/tui/composer.js';
import { diffLines, hunk as makeHunk, tour as makeTour } from './fixtures/tour.js';

const HEAD = 'h'.repeat(40);
let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-references-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/a.ts'), 'one\ntwo\nthree\nfour\n');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture() {
  const h: Hunk = makeHunk('h1', 'src/a.ts', diffLines([' one', '+two', '+three', ' four']), {
    tests: [
      { testFile: 't/a.test.ts', testName: 'a.test.ts', startLine: 1, lines: ['x'], source: 'naming', confidence: 0.3 },
      { testFile: 't/a.test.ts', testName: 'adds two', startLine: 5, lines: ['a', 'b'], source: 'coverage', confidence: 0.9 },
    ],
  });
  return makeTour([h], [{ hunkIds: ['h1'] }], {
    headSha: HEAD,
    url: 'https://github.com/o/r/pull/1',
    blastRadius: [{ symbol: 'two', hunkId: 'h1', callers: [{ file: 'src/b.ts', line: 9, text: 'two()' }] }],
  });
}

const draft = (extra: Partial<Draft> = {}): Draft => ({
  id: 'd',
  repo: 'o/r',
  pr: 1,
  headSha: HEAD,
  anchor: { type: 'line', hunkId: 'h1', file: 'src/a.ts', line: 3, side: 'RIGHT' },
  label: 'nit',
  body: 'b',
  posted: false,
  createdAt: '',
  ...extra,
});

describe('recent locations', () => {
  it('keeps the newest first, moves a revisit to the front, and caps the list', () => {
    let list = pushRecent([], { path: 'a', line: 1, why: 'dwell' }, 1);
    list = pushRecent(list, { path: 'b', line: 2, why: 'dwell' }, 2);
    list = pushRecent(list, { path: 'a', line: 1, why: 'comment' }, 3);
    expect(list.map((r) => `${r.path}:${r.why}`)).toEqual(['a:comment', 'b:dwell']);
    for (let i = 0; i < 80; i++) list = pushRecent(list, { path: `f${i}`, why: 'dwell' });
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0].path).toBe('f79');
  });
});

describe('making refs', () => {
  it('hashes head refs (from the worktree outside a repository) and leaves base-side refs to their own pin', () => {
    const head = makeRef(rangeInput('src/a.ts', HEAD, 2, 3), { root, headSha: HEAD, taken: [] });
    expect(head).toMatchObject({ kind: 'range', label: 'a.ts:2-3', linesHash: linesHash('two\nthree') });
    const base = makeRef(rangeInput('src/a.ts', 'base', 2), { root, headSha: HEAD, taken: [] });
    expect(base.linesHash).toBeUndefined();
    const file = makeRef({ kind: 'file', path: 'src/a.ts', commitSha: HEAD }, { root, headSha: HEAD, taken: ['a.ts'] });
    expect(file).toMatchObject({ label: 'src/a.ts', linesHash: linesHash('one\ntwo\nthree\nfour') });
  });

  it('hashes a head ref as committed when the worktree holds uncommitted edits (preview mode)', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-refs-commit-'));
    try {
      const run = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' }).trim();
      run('init', '-q');
      fs.writeFileSync(path.join(repo, 'a.ts'), 'one\ntwo\nthree\n');
      run('add', '.');
      run('commit', '-qm', 'c');
      const sha = run('rev-parse', 'HEAD');
      fs.writeFileSync(path.join(repo, 'a.ts'), 'one\nTWO edited\nthree\n');
      expect(makeRef(rangeInput('a.ts', sha, 2), { root: repo, headSha: sha, taken: [] }).linesHash).toBe(linesHash('two'));
      expect(committedLines(repo, sha, 'gone.ts')).toBeUndefined();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('merges without repeating a place, reusing its label and relabelling new ones to stay unique', () => {
    const a = makeRef(rangeInput('src/a.ts', HEAD, 2), { root, headSha: HEAD, taken: [] });
    const b = makeRef(rangeInput('lib/a.ts', HEAD, 2), { root, headSha: HEAD, taken: [] });
    expect(b.label).toBe(a.label);
    const { refs, labels } = mergeRefs([a], [{ ...a, id: 'again' }, b]);
    expect(labels).toEqual(['a.ts:2', 'lib/a.ts:2']);
    expect(refs.map((r) => r.label)).toEqual(['a.ts:2', 'lib/a.ts:2']);
  });

  it('links a thread by its first comment id', () => {
    const t = threadInput({ id: 'x', path: 'src/a.ts', line: 3, isResolved: false, isOutdated: false, comments: [{ id: '42', author: 'al', body: 'why?', createdAt: '' }] }, fixture());
    expect(t).toEqual({ kind: 'thread', path: 'src/a.ts', commitSha: HEAD, startLine: 3, threadUrl: 'https://github.com/o/r/pull/1#discussion_r42' });
  });
});

describe('the reference at the cursor', () => {
  const refs: CodeRef[] = [
    { id: 'r1', kind: 'range', path: 'src/inventory/stock.ts', commitSha: 'a1b2c3d4e5', startLine: 84, endLine: 96, label: 'stock.ts:84-96' },
    { id: 'r2', kind: 'thread', path: 'src/x.ts', commitSha: HEAD, startLine: 12, label: 'thread:x.ts:12', threadUrl: 'u' },
  ];
  const body = 'see `stock.ts:84-96`, and `thread:x.ts:12` or `nope` ok';
  const at = (needle: string, off = 0) => body.indexOf(needle) + off;

  it('names a ref with its pin, inside its code span or right after it', () => {
    expect(refTarget(body, at('`stock', 3), refs)).toBe('src/inventory/stock.ts:84-96 @a1b2c3d');
    expect(refTarget(body, at(',', 0), refs)).toBe('src/inventory/stock.ts:84-96 @a1b2c3d');
    expect(refTarget(body, at('`stock'), refs)).toBeUndefined();
    expect(refTarget(body, at('see', 1), refs)).toBeUndefined();
  });

  it('names a thread as its discussion, and shows nothing for ordinary code', () => {
    expect(refTarget(body, at('`thread', 5), refs)).toBe('discussion on src/x.ts:12');
    expect(refTarget(body, at('`nope', 2), refs)).toBeUndefined();
  });
});

describe('@ completion', () => {
  const index = {
    symbols: async () =>
      Object.assign([{ name: 'two', qualified: 'src/a.ts#two', kind: 'function', file: 'src/a.ts', startLine: 2, endLine: 3, exported: true }], { truncated: true }) as SymbolResults,
    files: async (q: string) => [{ path: 'src/a.ts', score: 1, changed: true }].filter((f) => f.path.includes(q)),
  } as unknown as RepoIndex;
  const env = (refs: CodeRef[] = [], attached: CodeRef[] = [], mentions = ['alice', 'albert', 'bob', 'carol', 'dave']) =>
    referenceCompleter({
      index,
      root,
      headSha: HEAD,
      mentions,
      refs: () => refs,
      attach: (r) => attached.push(r),
      changedFiles: ['src/a.ts'],
      recent: () => [{ path: 'src/b.ts', line: 7, why: 'dwell', at: 1 }],
    });

  it('lists people at once, then code: symbols then files, and says when to refine', async () => {
    expect(env().instant?.('al')).toEqual([
      { key: '@alice', label: '@alice', insert: '@alice ', group: 'People' },
      { key: '@albert', label: '@albert', insert: '@albert ', group: 'People' },
    ]);
    const items = await env().items('tw');
    expect(items.map((i) => i.label)).toEqual(['ƒ two', '… more matches may exist: refine your search']);
    expect(items.every((i) => i.group === 'Code')).toBe(true);
    const all = await env().items('a');
    expect(all.some((i) => i.label === '▤ src/a.ts')).toBe(true);
  });

  it('searches files only for a path, a range, or a name with a file extension; Owner.method still searches symbols', async () => {
    const symbols = vi.fn((...args: Parameters<RepoIndex['symbols']>) => index.symbols(...args));
    const spied = referenceCompleter({ index: { ...index, symbols } as unknown as RepoIndex, root, headSha: HEAD, refs: () => [], attach: () => {} });
    for (const q of ['src/a.ts', 'a.ts', 'stock.test.tsx', 'a.ts:2-3', 'f:two']) {
      await spied.items(q);
      expect(symbols, q).not.toHaveBeenCalled();
    }
    expect((await spied.items('src/a.ts')).map((i) => i.label)).toEqual(['▤ src/a.ts']);
    for (const q of ['Other.save', 'InventoryService.release', 'two', 's:a.ts']) {
      symbols.mockClear();
      await spied.items(q);
      expect(symbols, q).toHaveBeenCalledWith(q.replace(/^s:/, ''), expect.anything());
    }
    expect(pathLike('Other.save')).toBe(false);
    expect(pathLike('src/review/stock.ts')).toBe(true);
  });

  it("with an empty query lists a few people, then recent places, then the changed files' declarations", async () => {
    expect(
      env()
        .instant?.('')
        .map((i) => i.label),
    ).toEqual(['@alice', '@albert', '@bob']);
    const items = await env().items('');
    expect(items.map((i) => i.label)).toEqual(['◇ src/b.ts:7', 'ƒ two']);
    expect(items[1].preview).toEqual({ path: 'src/a.ts', startLine: 2, endLine: 3 });
  });

  it('inserts chosen lines of a row as a range reference', async () => {
    const attached: CodeRef[] = [];
    const c = env([], attached);
    const [two] = await c.items('two');
    expect(c.lineCount?.('src/a.ts')).toBe(4);
    const picked = c.pickLines?.(two, 3, 4);
    expect(picked?.insert).toBe('`a.ts:3-4` ');
    picked?.onPick?.();
    expect(attached[0]).toMatchObject({ kind: 'range', path: 'src/a.ts', startLine: 3, endLine: 4, label: 'a.ts:3-4', linesHash: linesHash('three\nfour') });
  });

  it('filters with f: and s:, and offers a path:range that exists, all without people', async () => {
    expect((await env().items('f:a')).map((i) => i.label)).toEqual(['▤ src/a.ts']);
    expect((await env().items('s:two')).every((i) => !i.label.startsWith('▤'))).toBe(true);
    const range = await env().items('src/a.ts:2-3');
    expect(range[0]).toMatchObject({ label: '▭ src/a.ts:2-3', insert: '`a.ts:2-3` ' });
    expect(await env().items('src/a.ts:9-12')).not.toContainEqual(expect.objectContaining({ label: '▭ src/a.ts:9-12' }));
    for (const q of ['f:a', 's:al', 'src/a.ts:1-2', 'a.ts']) expect(env(undefined, undefined, ['f', 's', 'src', 'a']).instant?.(q)).toEqual([]);
  });

  it('picking attaches the ref with the inserted label; an attached place reuses its label', async () => {
    const attached: CodeRef[] = [];
    const [two] = await env([], attached).items('two');
    expect(two.insert).toBe('`two()` ');
    two.onPick?.();
    expect(attached[0]).toMatchObject({ label: 'two()', symbol: 'two', linesHash: linesHash('two\nthree') });
    const again = await env(attached).items('two');
    expect(again[0].insert).toBe('`two()` ');
    expect(again[0].onPick).toBeUndefined();
  });

  it('opens after a boundary only, never for an email address or @@', () => {
    expect(findCompletion([env()], 'see @rel')?.query).toBe('rel');
    expect(findCompletion([env()], '(@src/a.ts:1-')?.query).toBe('src/a.ts:1-');
    expect(findCompletion([env()], 'mail foo@bar')).toBeUndefined();
    expect(findCompletion([env()], 'see @@rel')).toBeUndefined();
    expect(findCompletion([env()], 'see @al,')).toBeUndefined();
  });

  describe('filters', () => {
    const t = fixture();
    const h = t.hunks.h1;
    const thread = { id: 'x', path: 'src/a.ts', line: 3, isResolved: true, isOutdated: false, comments: [{ id: '42', author: 'al', body: 'why\ntwice?', createdAt: '' }] };
    const filters = (opts: { blast?: boolean; anchor?: boolean; index?: Partial<RepoIndex> } = {}) => {
      const attached: CodeRef[] = [];
      const c = referenceCompleter({
        index: { ...index, ...opts.index } as unknown as RepoIndex,
        root,
        headSha: HEAD,
        mentions: ['callers', 'tests'],
        refs: () => [],
        attach: (r) => attached.push(r),
        recent: () => [
          { path: 'src/a.ts', line: 2, why: 'dwell', at: 1 },
          { path: 'src/z.ts', why: 'comment', at: 0 },
        ],
        tour: { url: t.url, blastRadius: opts.blast === false ? [] : t.blastRadius, existingThreads: [thread] },
        anchor: () => (opts.anchor === false ? {} : { hunk: h, file: 'src/a.ts', line: 3 }),
      });
      return { c, attached };
    };
    const picked = (it: CompletionItem, attached: CodeRef[]) => {
      it.onPick?.();
      return attached.at(-1);
    };

    it('callers: lists the blast radius’s callers of the hunk as possible, with a caller’s range ref', async () => {
      const { c, attached } = filters();
      const items = await c.items('callers:');
      expect(items.map((i) => [i.label, i.detail])).toEqual([['↳ two()', 'src/b.ts:9 · possible caller of two']]);
      expect(picked(items[0], attached)).toEqual({ ...callerInput({ file: 'src/b.ts', line: 9, text: '' }, HEAD), id: expect.any(String), label: 'b.ts:9' });
      expect(c.instant?.('callers:')).toEqual([]);
    });

    it('callers: falls back to possible callers of the declaration around the anchor', async () => {
      const enclosingDecl = vi.fn(async () => ({ name: 'Svc.save', file: 'src/a.ts', startLine: 1, endLine: 4 }));
      const possibleCallers = vi.fn(async () => [{ file: 'src/c.ts', line: 4, text: '  svc.save()' }]);
      const { c } = filters({ blast: false, index: { enclosingDecl, possibleCallers } as unknown as Partial<RepoIndex> });
      const items = await c.items('callers:');
      expect(enclosingDecl).toHaveBeenCalledWith('src/a.ts', 3);
      expect(possibleCallers).toHaveBeenCalledWith('save', expect.anything());
      expect(items.map((i) => [i.label, i.detail])).toEqual([['↳ svc.save()', 'src/c.ts:4 · possible caller of save']]);
      const hint = c.hint as (it: CompletionItem | undefined, q: string) => CompletionHint;
      expect(hint(items[0], 'callers:').help).toEqual([{ text: 'possible callers of save() · matched by name · backspace to clear filter' }]);
    });

    it('callers:name searches call sites of that name, after the blast radius’s matches', async () => {
      const possibleCallers = vi.fn(async (name: string) => [
        { file: 'src/b.ts', line: 9, text: 'two()' },
        { file: 'src/d.ts', line: 1, text: `${name}(x)` },
      ]);
      const { c } = filters({ index: { possibleCallers } as unknown as Partial<RepoIndex> });
      const items = await c.items('callers:two');
      expect(possibleCallers).toHaveBeenCalledWith('two', expect.anything());
      expect(items.map((i) => i.label)).toEqual(['↳ two()', '↳ two(x)']);
      const none = await filters({ anchor: false }).c.items('callers:');
      expect(none).toEqual([expect.objectContaining({ label: '… no possible callers known: type a function name', insert: '@callers:', keepOpen: true })]);
    });

    it('tests: lists linked tests, name guesses last, filtered by the text after the colon', async () => {
      const { c, attached } = filters();
      const items = await c.items('tests:');
      expect(items.map((i) => i.label)).toEqual(['✓ adds two', '✓ a.test.ts']);
      expect(picked(items[0], attached)).toMatchObject({ kind: 'range', path: 't/a.test.ts', startLine: 5, endLine: 6, label: 'a.test.ts:5-6' });
      expect((await c.items('tests:adds')).map((i) => i.label)).toEqual(['✓ adds two']);
    });

    it('threads: links a thread to its discussion and previews its comments, filtered by author or text', async () => {
      const { c, attached } = filters();
      const [row] = await c.items('threads:');
      expect(row).toMatchObject({ label: '¶ @al: why twice?', detail: 'src/a.ts:3 · resolved', preview: { path: 'src/a.ts:3 · resolved', text: '@al: why\ntwice?' } });
      expect(picked(row, attached)).toMatchObject({ kind: 'thread', path: 'src/a.ts', startLine: 3, label: 'thread:a.ts:3', threadUrl: 'https://github.com/o/r/pull/1#discussion_r42' });
      expect(c.pickLines?.(row, 1, 2)).toBeUndefined();
      expect(await c.items('threads:twice')).toHaveLength(1);
      expect((await c.items('threads:bob'))[0]).toMatchObject({ label: '… no thread matches', keepOpen: true });
    });

    it('recent: lists recent places, filtered', async () => {
      const { c, attached } = filters();
      const items = await c.items('recent:');
      expect(items.map((i) => i.label)).toEqual(['◇ src/a.ts:2', '◇ src/z.ts']);
      expect(picked(items[0], attached)).toMatchObject({ kind: 'range', path: 'src/a.ts', startLine: 2, label: 'a.ts:2' });
      expect((await c.items('recent:z.ts')).map((i) => i.label)).toEqual(['◇ src/z.ts']);
    });

    it('offers a filter for two or more letters of its name, above people; picking it keeps the list open', () => {
      const { c } = filters();
      expect(c.instant?.('thr')).toEqual([{ key: 'filter:threads', label: 'threads:', detail: 'existing review threads', insert: '@threads:', keepOpen: true, group: 'Filters' }]);
      expect(c.instant?.('te')?.map((i) => i.label)).toEqual(['tests:', '@tests']);
      expect(c.instant?.('fi')?.map((i) => i.insert)).toEqual(['@files:']);
      expect(c.instant?.('c')?.map((i) => i.label)).toEqual(['@callers']);
      expect(c.instant?.('threads:')).toEqual([]);
    });

    it('takes files: and symbols: as f: and s:', async () => {
      const { c } = filters();
      expect((await c.items('files:a')).map((i) => i.label)).toEqual(['▤ src/a.ts']);
      expect((await c.items('symbols:tw')).map((i) => i.label)).toEqual(['ƒ two', '… more matches may exist: refine your search']);
    });

    it('hints → pick lines only on a code row, and the filters until one is on', async () => {
      const { c } = filters();
      const hint = c.hint as (it: CompletionItem | undefined, q: string) => CompletionHint;
      const [code] = await c.items('two');
      expect(hint(code, 'two').actions).toBe('tab insert · ↑↓ choose · → pick lines · esc close');
      expect(hint(c.instant?.('tests')[1], 'tests').actions).toBe('tab insert · ↑↓ choose · esc close');
      const help = hint(code, 'two').help!;
      expect(help.map((p) => p.text).join('')).toBe('narrow with  f: files  s: symbols  callers:  tests:  threads:  recent:');
      expect(help.filter((p) => p.accent).map((p) => p.text)).toEqual(['f:', 's:', 'callers:', 'tests:', 'threads:', 'recent:']);
      expect(hint(undefined, 'tests:').help).toEqual([{ text: 'tests linked to this change · backspace to clear filter' }]);
      expect(hint(undefined, 'callers:').help).toEqual([{ text: 'possible callers of two() · matched by name · backspace to clear filter' }]);
      expect(hint(undefined, 'f:x').help).toEqual([{ text: 'files' }]);
    });
  });

  it('highlights only code spans that name a ref', () => {
    const hl = refHighlight([{ label: 'two()' }, { label: 'a.ts:2-3' }]);
    const segs = rowSegments('see `two()`. `x` and `a.ts:2-3` ``two()``', hl && [hl]).filter((s) => s.token);
    expect(segs.map((s) => s.text)).toEqual(['`two()`', '`a.ts:2-3`']);
    expect(refHighlight([])).toBeUndefined();
  });
});

describe('composer state', () => {
  it('saves a draft without references exactly as before', () => {
    const d = draft();
    expect(draftFrom(d, initComposer(d))).toEqual(d);
  });

  it('drops a ref when its code span is deleted or edited, and the refs field with the last one', () => {
    const a = makeRef(rangeInput('src/a.ts', HEAD, 2), { root, headSha: HEAD, taken: [] });
    const b = makeRef(rangeInput('src/a.ts', HEAD, 3), { root, headSha: HEAD, taken: [a.label] });
    const d = draft({ body: `see \`${a.label}\` and \`${b.label}\``, refs: [a, b] });
    const s = initComposer(d);
    expect(draftFrom(d, { ...s, body: `see \`${b.label}\`.` }).refs).toEqual([b]);
    expect(draftFrom(d, { ...s, body: `see \`${a.label}x\` and ${b.label}` }).refs).toBeUndefined();
    expect('refs' in draftFrom(d, { ...s, body: 'no references left' })).toBe(false);
  });

  it('keeps a ref on save when a stray backtick sits in an earlier paragraph', () => {
    const a = makeRef(rangeInput('src/a.ts', HEAD, 2), { root, headSha: HEAD, taken: [] });
    const d = draft({ body: `don't use \` here.\n\nSee \`${a.label}\``, refs: [a] });
    expect(draftFrom(d, initComposer(d)).refs).toEqual([a]);
  });

  it('a suggestion still applies at its head, and after a head change with the same lines', () => {
    const t = fixture();
    const applies = suggestionStillApplies(t);
    expect(applies(draft({ suggestion: 'x', suggestionMeta: { source: 'manual', headSha: HEAD, originalHash: 'whatever' } }))).toBe(true);
    expect(applies(draft({ suggestion: 'x', suggestionMeta: { source: 'manual', headSha: 'old', originalHash: linesHash('three') } }))).toBe(true);
    expect(applies(draft({ suggestion: 'x', suggestionMeta: { source: 'manual', headSha: 'old', originalHash: linesHash('changed') } }))).toBe(false);
  });
});
