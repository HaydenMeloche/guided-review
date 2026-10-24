import { describe, expect, it } from 'vitest';
import { buildChapters, fileOrderChapters, splitByDirectory, stateDiagram } from '../src/analysis/flows.js';
import { buildSymbolIndex } from '../src/analysis/symbols.js';
import { buildFixture, ctx, hunkOf } from './fixtures/invoiceFlow.js';
import type { Decl, SymbolIndex } from '../src/analysis/symbols.js';
import type { Chapter, DiffFile, DiffLine, Hunk } from '../src/types.js';

describe('buildChapters', () => {
  const { files, hunks } = buildFixture();
  const index = buildSymbolIndex(files, hunks, ctx);
  const { chapters, overview, notes, flags } = buildChapters(files, hunks, index);
  const h = (f: string) => hunkOf(hunks, f);

  it('orders the main flow by call order with types before first use', () => {
    const flow = chapters[0];
    expect(flow.kind).toBe('flow');
    expect(flow.title).toBe('POST /invoices → handleCreate');
    // The paired test's diff follows the code it tests.
    expect(flow.hunkIds).toEqual([h('src/routes/invoices.ts'), h('src/types.ts'), h('src/services/invoice.ts'), h('src/db/invoiceRepo.ts'), h('test/invoice.test.ts')]);
    expect(flow.risk).toBe(2);
    expect(flow.untestedBranches.some((b) => b.includes('if (total < 0)'))).toBe(true);
    expect(flow.diagram?.kind).toBe('call');
    expect(flow.diagram?.nodes.length).toBeGreaterThanOrEqual(4);
    expect(notes).toEqual([]);
    expect(flags).toEqual([]);
  });

  it('puts orphans in supporting changes with a reason', () => {
    const sup = chapters.find((c) => c.kind === 'supporting')!;
    expect(sup.hunkIds).toEqual([h('src/util/format.ts')]);
    expect(sup.orphanReasons[h('src/util/format.ts')]).toBe('constant change');
  });

  it('keeps a paired test with its flow, and a test of supporting code in a tests chapter', () => {
    const extra = buildFixture();
    // A test of format.ts, which only supporting changes touch.
    const id = 'h_fmt_test';
    extra.hunks[id] = { ...extra.hunks[h('test/invoice.test.ts')], id, file: 'test/format.test.ts', tests: [] };
    extra.files.push({ path: 'test/format.test.ts', status: 'modified', binary: false, kind: 'test', kindReason: 'test file', additions: 1, deletions: 0, hunkIds: [id] });
    const out = buildChapters(extra.files, extra.hunks, buildSymbolIndex(extra.files, extra.hunks, ctx));
    expect(out.chapters[0].hunkIds).toContain(hunkOf(extra.hunks, 'test/invoice.test.ts'));
    const tests = out.chapters.find((c) => c.kind === 'tests')!;
    expect(tests.title).toBe('Test changes');
    expect(tests.hunkIds).toEqual([id]);
  });

  it('pairs tests and sinks low-priority kinds in order', () => {
    expect(chapters.some((c) => c.kind === 'tests')).toBe(false);
    const kinds = chapters.map((c) => c.kind);
    expect(kinds).toEqual(['flow', 'supporting', 'dependencies', 'config']);
    expect(chapters.find((c) => c.kind === 'config')!.collapsed).toBe(false);
    // Only a lockfile changed: the dependencies chapter is its summary.
    const deps = chapters.find((c) => c.kind === 'dependencies')!;
    expect(deps.collapsed).toBe(true);
    expect(deps.folded).toEqual(deps.hunkIds);
    expect(chapters.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('builds an overview', () => {
    expect(overview.nodes.length).toBeGreaterThan(0);
  });

  it('links shared code from a second flow', () => {
    const { files: f2, hunks: h2 } = buildFixture();
    // A second route that also calls createInvoice.
    const cronFile = 'src/jobs/nightly.ts';
    const text = `import cron from 'node-cron';\nimport { createInvoice } from '../services/invoice.js';\ncron.schedule('0 0 * * *', nightly);\nfunction nightly() { return createInvoice({}); }\n`;
    h2.hx = {
      ...h2.h1,
      id: 'hx',
      file: cronFile,
      lines: text
        .replace(/\n$/, '')
        .split('\n')
        .map((t, i) => ({ kind: 'add' as const, text: t, newLine: i + 1 })),
      newLines: 4,
    };
    f2.push({ ...f2[0], path: cronFile, hunkIds: ['hx'] });
    const idx = buildSymbolIndex(f2, h2, { readHead: (p) => (p === cronFile ? text : ctx.readHead(p)), readBase: ctx.readBase });
    const res = buildChapters(f2, h2, idx);
    const cronCh = res.chapters.find((c) => c.entryPoint?.startsWith('cron job'))!;
    expect(cronCh.hunkIds).toEqual(['hx']);
    expect(cronCh.linkedHunkIds).toContain(hunkOf(h2, 'src/services/invoice.ts'));
  });

  it('falls back to file order when no entry point exists', () => {
    const { files: f3, hunks: h3 } = buildFixture();
    const idx = buildSymbolIndex(f3, h3, ctx);
    idx.entries = [];
    const res = buildChapters(f3, h3, idx);
    expect(res.flags[0].kind).toBe('no-entry-point');
    expect(res.notes[0]).toMatch(/No entry point/);
    expect(res.chapters[0].title).toMatch(/file order/);
  });
});

describe('buildChapters entry assignment', () => {
  // app -> svc -> db, svc -> util; lone is called by nothing. Sizes are changed lines.
  const sizes: Record<string, number> = { app: 50, svc: 200, util: 5, db: 200, lone: 5 };
  const calls: Record<string, string[]> = { app: ['svc'], svc: ['db', 'util'], util: [], db: [], lone: [] };
  const q = (n: string) => `src/${n}.ts#${n}`;
  const hunks: Record<string, Hunk> = Object.fromEntries(
    Object.entries(sizes).map(([n, size]) => [
      n,
      {
        id: n,
        file: `src/${n}.ts`,
        risk: 0,
        tests: [],
        newStart: 1,
        header: '',
        lines: Array.from({ length: size }, (_, i) => ({ kind: 'add', text: `  step${i}();`, newLine: i + 1 })),
      } as unknown as Hunk,
    ]),
  );
  const files: DiffFile[] = Object.keys(sizes).map((n) => ({
    path: `src/${n}.ts`,
    status: 'modified',
    binary: false,
    kind: 'logic',
    kindReason: 'hand-written code',
    additions: sizes[n],
    deletions: 0,
    hunkIds: [n],
  }));
  const decls: Decl[] = Object.keys(sizes).map((n) => ({
    name: n,
    qualified: q(n),
    file: `src/${n}.ts`,
    kind: 'function',
    startLine: 1,
    endLine: sizes[n],
    exported: true,
    calls: calls[n],
    side: 'head',
  }));
  const index: SymbolIndex = {
    decls,
    hunkDecls: Object.fromEntries(Object.keys(sizes).map((n) => [n, [q(n)]])),
    edges: Object.entries(calls).flatMap(([from, tos]) => tos.map((to) => ({ from: q(from), to: q(to), source: 'name-match' as const }))),
    entries: [{ hunkId: 'app', symbol: q('app'), reason: 'React component' }, ...['svc', 'db', 'util', 'lone'].map((n) => ({ hunkId: n, symbol: q(n), reason: 'exported API' }))],
    typeDecls: new Set(),
    lowConfidence: false,
  };
  const { chapters } = buildChapters(files, hunks, index);

  it('gives each hunk to the nearest entry, so a root that reaches everything does not swallow its sub-flows', () => {
    const flows = chapters.filter((c) => c.kind === 'flow');
    expect(flows.map((c) => c.hunkIds)).toEqual([['app'], ['svc', 'util'], ['db']]);
    expect(flows[0].linkedHunkIds).toEqual(['svc']);
  });

  it('puts code moved out of a file right after the hunk that deleted it', () => {
    const moved = Array.from({ length: 10 }, (_, i) => `  const value${i} = compute(input, ${i});`);
    const withMove: Record<string, Hunk> = {
      ...hunks,
      // svc deletes the lines that the new file extracted.ts adds.
      svc: { ...hunks.svc, lines: [...hunks.svc.lines, ...moved.map((text) => ({ kind: 'del' as const, text }))] },
      extracted: { ...hunks.lone, id: 'extracted', file: 'src/extracted.ts', lines: moved.map((text, i) => ({ kind: 'add' as const, text, newLine: i + 1 })) },
    };
    const moveFiles = [...files, { ...files[4], path: 'src/extracted.ts', hunkIds: ['extracted'] }];
    const out = buildChapters(moveFiles, withMove, index);
    expect(out.chapters.find((c) => c.hunkIds.includes('svc'))?.hunkIds).toEqual(['svc', 'extracted', 'util']);
  });

  it('sends a small change no changed code calls to supporting changes', () => {
    expect(chapters.find((c) => c.kind === 'supporting')?.hunkIds).toEqual(['lone']);
  });
});

describe('fileOrderChapters', () => {
  it('makes one chapter per file in path order', () => {
    const { files, hunks } = buildFixture();
    const ch = fileOrderChapters(files, hunks);
    expect(ch.map((c) => c.title)).toEqual([...files.map((f) => f.path)].sort());
    expect(ch.find((c) => c.title === 'pnpm-lock.yaml')!.collapsed).toBe(true);
  });
});

describe('splitByDirectory', () => {
  it("splits supporting changes by their first two path segments and keeps only each part's own details", () => {
    const hunk = (id: string, file: string, risk: Hunk['risk']) => ({ id, file, risk }) as Hunk;
    const hunks = { a: hunk('a', 'packages/foo/a.ts', 1), b: hunk('b', 'packages/bar/b.ts', 3), c: hunk('c', 'packages/foo/c.ts', 0) };
    const supporting: Chapter = {
      id: 'c2',
      kind: 'supporting',
      title: 'Supporting changes',
      risk: 3,
      hunkIds: ['a', 'b', 'c'],
      linkedHunkIds: ['c'],
      orphanReasons: { a: 'constant change', b: 'dead code removal' },
      untestedBranches: ['packages/foo/a.ts:3 if (x)', 'packages/bar/b.ts:9 else'],
      diagram: { kind: 'call', title: 'T', nodes: [], edges: [] },
      collapsed: false,
    };
    const [foo, bar] = splitByDirectory([supporting], hunks);
    expect(foo).toMatchObject({
      id: 'c2-1',
      title: 'Supporting changes: packages/foo',
      hunkIds: ['a', 'c'],
      risk: 1,
      orphanReasons: { a: 'constant change' },
      linkedHunkIds: ['c'],
      untestedBranches: ['packages/foo/a.ts:3 if (x)'],
    });
    expect(bar).toMatchObject({ id: 'c2-2', hunkIds: ['b'], risk: 3, linkedHunkIds: [], untestedBranches: ['packages/bar/b.ts:9 else'] });
    expect(foo.diagram).toBeUndefined();
  });
});

describe('stateDiagram', () => {
  const decl = (name: string, kind: Decl['kind'], startLine: number, endLine: number): Decl => ({
    name,
    qualified: `a.ts#${name}`,
    file: 'a.ts',
    kind,
    startLine,
    endLine,
    exported: false,
    calls: [],
    side: 'head',
  });
  const run = (lines: [DiffLine['kind'], string][], decls: Decl[]) => {
    let n = 1;
    const diff: DiffLine[] = lines.map(([kind, text]) => (kind === 'del' ? { kind, text } : { kind, text, newLine: n++ }));
    const hunks = { h: { id: 'h', lines: diff } as Hunk };
    const index = { hunkDecls: { h: decls.map((d) => d.qualified) } } as unknown as SymbolIndex;
    return stateDiagram('T', ['h'], hunks, index, new Map(decls.map((d) => [d.qualified, d])));
  };

  it('reads members of a literal union that gains one', () => {
    const g = run(
      [
        ['ctx', "import { x } from 'next-intl';"],
        ['ctx', 'type Status ='],
        ['ctx', "  | 'draft'"],
        ['add', "  | 'paid'"],
        ['ctx', "  | 'sent';"],
      ],
      [decl('Status', 'type', 2, 5)],
    )!;
    expect(g.nodes.map((n) => [n.label, n.changed])).toEqual([
      ['draft', false],
      ['paid', true],
      ['sent', false],
    ]);
  });

  it('ignores object types and lines outside the declaration', () => {
    const g = run(
      [
        ['ctx', "import { useTranslations } from 'next-intl';"],
        ['ctx', 'type OfferActionsProps = {'],
        ['ctx', '  offerId: string;'],
        ['del', '  agreementExists: boolean;'],
        ['add', '  latestAgreementId: string | null;'],
        ['ctx', '};'],
        ['ctx', '  facilityId,'],
        ['add', '  href={`/offers/${offerId}`}'],
      ],
      [decl('OfferActionsProps', 'type', 2, 5)],
    );
    expect(g).toBeUndefined();
  });
});
