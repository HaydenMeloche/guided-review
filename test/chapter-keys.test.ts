import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Key } from 'ink';
import { barKeys, boundKeys, keyAction, KEYS, type KeyCtx } from '../src/tui/chapter/keys.js';

const off: KeyCtx = {
  hunk: false,
  chapter: true,
  agent: false,
  selecting: false,
  threads: false,
  reply: false,
  draft: false,
  tests: false,
  diagram: false,
  done: false,
  split: false,
  rereview: false,
  rebase: false,
  theme: false,
};
const all: KeyCtx = Object.fromEntries(Object.keys(off).map((k) => [k, true])) as unknown as KeyCtx;
const noKey = {} as Key;

describe('keyAction', () => {
  it('lets a collapsed summary take its keys before the code keys', () => {
    expect(keyAction('collapsed', off, 'x', noKey)).toBe('skipChapter');
    expect(keyAction('collapsed', off, 'e', noKey)).toBe('expand');
    expect(keyAction('collapsed', off, '', { return: true } as Key)).toBe('expand');
    expect(keyAction('collapsed', off, 'n', noKey)).toBe('next');
    expect(keyAction('code', { ...off, hunk: true }, 'x', noKey)).toBe('skip');
  });

  it('does nothing for a key whose condition fails', () => {
    expect(keyAction('code', off, 'x', noKey)).toBeUndefined();
    expect(keyAction('code', { ...off, hunk: true }, 'y', noKey)).toBeUndefined();
    expect(keyAction('code', { ...off, hunk: true, reply: true }, 'y', noKey)).toBe('reply');
    expect(keyAction('code', off, 'R', noKey)).toBeUndefined();
    expect(keyAction('code', { ...off, rebase: true }, 'R', noKey)).toBe('rebase');
  });

  it('keeps focused tests to their own keys, b, and q', () => {
    expect(keyAction('tests', all, 'x', noKey)).toBeUndefined();
    expect(keyAction('tests', all, 'n', noKey)).toBe('nextTest');
    expect(keyAction('tests', all, '', { tab: true } as Key)).toBe('nextTest');
    expect(keyAction('tests', all, 't', noKey)).toBe('leaveTests');
    expect(keyAction('tests', all, '', { escape: true } as Key)).toBe('leaveTests');
    expect(keyAction('tests', all, 'b', noKey)).toBe('briefing');
    expect(keyAction('tests', all, 'q', noKey)).toBe('back');
  });

  it('reads arrows and page keys as j/k and J/K', () => {
    const h = { ...off, hunk: true };
    expect(keyAction('code', h, '', { downArrow: true } as Key)).toBe('down');
    expect(keyAction('code', h, '', { pageUp: true } as Key)).toBe('pageUp');
    expect(keyAction('code', h, '=', noKey)).toBe('moreContext');
  });

  it('binds each key once per view', () => {
    for (const mode of ['code', 'tests', 'collapsed', 'any']) {
      const keys = KEYS.flatMap((r) => r.bind ?? []).flatMap((b) => (b.mode === mode ? b.on : []));
      expect(keys).toEqual([...new Set(keys)]);
    }
  });
});

describe('barKeys', () => {
  it('lists the code keys that do something, most useful first', () => {
    expect(barKeys('code', off)).toEqual([
      ['n/p', 'hunk'],
      ['c', 'comment'],
      ['v', 'range'],
      [']/[', 'chapter'],
      ['x', 'skip'],
      ['+/-', 'context'],
      ['S', 'split'],
    ]);
    expect(barKeys('code', all)).toEqual([
      ['s', 'submit'],
      ['n/p', 'hunk'],
      ['c', 'comment on range'],
      ['e', 'thread'],
      ['y', 'reply'],
      ['E', 'edit draft'],
      ['X', 'delete draft'],
      ['?', 'ask'],
      ['v', 'end range'],
      [']/[', 'chapter'],
      ['t', 'tests'],
      ['d', 'diagram'],
      ['x', 'skip'],
      ['+/-', 'context'],
      ['S', 'inline'],
    ]);
  });

  it('lists a collapsed summary’s keys and focused tests’ keys', () => {
    expect(barKeys('collapsed', all)).toEqual([
      ['s', 'submit'],
      ['enter', 'expand'],
      ['n/p', 'next/prev'],
      ['C', 'comment on flow'],
      ['x', 'skip chapter'],
      [']/[', 'chapter'],
    ]);
    expect(barKeys('tests', all)).toEqual([
      ['n/p', 'test'],
      ['c', 'comment'],
      ['?', 'ask'],
    ]);
    expect(barKeys('tests', off)).toEqual([
      ['n/p', 'test'],
      ['c', 'comment'],
    ]);
  });
});

describe('docs', () => {
  // `=` is a convenience for `+` on keyboards where + needs shift.
  const aliases = new Set(['=']);

  it('docs/usage.md describes every chapter screen key', () => {
    const usage = fs.readFileSync(new URL('../docs/usage.md', import.meta.url), 'utf8');
    const missing = boundKeys().filter((k) => !aliases.has(k) && !usage.includes(`\`${k}\``));
    expect(missing).toEqual([]);
  });
});
