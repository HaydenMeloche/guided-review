import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fuzzyScore, RepoIndex } from '../src/analysis/repoIndex.js';

const FILES: Record<string, string> = {
  'src/billing/invoice.ts': [
    'export function saveInvoice(id: string) {', // 1
    '  return id;',
    '}',
    'export class InvoiceStore {', // 4
    '  save(x: number) {',
    '    return x + 1;', // 6
    '  }',
    '}',
  ].join('\n'),
  'src/billing/other.ts': ['export function saveInvoiceDraft() {}', 'class OtherStore {', '  save() {', '    return 2;', '  }', '}'].join('\n'),
  'src/app.ts': ["import { saveInvoice } from './billing/invoice.js';", 'export function main() {', "  saveInvoice('a');", '}'].join('\n'),
  'src/invoices/index.ts': 'export const listInvoices = () => [];\n',
  'py/service.py': ['class PaymentService:', '    def charge_card(self, amount):', '        return amount', '', 'def refund_payment(p):', '    return p'].join('\n'),
  'dotnet/Ledger.cs': ['public class Ledger {', '  public int ComputeTotal(int x) {', '    return x;', '  }', '}'].join('\n'),
  'README.md': 'saveInvoice ComputeTotal charge_card\n',
};

let root: string;

function makeRepo(files: Record<string, string>, prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

const index = (opts: { rg?: string } = {}) => new RepoIndex({ root, headSha: 'abc', changedFiles: ['src/billing/invoice.ts'], ...opts });

beforeAll(() => {
  root = makeRepo(FILES, 'gr-repoindex-');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('fuzzyScore', () => {
  it('requires a subsequence and prefers segment starts and runs', () => {
    expect(fuzzyScore('xyz', 'src/app.ts')).toBeUndefined();
    expect(fuzzyScore('sbi', 'src/billing/invoice.ts')).toBeDefined();
    expect(fuzzyScore('inv', 'invoice.ts')!).toBeGreaterThan(fuzzyScore('inv', 'ainvb.ts')!);
    expect(fuzzyScore('ss', 'saveStore')!).toBeGreaterThan(fuzzyScore('ss', 'assay')!);
  });
});

describe('RepoIndex.files', () => {
  it('ranks basename matches first and boosts changed files', async () => {
    const idx = index();
    const hits = await idx.files('invoice');
    expect(hits[0]).toMatchObject({ path: 'src/billing/invoice.ts', changed: true });
    expect(hits.map((h) => h.path)).toContain('src/invoices/index.ts');
    expect(hits.map((h) => h.path)).not.toContain('py/service.py');
    expect((await idx.files('ledger'))[0].path).toBe('dotnet/Ledger.cs');
    expect((await idx.files('sbo'))[0].path).toBe('src/billing/other.ts');
    expect(await idx.files('zzzz')).toEqual([]);
    expect(await idx.files('s', { limit: 2 })).toHaveLength(2);
  });

  it('lists changed, then recent files for an empty query', async () => {
    const hits = await index().files('', { recent: ['py/service.py'], limit: 3 });
    expect(hits.map((h) => h.path)).toEqual(['src/billing/invoice.ts', 'py/service.py', 'README.md']);
    expect(hits[0].changed).toBe(true);
  });
});

describe('RepoIndex.symbols', () => {
  it('finds declarations in unchanged TS files and ranks exact over prefix', async () => {
    const hits = await index().symbols('saveInvoice');
    expect(hits.map((h) => h.qualified)).toEqual(['src/billing/invoice.ts#saveInvoice', 'src/billing/other.ts#saveInvoiceDraft']);
    expect(hits[0]).toMatchObject({ kind: 'function', file: 'src/billing/invoice.ts', startLine: 1, endLine: 3, exported: true });
    expect(hits.truncated).toBe(false);
  });

  it('parses Python with tree-sitter and C# with the fallback', async () => {
    const idx = index();
    const py = await idx.symbols('charge');
    expect(py[0]).toMatchObject({ name: 'charge_card', file: 'py/service.py', owner: 'PaymentService', kind: 'method', startLine: 2 });
    const cs = await idx.symbols('computetot');
    expect(cs[0]).toMatchObject({ name: 'ComputeTotal', file: 'dotnet/Ledger.cs', owner: 'Ledger' });
    // Markdown is never parsed.
    expect(idx.declsIn('README.md')).toBeUndefined();
  });

  it('keeps duplicate names apart by file and owner', async () => {
    const idx = index();
    const hits = await idx.symbols('save');
    const saves = hits.filter((h) => h.name === 'save');
    expect(saves.map((h) => `${h.file}#${h.owner}`).sort()).toEqual(['src/billing/invoice.ts#InvoiceStore', 'src/billing/other.ts#OtherStore']);
    // The changed file's method ranks first among equal names.
    expect(hits[0]).toMatchObject({ name: 'save', owner: 'InvoiceStore' });
    const narrowed = await idx.symbols('Other.save');
    expect(narrowed.map((h) => h.qualified)).toEqual(['src/billing/other.ts#OtherStore.save']);
  });

  it('boosts recent files', async () => {
    const hits = await index().symbols('save', { recent: ['src/billing/other.ts'] });
    expect(hits[0]).toMatchObject({ name: 'save', owner: 'OtherStore' });
  });

  it('answers a one-character query from changed and already parsed files only', async () => {
    const idx = index();
    const hits = await idx.symbols('s');
    expect(hits.length).toBeGreaterThan(0);
    expect(new Set(hits.map((h) => h.file))).toEqual(new Set(['src/billing/invoice.ts']));
    expect(idx.declsIn('src/billing/other.ts')).toBeUndefined();
  });

  it('rejects when aborted', async () => {
    const before = new AbortController();
    before.abort();
    await expect(index().symbols('save', { signal: before.signal })).rejects.toThrow();
    const during = new AbortController();
    const p = index().symbols('save', { signal: during.signal });
    during.abort();
    await expect(p).rejects.toThrow();
  });

  it('honors the result limit', async () => {
    expect(await index().symbols('s', { limit: 1 })).toHaveLength(1);
  });

  it('falls back to git grep when ripgrep is missing', async () => {
    const idx = index({ rg: 'gr-no-such-ripgrep' });
    expect((await idx.symbols('ComputeTotal')).map((h) => h.qualified)).toEqual(['dotnet/Ledger.cs#Ledger.ComputeTotal']);
    expect((await idx.possibleCallers('saveInvoice')).map((c) => `${c.file}:${c.line}`)).toEqual(['src/app.ts:3']);
  });
});

describe('RepoIndex.enclosingDecl and possibleCallers', () => {
  it('finds the innermost declaration around a line', async () => {
    const idx = index();
    expect((await idx.enclosingDecl('src/billing/invoice.ts', 6))?.qualified).toBe('src/billing/invoice.ts#InvoiceStore.save');
    expect((await idx.enclosingDecl('src/billing/invoice.ts', 4))?.qualified).toBe('src/billing/invoice.ts#InvoiceStore');
    expect(await idx.enclosingDecl('README.md', 1)).toBeUndefined();
    expect(await idx.ensureParsed('../outside.ts')).toEqual([]);
  });

  it('lists name matches excluding the declaration and imports', async () => {
    const callers = await index().possibleCallers('saveInvoice');
    expect(callers).toEqual([{ file: 'src/app.ts', line: 3, text: "saveInvoice('a');" }]);
    // A method declaration is excluded once its file is parsed.
    const idx = index();
    await idx.ensureParsed('src/billing/invoice.ts');
    await idx.ensureParsed('src/billing/other.ts');
    expect(await idx.possibleCallers('save')).toEqual([]);
    expect(await idx.possibleCallers('not an identifier')).toEqual([]);
  });

  it('caps callers', async () => {
    const dir = makeRepo({ 'a.ts': Array.from({ length: 50 }, () => 'ping();').join('\n') }, 'gr-repoindex-callers-');
    try {
      const idx = new RepoIndex({ root: dir, headSha: 'x' });
      expect(await idx.possibleCallers('ping', { limit: 5 })).toHaveLength(5);
      expect(await idx.possibleCallers('ping')).toHaveLength(20);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
