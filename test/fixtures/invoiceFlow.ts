import type { DiffFile, DiffLine, FileKind, Hunk } from '../../src/types.js';
import { filesFor, hunk } from './tour.js';

// A small PR: route -> service -> repo, a type change, an orphan constant,
// a paired test, a config file and a lockfile.
export const head: Record<string, string> = {
  'src/routes/invoices.ts': `import { Router } from 'express';
import { createInvoice } from '../services/invoice.js';

export const router = Router();

router.post('/invoices', handleCreate);

async function handleCreate(req: any, res: any) {
  const invoice = await createInvoice(req.body);
  res.json(invoice);
}
`,
  'src/services/invoice.ts': `import { saveInvoice } from '../db/invoiceRepo.js';
import type { Invoice } from '../types.js';

export async function createInvoice(input: Partial<Invoice>): Promise<Invoice> {
  const total = computeTotal(input);
  if (total < 0) {
    throw new Error('negative total');
  }
  return saveInvoice({ ...input, total } as Invoice);
}

function computeTotal(input: Partial<Invoice>): number {
  return (input.lines ?? []).reduce((s, l) => s + l.amount, 0);
}
`,
  'src/db/invoiceRepo.ts': `import type { Invoice } from '../types.js';

export async function saveInvoice(inv: Invoice): Promise<Invoice> {
  await db.insert('invoices', inv);
  return inv;
}
`,
  'src/types.ts': `export type InvoiceStatus = 'draft' | 'sent' | 'paid';

export interface Invoice {
  id: string;
  total: number;
  status: InvoiceStatus;
  lines?: { amount: number }[];
  paidAt?: string;
}
`,
  'src/util/format.ts': `export const CURRENCY = 'EUR';
`,
  'test/invoice.test.ts': `import { createInvoice } from '../src/services/invoice.js';

it('computes totals', async () => {
  expect((await createInvoice({ lines: [{ amount: 2 }] })).total).toBe(2);
});
`,
  'config/app.yml': `port: 8080
`,
  'pnpm-lock.yaml': `lockfileVersion: '9.0'
`,
};

export const base: Record<string, string> = {
  'src/types.ts': `export type InvoiceStatus = 'draft' | 'sent';

export interface Invoice {
  id: string;
  total: number;
  status: InvoiceStatus;
  lines?: { amount: number }[];
}
`,
  'src/util/format.ts': `export const CURRENCY = 'USD';
`,
};

const kinds: Record<string, FileKind> = {
  'test/invoice.test.ts': 'test',
  'config/app.yml': 'config',
  'pnpm-lock.yaml': 'generated',
};

// Whole-file hunk: lines that differ from base are del/add, the rest context.
function wholeFileHunk(id: string, file: string, before: string | undefined, after: string): Hunk {
  const a = before === undefined ? [] : before.replace(/\n$/, '').split('\n');
  const b = after.replace(/\n$/, '').split('\n');
  const lines: DiffLine[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== undefined && a[i] === b[i]) lines.push({ kind: 'ctx', text: b[i], oldLine: i + 1, newLine: i + 1 });
    else {
      if (a[i] !== undefined) lines.push({ kind: 'del', text: a[i], oldLine: i + 1 });
      if (b[i] !== undefined) lines.push({ kind: 'add', text: b[i], newLine: i + 1 });
    }
  }
  const oldStart = a.length ? 1 : 0;
  return hunk(id, file, lines, {
    contentHash: id,
    header: `@@ -${oldStart},${a.length} +1,${b.length} @@`,
    oldStart,
    oldLines: a.length,
    newStart: 1,
    newLines: b.length,
  });
}

export function buildFixture(): { files: DiffFile[]; hunks: Record<string, Hunk> } {
  const list = Object.entries(head).map(([path, text], i) => wholeFileHunk(`h${i + 1}`, path, base[path], text));
  const status = Object.fromEntries(list.map((h) => [h.file, base[h.file] ? 'modified' : 'added'] as const));
  const files = filesFor(list, kinds, status, { kindReason: 'fixture' });
  const hunks = Object.fromEntries(list.map((h) => [h.id, h]));
  hunks.h2.risk = 2;
  hunks.h2.riskReasons = ['throws on negative totals'];
  return { files, hunks };
}

export const ctx = {
  readHead: (p: string) => head[p],
  readBase: (p: string) => base[p],
};

export function hunkOf(hunks: Record<string, Hunk>, file: string): string {
  return Object.values(hunks).find((h) => h.file === file)!.id;
}
