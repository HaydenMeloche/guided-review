import { describe, expect, it } from 'vitest';
import { buildSymbolIndex, parseFallbackSymbols, parseTsSymbols } from '../src/analysis/symbols.js';
import { buildFixture, ctx, hunkOf } from './fixtures/invoiceFlow.js';

describe('parseTsSymbols', () => {
  it('collects declarations, calls and route entries', () => {
    const { decls, entries } = parseTsSymbols(
      'a.tsx',
      `
import express from 'express';
const app = express();
app.get('/users/:id', getUser);
export function getUser(req: Req) { return loadUser(req.id); }
class Repo { find() { return this.query('x'); } }
export const Panel = () => <Box><Row/></Box>;
program.command('sync').action(runSync);
emitter.on('invoice.paid', onPaid);
export async function GET() { return new Response(); }
`.replace(/^\n/, ''),
      'head',
    );
    const byName = Object.fromEntries(decls.map((d) => [d.qualified, d]));
    expect(byName['a.tsx#getUser'].calls).toContain('loadUser');
    expect(byName['a.tsx#getUser'].exported).toBe(true);
    expect(byName['a.tsx#Repo.find'].calls).toContain('query');
    expect(byName['a.tsx#Panel'].kind).toBe('component');
    expect(byName['a.tsx#Panel'].calls).toEqual(expect.arrayContaining(['Box', 'Row']));
    expect(byName['a.tsx#GET'].kind).toBe('route');
    const reasons = entries.map((e) => e.reason);
    expect(reasons).toContain('route GET /users/:id');
    expect(reasons).toContain('CLI command sync');
    expect(reasons).toContain("event handler 'invoice.paid'");
    expect(entries.find((e) => e.reason === 'route GET /users/:id')?.handler).toBe('getUser');
  });
});

describe('parseFallbackSymbols', () => {
  it('finds python defs, methods and calls', () => {
    const { decls, entries } = parseFallbackSymbols(
      'svc.py',
      `
@app.route('/pay')
def pay():
    return charge(1)

class Billing:
    def charge(self, n):
        return n
`.replace(/^\n/, ''),
      'head',
    );
    const names = decls.map((d) => d.qualified);
    expect(names).toEqual(expect.arrayContaining(['svc.py#pay', 'svc.py#Billing', 'svc.py#Billing.charge']));
    expect(decls.find((d) => d.name === 'pay')!.calls).toContain('charge');
    expect(entries[0].reason).toBe('route /pay');
  });
});

describe('buildSymbolIndex', () => {
  it('maps hunks to declarations and links changed code across files', () => {
    const { files, hunks } = buildFixture();
    const index = buildSymbolIndex(files, hunks, ctx);
    const route = hunkOf(hunks, 'src/routes/invoices.ts');
    expect(index.hunkDecls[route]).toEqual(expect.arrayContaining(['src/routes/invoices.ts#handleCreate']));
    expect(hunks[route].symbols).toContain('handleCreate');
    const edge = (from: string, to: string) => index.edges.some((e) => e.from.endsWith(from) && e.to.endsWith(to));
    expect(edge('#handleCreate', '#createInvoice')).toBe(true);
    expect(edge('#createInvoice', '#computeTotal')).toBe(true);
    expect(edge('#createInvoice', '#saveInvoice')).toBe(true);
    expect(index.edges.every((e) => e.source === 'name-match')).toBe(true);
    const types = hunkOf(hunks, 'src/types.ts');
    expect(index.hunkDecls[types]).toEqual(['src/types.ts#InvoiceStatus', 'src/types.ts#Invoice']);
    expect(index.typeDecls.has('src/types.ts#InvoiceStatus')).toBe(true);
    const routeEntry = index.entries.find((e) => e.reason === 'route POST /invoices');
    expect(routeEntry).toMatchObject({ hunkId: route, symbol: 'src/routes/invoices.ts#handleCreate' });
    expect(index.lowConfidence).toBe(false);
  });
});
