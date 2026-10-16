import { describe, expect, it } from 'vitest';
import { baseRefLabel, codeSpans, linkRefs, permalink, refLabel, referencedRefs, uniqueLabels } from '../src/review/refs.js';
import type { CodeRef } from '../src/types.js';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const ref = (extra: Partial<CodeRef> & Pick<CodeRef, 'label'>): CodeRef => ({ id: extra.label, kind: 'range', path: 'src/inventory/stock.ts', commitSha: SHA, startLine: 84, endLine: 96, ...extra });

describe('permalink', () => {
  it('pins to the commit and links a range, a single line, or a whole file', () => {
    expect(permalink('github.com', 'o/shop', SHA, 'src/inventory/stock.ts', 84, 96)).toBe(`https://github.com/o/shop/blob/${SHA}/src/inventory/stock.ts#L84-L96`);
    expect(permalink('github.com', 'o/shop', SHA, 'src/a.ts', 84)).toBe(`https://github.com/o/shop/blob/${SHA}/src/a.ts#L84`);
    expect(permalink('github.com', 'o/shop', SHA, 'src/a.ts', 84, 84)).toBe(`https://github.com/o/shop/blob/${SHA}/src/a.ts#L84`);
    expect(permalink('github.com', 'o/shop', SHA, 'src/a.ts')).toBe(`https://github.com/o/shop/blob/${SHA}/src/a.ts`);
  });

  it('encodes each path segment, keeping the slashes', () => {
    expect(permalink('github.com', 'o/r', SHA, 'docs/my file#1 100%.md')).toBe(`https://github.com/o/r/blob/${SHA}/docs/my%20file%231%20100%25.md`);
    expect(permalink('github.com', 'o/r', SHA, 'src/café/日本.ts', 3)).toBe(`https://github.com/o/r/blob/${SHA}/src/caf%C3%A9/%E6%97%A5%E6%9C%AC.ts#L3`);
    expect(permalink('github.com', 'o/r', SHA, 'a/?b&c.ts')).toBe(`https://github.com/o/r/blob/${SHA}/a/%3Fb%26c.ts`);
  });

  it('uses the GitHub Enterprise host it is given', () => {
    expect(permalink('ghe.example.com', 'team/app', SHA, 'x.ts', 1, 2)).toBe(`https://ghe.example.com/team/app/blob/${SHA}/x.ts#L1-L2`);
  });
});

describe('refLabel', () => {
  it('names functions name(), other declarations file#Name, files and ranges, without whitespace or backticks', () => {
    expect(baseRefLabel({ kind: 'symbol', path: 'src/s.ts', symbol: 'InventoryService.releaseInventory', symbolKind: 'method' })).toBe('releaseInventory()');
    expect(baseRefLabel({ kind: 'symbol', path: 'src/inventory/stock.ts', symbol: 'RetryPolicy', symbolKind: 'class' })).toBe('stock.ts#RetryPolicy');
    expect(baseRefLabel({ kind: 'symbol', path: 'src/s.ts', symbol: 'Options', symbolKind: 'interface' })).toBe('s.ts#Options');
    expect(baseRefLabel({ kind: 'symbol', path: 'src/s.go', symbol: 'Release', symbolKind: 'function' })).toBe('Release()');
    expect(baseRefLabel({ kind: 'symbol', path: 'src/s.ts', symbol: 'src/s.ts#helper' })).toBe('helper()');
    expect(baseRefLabel({ kind: 'symbol', path: 'src/s.ts', symbol: 'Cart' })).toBe('s.ts#Cart');
    expect(baseRefLabel({ kind: 'file', path: 'src/inventory/stock.ts' })).toBe('stock.ts');
    expect(baseRefLabel({ kind: 'range', path: 'src/inventory/stock.ts', startLine: 84, endLine: 96 })).toBe('stock.ts:84-96');
    expect(baseRefLabel({ kind: 'range', path: 'src/inventory/stock.ts', startLine: 84, endLine: 84 })).toBe('stock.ts:84');
    expect(baseRefLabel({ kind: 'thread', path: 'src/cart.ts', startLine: 17 })).toBe('thread:cart.ts:17');
    expect(baseRefLabel({ kind: 'file', path: 'docs/release notes`v2`.md' })).toBe('release_notes_v2_.md');
    expect(baseRefLabel({ kind: 'file', path: 'docs/me@v2.md' })).toBe('me@v2.md');
  });

  it('tells duplicate names apart by file, then path, then a counter', () => {
    const sym = (p: string) => ({ kind: 'symbol' as const, path: p, symbol: 'releaseInventory', symbolKind: 'function' as const });
    expect(uniqueLabels([sym('src/inventory/stock.ts'), sym('src/legacy/stock.js'), sym('src/other/stock.js'), sym('src/other/stock.js')])).toEqual([
      'releaseInventory()',
      'stock.js#releaseInventory()',
      'src/other/stock.js#releaseInventory()',
      'src/other/stock.js#releaseInventory()~2',
    ]);
    const cls = (p: string) => ({ kind: 'symbol' as const, path: p, symbol: 'RetryPolicy', symbolKind: 'class' as const });
    expect(uniqueLabels([cls('a/stock.ts'), cls('b/stock.ts')])).toEqual(['stock.ts#RetryPolicy', 'b/stock.ts#RetryPolicy']);
    expect(refLabel({ kind: 'range', path: 'b/stock.ts', startLine: 1, endLine: 2 }, ['stock.ts:1-2'])).toBe('b/stock.ts:1-2');
    expect(refLabel({ kind: 'file', path: 'stock.ts' }, ['stock.ts'])).toBe('stock.ts~2');
    for (const l of uniqueLabels([sym('a b/x y.ts'), sym('a b/x y.ts')])) expect(l).not.toMatch(/[\s`]/);
  });
});

describe('linkRefs', () => {
  const refs = [
    ref({ label: 'releaseInventory()' }),
    ref({ label: 'stock.ts:84-96' }),
    ref({ label: 'stock.ts#RetryPolicy' }),
    ref({ id: 't', kind: 'thread', label: 'thread:cart.ts:17', threadUrl: 'https://github.com/o/shop/pull/1#discussion_r9' }),
  ];
  const url = `https://github.com/o/shop/blob/${SHA}/src/inventory/stock.ts#L84-L96`;
  const go = (body: string) => linkRefs(body, refs, 'github.com', 'o/shop');

  it('links code spans that are exactly a label, threads to their discussion', () => {
    expect(go('calls `releaseInventory()`, then `stock.ts:84-96`.')).toBe(`calls [\`releaseInventory()\`](${url}), then [\`stock.ts:84-96\`](${url}).`);
    expect(go('`stock.ts#RetryPolicy`')).toBe(`[\`stock.ts#RetryPolicy\`](${url})`);
    expect(go('as in `thread:cart.ts:17`')).toBe('as in [`thread:cart.ts:17`](https://github.com/o/shop/pull/1#discussion_r9)');
  });

  it('leaves other code, fenced blocks, longer backtick runs and existing links untouched', () => {
    const body = [
      'Plain `x + 1` and ` releaseInventory()` and `releaseInventory`',
      '```',
      '`releaseInventory()`',
      '```',
      '~~~ts',
      '`stock.ts:84-96`',
      '~~~',
      '``releaseInventory()`` and [`stock.ts:84-96`](https://example.com) and @@releaseInventory()',
    ].join('\n');
    expect(go(body)).toBe(body);
  });

  it('pairs backticks as Markdown does around an unclosed one', () => {
    expect(go('a ` b `releaseInventory()`')).toBe('a ` b `releaseInventory()`');
    expect(go('a `releaseInventory()` b `')).toBe(`a [\`releaseInventory()\`](${url}) b \``);
  });

  it('returns a body naming no ref as is', () => {
    expect(go('plain **text** `code`')).toBe('plain **text** `code`');
    expect(linkRefs('`releaseInventory()`', [], 'github.com', 'o/shop')).toBe('`releaseInventory()`');
  });

  it('finds spans after a fence closes, at their offsets', () => {
    const body = 'a\n```\nx\n```\nsee `stock.ts:84-96`';
    expect(codeSpans(body)).toEqual([{ start: body.indexOf('`stock'), end: body.length, text: 'stock.ts:84-96' }]);
  });

  it('never pairs a stray backtick with one in a later paragraph', () => {
    const body = "don't use ` here.\n\nSee `foo()`";
    expect(codeSpans(body)).toEqual([{ start: body.indexOf('`foo'), end: body.length, text: 'foo()' }]);
    const refs = [ref({ id: 'f', label: 'foo()' })];
    expect(referencedRefs(body, refs)).toEqual(refs);
    expect(linkRefs(body, refs, 'github.com', 'o/shop')).toBe(`don't use \` here.\n\nSee [\`foo()\`](https://github.com/o/shop/blob/${SHA}/src/inventory/stock.ts#L84-L96)`);
    // Within a paragraph a span may still wrap a line, as on GitHub.
    expect(codeSpans('a `b\nc` d').map((s) => s.text)).toEqual(['b\nc']);
  });
});

describe('referencedRefs', () => {
  it('keeps only refs a code span still names, in order, ignoring fenced code and near misses', () => {
    const refs = [ref({ id: 'a', label: 'foo()' }), ref({ id: 'b', label: 'stock.ts:84-96' }), ref({ id: 'c', label: 'gone' }), ref({ id: 'd', label: 'fenced' })];
    expect(referencedRefs('see `stock.ts:84-96`, then `foo()`. `gone ` and\n```\n`fenced`\n```', refs).map((r) => r.id)).toEqual(['a', 'b']);
    expect(referencedRefs('no references foo()', refs)).toEqual([]);
    expect(referencedRefs('`x`', [])).toEqual([]);
  });
});
