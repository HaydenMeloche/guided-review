import { describe, expect, it } from 'vitest';
import { codeTerms, resolveCodeRefs } from '../src/review/codeRefs.js';
import type { FileHit, SymbolHit, SymbolResults } from '../src/analysis/repoIndex.js';

const texts = (body: string) => codeTerms(body).map((t) => t.text);

describe('codeTerms', () => {
  it('finds the class a comment names in prose', () => {
    // pinecorpca/servicing#1577
    expect(codeTerms('**[suggestion]** We have a PaymentsUtils that we use as a repository layer. Can we move the queries to that file?')).toEqual([
      { text: 'PaymentsUtils', kind: 'symbol', name: 'PaymentsUtils' },
    ]);
  });

  it('reads inline code, camelCase, snake_case, Owner.member and file names', () => {
    expect(texts('Use `retry` like getFundsSettledDate does in FacilitiesService.kt, or PaymentsUtils.findBorrowers and max_attempts.')).toEqual([
      'retry',
      'FacilitiesService.kt',
      'PaymentsUtils.findBorrowers',
      'getFundsSettledDate',
      'max_attempts',
    ]);
    expect(codeTerms('see PaymentsUtils.findBorrowers')[0]).toEqual({ text: 'PaymentsUtils.findBorrowers', kind: 'symbol', owner: 'PaymentsUtils', name: 'findBorrowers' });
    expect(texts('call `loadAll()` first')).toEqual(['loadAll']);
  });

  it('leaves out plain words, URLs, code blocks, HTML comments and badges', () => {
    const body = [
      '<!-- codex-pull-request-review-summary -->',
      '**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Payments are Fine here**',
      'See https://github.com/o/r/blob/abc/src/RetryPolicy.kt#L3 for details.',
      '```suggestion',
      'val borrowerEmail = BorrowerRepo.find(id)',
      '```',
      'This THIS iPhone? Thanks.',
    ].join('\n');
    expect(texts(body)).toEqual(['iPhone']);
  });

  it('stops at eight terms', () => {
    expect(codeTerms(Array.from({ length: 12 }, (_, i) => `FooBar${i}`).join(' '))).toHaveLength(8);
  });
});

const sym = (over: Partial<SymbolHit>): SymbolHit => ({ name: 'x', qualified: 'x', kind: 'function', file: 'a.kt', startLine: 1, endLine: 2, exported: true, ...over });
const results = (hits: SymbolHit[]): SymbolResults => Object.assign(hits, { truncated: false });

function index(symbols: SymbolHit[], files: string[] = []) {
  return {
    symbols: async (q: string) => results(symbols.filter((s) => s.name.toLowerCase().includes(q.split('.').pop()!.toLowerCase()))),
    files: async (q: string): Promise<FileHit[]> => files.filter((f) => f.includes(q)).map((path) => ({ path, score: 1, changed: false })),
  };
}

describe('resolveCodeRefs', () => {
  const repo = index(
    [
      sym({ name: 'PaymentsUtils', qualified: 'PaymentsUtils', kind: 'class', file: 'src/payments/PaymentsUtils.kt', startLine: 12, endLine: 400 }),
      sym({ name: 'PaymentsUtilsTest', qualified: 'PaymentsUtilsTest', kind: 'class', file: 'test/PaymentsUtilsTest.kt', startLine: 3, endLine: 90 }),
      sym({ name: 'findBorrowers', qualified: 'PaymentsUtils.findBorrowers', owner: 'PaymentsUtils', kind: 'method', file: 'src/payments/PaymentsUtils.kt', startLine: 50, endLine: 90 }),
      sym({ name: 'findBorrowers', qualified: 'Other.findBorrowers', owner: 'Other', kind: 'method', file: 'src/Other.kt', startLine: 5, endLine: 8 }),
      sym({ name: 'getFundsSettledDate', qualified: 'getFundsSettledDate', file: 'src/payments/PaymentsService.kt', startLine: 4240, endLine: 4250 }),
    ],
    ['src/facilities/FacilitiesService.kt', 'src/facilities/FacilitiesServiceTest.kt'],
  );

  it('links each name to its exact definition at the PR head, labelled with the word', async () => {
    const refs = await resolveCodeRefs(repo, codeTerms('Move these to PaymentsUtils, next to PaymentsUtils.findBorrowers, as FacilitiesService.kt does.'), 'head123');
    expect(refs).toEqual([
      { url: 'ref:FacilitiesService.kt@src/facilities/FacilitiesService.kt', ref: 'head123', path: 'src/facilities/FacilitiesService.kt', label: 'FacilitiesService.kt' },
      {
        url: 'ref:PaymentsUtils.findBorrowers@src/payments/PaymentsUtils.kt#L50',
        ref: 'head123',
        path: 'src/payments/PaymentsUtils.kt',
        label: 'PaymentsUtils.findBorrowers',
        startLine: 50,
        endLine: 64,
      },
      { url: 'ref:PaymentsUtils@src/payments/PaymentsUtils.kt#L12', ref: 'head123', path: 'src/payments/PaymentsUtils.kt', label: 'PaymentsUtils', startLine: 12 },
    ]);
  });

  it('drops names with no exact match, and ones on the thread’s own lines', async () => {
    expect(await resolveCodeRefs(repo, codeTerms('What about PaymentsUtil or `findBorrower`?'), 'h')).toEqual([]);
    const here = { path: 'src/payments/PaymentsService.kt', line: 4245 };
    expect(await resolveCodeRefs(repo, codeTerms('Why not getFundsSettledDate?'), 'h', { here })).toEqual([]);
    expect(await resolveCodeRefs(repo, codeTerms('Why not getFundsSettledDate?'), 'h', { here: { ...here, line: 100 } })).toHaveLength(1);
  });
});
