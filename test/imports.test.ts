import { describe, expect, it } from 'vitest';
import type { Chapter } from '../src/types.js';
import { importRuns, isImportOnlyHunk, separateImportChapter } from '../src/analysis/imports.js';
import { progress } from '../src/tui/nav.js';
import { chapter, hunkFromDiff as h, tour } from './fixtures/tour.js';

describe('isImportOnlyHunk', () => {
  it('accepts added, removed and reordered imports across languages', () => {
    expect(isImportOnlyHunk(h('a.ts', " import { a } from './a'", "+import { b } from './b'", "-import c from 'c'", ' ', ' export function f() {'))).toBe(true);
    expect(isImportOnlyHunk(h('a.ts', "+import type { T } from './t';", "+import './polyfill';", "+export * from './x';", "+const fs = require('fs');"))).toBe(true);
    expect(isImportOnlyHunk(h('A.kt', ' package com.acme.billing', ' ', '+import com.acme.billing.Invoice', '-import java.util.*', ' import kotlinx.coroutines.flow.Flow'))).toBe(true);
    expect(isImportOnlyHunk(h('a.py', '+from typing import Optional', '-import os', ' import sys'))).toBe(true);
    expect(isImportOnlyHunk(h('a.go', ' import (', ' \t"fmt"', '+\t"strings"', '+\tlog "github.com/sirupsen/logrus"', ' )'))).toBe(true);
    expect(isImportOnlyHunk(h('a.rs', '+use std::collections::HashMap;', '-use std::fmt;'))).toBe(true);
  });

  it('accepts multi-line import blocks, including a hunk that starts inside one', () => {
    expect(isImportOnlyHunk(h('a.ts', ' import {', '   a,', '+  b,', '   c,', " } from './x'"))).toBe(true);
    expect(isImportOnlyHunk(h('a.ts', '   a,', '+  type B,', '-  c as d,', " } from './x'", ' ', ' const x = 1'))).toBe(true);
    expect(isImportOnlyHunk(h('a.go', ' \t"fmt"', '+\t"strings"', ' )'))).toBe(true);
    expect(isImportOnlyHunk(h('a.rs', '     fmt,', '+    io,', ' };'))).toBe(true);
  });

  it('rejects hunks that change code too', () => {
    expect(isImportOnlyHunk(h('a.ts', "+import { b } from './b'", ' ', '+export const x = b()'))).toBe(false);
    expect(isImportOnlyHunk(h('A.kt', '+import com.acme.Foo', '+val foo = Foo()'))).toBe(false);
    expect(isImportOnlyHunk(h('a.ts', ' import {', '+  b,', " } from './x'", '-const y = 2'))).toBe(false);
    expect(isImportOnlyHunk(h('a.ts', ' const a = {', '+  b,', ' }'))).toBe(false); // object literal, not imports
    expect(isImportOnlyHunk(h('a.ts', '     b,', '+    c', '   }'))).toBe(false); // the end of one, starting inside it
    expect(isImportOnlyHunk(h('q.graphql', '       clSignedDate', '+      creditorInsuranceStatus', '     }', '     totalCount'))).toBe(false); // a field in a selection
    expect(isImportOnlyHunk(h('a.ts', ' // a', '+', ' // b'))).toBe(false); // blank-only change
  });
});

describe('importRuns', () => {
  it('finds the imports a hunk that changes code too adds or removes, blank lines between them included', () => {
    const hunk = h('A.kt', ' package acme', ' ', ' import acme.A', '-import acme.B', ' ', '+import acme.C', ' ', ' @Api', '-class Foo(', '+open class Foo(');
    expect(importRuns(hunk)).toEqual([{ start: 0, end: 5, added: 1, removed: 1 }]);
  });

  it('finds none in an import-only hunk, or among imports nothing changes', () => {
    expect(importRuns(h('a.ts', " import { a } from './a'", "+import { b } from './b'"))).toEqual([]);
    expect(importRuns(h('a.ts', " import { a } from './a'", ' ', '+go();'))).toEqual([]);
  });

  it('reads a block of imports the hunk starts inside', () => {
    expect(importRuns(h('a.ts', '   a,', '+  b,', " } from './x';", ' ', '+go(b);'))).toEqual([{ start: 0, end: 2, added: 1, removed: 0 }]);
  });
});

describe('separateImportChapter', () => {
  const ch = (id: string, kind: Chapter['kind'], hunkIds: string[]): Chapter => chapter(id, hunkIds, { kind, collapsed: kind !== 'flow' });

  it('moves import-only hunks into one optional chapter before config, dropping emptied chapters', () => {
    const a = h('a.ts', "+import x from 'x'");
    const b = h('a.ts', '+export const y = 1');
    const c = h('b.ts', "-import z from 'z'");
    a.importOnly = true;
    c.importOnly = true;
    const hunks = Object.fromEntries([a, b, c].map((x) => [x.id, x]));
    const out = separateImportChapter([ch('c1', 'flow', [a.id, b.id]), ch('c2', 'supporting', [c.id]), ch('c3', 'config', [])], hunks);
    expect(out.map((x) => x.kind)).toEqual(['flow', 'imports', 'config']);
    expect(out[0].hunkIds).toEqual([b.id]);
    expect(out[1]).toMatchObject({ optional: true, collapsed: true, hunkIds: [a.id, c.id] });
  });

  it('leaves chapters alone when nothing is import-only', () => {
    const b = h('a.ts', '+export const y = 1');
    const chapters = [ch('c1', 'flow', [b.id])];
    expect(separateImportChapter(chapters, { [b.id]: b })).toBe(chapters);
  });
});

describe('progress', () => {
  it('does not count import-only hunks', () => {
    const a = h('a.ts', "+import x from 'x'");
    a.importOnly = true;
    const b = h('a.ts', '+export const y = 1');
    const t = tour([a, b]);
    expect(progress(t, {})).toMatchObject({ total: 1, unread: 1, totalLines: 1 });
  });
});
