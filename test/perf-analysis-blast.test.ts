import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findBlastRadius, wordMatcher } from '../src/analysis/blast.js';
import type { SymbolIndex } from '../src/analysis/symbols.js';
import type { Hunk } from '../src/types.js';

describe('wordMatcher', () => {
  it('uses git grep -w word boundaries (letters, digits, underscore)', () => {
    const match = wordMatcher(['save', 'loadAll', 'x_1']);
    expect([...match('save(x); loadAll()')].sort()).toEqual(['loadAll', 'save']);
    expect([...match('$save + save$ + .save')]).toEqual(['save']); // $ and . are not word characters
    expect(match('autosave saved save_all 1save').size).toBe(0);
    expect([...match('a.x_1 = 2')]).toEqual(['x_1']);
    expect(match('SAVE').size).toBe(0);
  });

  it('matches case-insensitively and reports lowercased names with ignoreCase', () => {
    const match = wordMatcher(['Invoices'], true);
    expect([...match('select * from INVOICES')]).toEqual(['invoices']);
    expect(match('invoices_archive').size).toBe(0);
  });

  it('handles names with non-word characters', () => {
    const match = wordMatcher(['$store']);
    expect([...match('const s = $store.get()')]).toEqual(['$store']);
    expect(match('a$store').size).toBe(0);
    expect(match('$stores').size).toBe(0);
  });
});

describe('findBlastRadius combined grep', () => {
  let root: string;
  const lines = [
    'saveInvoice(a);',
    'x.saveInvoice(b); loadInvoice(c);',
    '$saveInvoice();',
    'saveInvoiceAll(); load_invoice();',
    'const y = loadInvoice',
    `${'pad '.repeat(80)}saveInvoice(long)`, // past the 200-character display cut
    'bus.on(\'invoice.created\', h); bus.on("invoice.paid", h);',
    "bus.once('invoice.paid', h);",
    'select * from INVOICES join payments;',
    'select * from payments_archive;',
  ];
  const grep = (args: string[]) => {
    try {
      return execFileSync('git', ['grep', '-n', '-I', ...args], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-blast-bucket-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/a.ts'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(root, 'src/b.ts'), [...lines].reverse().join('\n') + '\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('splits one grep into the same lines as one grep per name', () => {
    const names = ['saveInvoice', 'loadInvoice', 'load_invoice'];
    const match = wordMatcher(names);
    const combined = grep(['-w', ...names.flatMap((n) => ['-e', n])]);
    for (const n of names) {
      const single = grep(['-w', '-e', n]);
      expect(combined.filter((l) => match(l.replace(/^[^:]+:\d+:/, '')).has(n))).toEqual(single);
    }
  });

  it('keeps per-symbol, per-table and per-event results apart', async () => {
    const decl = (name: string) => ({
      name,
      qualified: `src/lib.ts#${name}`,
      file: 'src/lib.ts',
      kind: 'function' as const,
      startLine: 1,
      endLine: 2,
      exported: true,
      calls: [],
      side: 'head' as const,
    });
    const index: SymbolIndex = {
      decls: [decl('saveInvoice'), decl('loadInvoice')],
      hunkDecls: { h1: ['src/lib.ts#saveInvoice', 'src/lib.ts#loadInvoice'] },
      edges: [],
      entries: [],
      typeDecls: new Set(),
      lowConfidence: false,
    };
    const hunk: Hunk = {
      id: 'h1',
      file: 'src/lib.ts',
      header: '@@',
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: 3,
      lines: [
        { kind: 'add', text: 'ALTER TABLE invoices ADD x int; create table payments (id int);', newLine: 1 },
        { kind: 'add', text: 'emit(\'invoice.created\'); publish("invoice.paid");', newLine: 2 },
      ],
      symbols: [],
      tests: [],
    } as unknown as Hunk;
    const items = await findBlastRadius(root, { h1: hunk }, index, ['src/lib.ts']);
    const by = Object.fromEntries(items.map((i) => [i.symbol, i.callers.map((c) => `${c.file}:${c.line}`)]));
    // What one `git grep` per name finds (no line here is a definition or an import).
    const expected = (args: string[]) => grep(args).map((l) => l.split(':').slice(0, 2).join(':'));
    expect(Object.keys(by)).toEqual(['saveInvoice', 'loadInvoice', 'table invoices', 'table payments', 'event invoice.created', 'event invoice.paid']);
    expect(by.saveInvoice).toEqual(expected(['-w', '-e', 'saveInvoice']));
    expect(by.loadInvoice).toEqual(expected(['-w', '-e', 'loadInvoice']));
    expect(by['table invoices']).toEqual(expected(['-i', '-w', '-e', 'invoices']));
    expect(by['table payments']).toEqual(expected(['-i', '-w', '-e', 'payments']));
    expect(by['event invoice.created']).toEqual(['src/a.ts:7', 'src/b.ts:4']);
    expect(by['event invoice.paid']).toEqual(['src/a.ts:7', 'src/a.ts:8', 'src/b.ts:3', 'src/b.ts:4']);
    // The long line still counts although its displayed text is cut.
    expect(by.saveInvoice).toContain('src/a.ts:6');
  });
});
