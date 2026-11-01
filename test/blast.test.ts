import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { blastFlag, findBlastRadius } from '../src/analysis/blast.js';
import { buildSymbolIndex } from '../src/analysis/symbols.js';
import { buildFixture, ctx, head } from './fixtures/invoiceFlow.js';

describe('findBlastRadius', () => {
  it('finds unchanged callers of changed exported code, tables and events', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-blast-'));
    const write = (p: string, t: string) => {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      fs.writeFileSync(path.join(root, p), t);
    };
    for (const [p, t] of Object.entries(head)) write(p, t);
    write('src/admin/rebill.ts', "import { createInvoice } from '../services/invoice.js';\nexport const rebill = () => createInvoice({});\n");
    write('src/reports/sales.sql', 'select * from invoices;\n');
    write('src/notify.ts', "bus.on('invoice.created', notify);\n");
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });

    const { files, hunks } = buildFixture();
    hunks.h3.lines.push({ kind: 'add', text: "  bus.emit('invoice.created', inv);", newLine: 99 });
    hunks.h3.lines.push({ kind: 'add', text: 'ALTER TABLE invoices ADD COLUMN paid_at timestamp;', newLine: 100 });
    const index = buildSymbolIndex(files, hunks, ctx);
    const items = await findBlastRadius(
      root,
      hunks,
      index,
      files.map((f) => f.path),
    );
    const create = items.find((i) => i.symbol === 'createInvoice')!;
    expect(create.callers.map((c) => c.file)).toEqual(['src/admin/rebill.ts']);
    expect(items.find((i) => i.symbol === 'table invoices')?.callers[0].file).toBe('src/reports/sales.sql');
    expect(items.find((i) => i.symbol === 'event invoice.created')?.callers[0].file).toBe('src/notify.ts');
    expect(items.find((i) => i.symbol === 'table invoices')?.change).toBe('table');
    expect(items.find((i) => i.symbol === 'event invoice.created')?.change).toBe('event');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('blastFlag', () => {
  const at = (n: number) => Array.from({ length: n }, (_, i) => ({ file: `src/u${i}.ts`, line: i + 1, text: 'use()' }));

  it('flags changed signatures, tables and events, the most used first', () => {
    const flag = blastFlag([
      { symbol: 'quiet', hunkId: 'h1', callers: at(9) },
      { symbol: 'table users', hunkId: 'h2', change: 'table', callers: at(1) },
      { symbol: 'parse', hunkId: 'h3', change: 'signature', callers: at(3) },
    ]);
    expect(flag).toEqual({
      kind: 'unchanged-callers',
      message: 'parse changed its signature: 3 uses in unchanged files; table users changed: 1 use in unchanged files',
      hunkIds: ['h3', 'h2'],
    });
  });

  it('leaves changes inside a body unflagged', () => {
    expect(blastFlag([{ symbol: 'quiet', hunkId: 'h1', callers: at(2) }])).toBeUndefined();
  });
});
