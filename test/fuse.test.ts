import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/diff/parse.js';
import { FUSE_GAP, parseTourDiff } from '../src/diff/fuse.js';
import { markMovedLines, unmovedFiles } from '../src/diff/moves.js';
import { buildReviewPayload } from '../src/review/submit.js';
import type { Draft, Hunk } from '../src/types.js';
import { hunkKeys, stateOf } from '../src/review/hunkState.js';
import { computeReReview } from '../src/review/rereview.js';
import { applyMoves } from '../src/tui/nav.js';
import { filesFor, hunkFromDiff, tour } from './fixtures/tour.js';

// A block moved up the file next to an unrelated edit, as GitHub diffs it: the add and the edit
// in one hunk, the remove in another.
const HEAD = [
  'line1();',
  'line2();',
  'line3();',
  '<Section entries={deducted}',
  '  title={DEDUCTED}',
  '  total={minusTotal} />',
  'line4();',
  'line5(changed);',
  ...Array.from({ length: 22 }, (_, i) => `line${i + 6}();`).filter((l) => !['line14();', 'line15();', 'line16();'].includes(l)),
].join('\n');

const MOVE_DIFF = `diff --git a/src/fees.tsx b/src/fees.tsx
index e0290c2..a989242 100644
--- a/src/fees.tsx
+++ b/src/fees.tsx
@@ -1,8 +1,11 @@
 line1();
 line2();
 line3();
+<Section entries={deducted}
+  title={DEDUCTED}
+  total={minusTotal} />
 line4();
-line5();
+line5(changed);
 line6();
 line7();
 line8();
@@ -11,9 +14,6 @@ line10();
 line11();
 line12();
 line13();
-<Section entries={deducted}
-  title={DEDUCTED}
-  total={minusTotal} />
 line17();
 line18();
 line19();
`;

const readHead = (path: string) => (path === 'src/fees.tsx' ? HEAD + '\n' : undefined);

describe('fusing nearby hunks', () => {
  it('shows a short move and the edit beside it as one hunk, with the gap read from the head', () => {
    expect(parseUnifiedDiff(MOVE_DIFF).hunks).toHaveLength(2);
    const { files, hunks } = parseTourDiff(MOVE_DIFF, readHead);
    expect(hunks).toHaveLength(1);
    const [h] = hunks;
    expect(files[0].hunkIds).toEqual([h.id]);
    expect(h.header).toBe('@@ -1,19 +1,19 @@');
    const gap = h.lines.filter((l) => l.expanded);
    expect(gap.map((l) => [l.oldLine, l.newLine, l.text])).toEqual([
      [9, 12, 'line9();'],
      [10, 13, 'line10();'],
    ]);
    expect(h.lines.filter((l) => l.kind === 'add')).toHaveLength(4);
    expect(h.lines.filter((l) => l.kind === 'del')).toHaveLength(4);
  });

  it('fuses against a checkout with CRLF line endings, keeping the diff’s LF text', () => {
    const { hunks } = parseTourDiff(MOVE_DIFF, () => HEAD.replace(/\n/g, '\r\n') + '\r\n');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.filter((l) => l.expanded).map((l) => l.text)).toEqual(['line9();', 'line10();']);
  });

  it('keeps hunks apart when they are far apart, or the head cannot be read or has changed', () => {
    const far = MOVE_DIFF.replace('@@ -11,9 +14,6 @@', `@@ -${11 + FUSE_GAP},9 +${14 + FUSE_GAP},6 @@`);
    expect(parseTourDiff(far, () => undefined).hunks).toHaveLength(2);
    expect(parseTourDiff(MOVE_DIFF, () => undefined).hunks).toHaveLength(2);
    expect(parseTourDiff(MOVE_DIFF, () => HEAD.replace('line7();', 'edited();')).hunks).toHaveLength(2);
  });
});

describe('marking moved lines', () => {
  const noHead = () => undefined;
  const NONE = new Set<string>();
  const anyMoved = (hunks: Hunk[]) => hunks.flatMap((h) => h.lines).some((l) => l.moved);
  // Six lines: enough to move between files without being whole declarations.
  const CATCH = ['} catch (err) {', '  logger.error(err);', "  metrics.increment('failed');", '  await alertOps(err);', '  await rollback();', '  throw err;'];
  // A unified diff of whole files, each [path, hunk text].
  const gitDiff = (...files: [string, string][]) => files.map(([p, body]) => `diff --git a/${p} b/${p}\nindex 1111111..2222222 100644\n--- a/${p}\n+++ b/${p}\n${body}`).join('');
  const block = (prefix: string, indent: string, lines: string[]) => lines.map((l) => `${prefix}${indent}${l}\n`).join('');
  const STEPS = ['charge(order.card, order.total);', 'sendReceipt(order.customer);', 'markPaid(order.id);'];
  const LONG = [...STEPS, "notify(order.customer, 'paid');", "audit.log('order', order.id);", 'return order;'];

  it('links each side of a moved block to the other', () => {
    const { hunks } = parseUnifiedDiff(MOVE_DIFF);
    markMovedLines(hunks, readHead, NONE);
    const added = hunks[0].lines.filter((l) => l.moved);
    const removed = hunks[1].lines.filter((l) => l.moved);
    expect(added.map((l) => l.moved)).toEqual([14, 15, 16].map((line) => ({ file: 'src/fees.tsx', line, kind: 'moved', indent: 0, also: [] })));
    expect(removed.map((l) => l.moved)).toEqual([4, 5, 6].map((line) => ({ file: 'src/fees.tsx', line, kind: 'moved', indent: 0, also: [] })));
    // The one-line edit is not part of it.
    expect(hunks[0].lines.find((l) => l.text === 'line5(changed);')?.moved).toBeUndefined();
  });

  it('stays fast when a PR repeats short lines on both sides', () => {
    const N = 10_000;
    const side = (sign: string, tag: string) => Array.from({ length: N }, (_, i) => (i % 20 ? `${sign}}` : `${sign}${tag}${i}();`));
    const del = hunkFromDiff('src/a.c', ...side('-', 'a'));
    const add = hunkFromDiff('src/b.c', ...side('+', 'b'));
    const started = performance.now();
    markMovedLines([del, add], noHead, NONE);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('stays fast when thousands of blocks move between files that are in the checkout', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => [`a${i} = compute(${i});`, `b${i} = compute(${i} + 1);`, `c${i} = compute(${i} + 2);`]).flat();
    const del = hunkFromDiff('src/a.ts', ...lines.map((l) => `-${l}`));
    const add = hunkFromDiff('src/b.ts', ...lines.map((l) => `+${l}`));
    const started = performance.now();
    markMovedLines([del, add], (p) => (p === 'src/b.ts' ? lines.join('\n') + '\n' : ''), NONE);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(add.lines.every((l) => l.moved?.kind === 'moved')).toBe(true);
  });

  it('stays fast when a long chain of pieces with no anchor leads back to one certain move', () => {
    // Each piece is removed and added twice, so none has an anchor; each sits a line from the next.
    const N = 1500;
    const piece = (i: number) => [`if (h${i} === undefined) {`, `  return error${i};`, '}'];
    const chain = (sign: string) => [...Array.from({ length: N }, (_, i) => [...piece(i).map((l) => `${sign}${l}`), ` keep${i}();`]).flat(), ...LONG.map((l) => `${sign}${l}`)];
    const hunks = [hunkFromDiff('src/a.ts', ...chain('-')), hunkFromDiff('src/b.ts', ...chain('+'))];
    const copies = (file: string, sign: string) => hunkFromDiff(file, ...Array.from({ length: N }, (_, i) => [...piece(i).map((l) => `${sign}${l}`), ` other${i}();`]).flat());
    const started = performance.now();
    markMovedLines([...hunks, copies('src/c.ts', '-'), copies('src/d.ts', '+')], noHead, NONE);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(hunks[1].lines.filter((l) => l.kind === 'add').every((l) => l.moved?.file === 'src/a.ts')).toBe(true);
  });

  it('leaves out files classified as generated or vendored, and moves into or out of them', () => {
    // Each pair moves its own lines, so no two pairs can match each other.
    const pair = (from: string, to: string, tag: string) => [hunkFromDiff(from, ...LONG.map((l) => `-${tag}.${l}`)), hunkFromDiff(to, ...LONG.map((l) => `+${tag}.${l}`))];
    const within = pair('yarn.lock', 'yarn.lock', 'lock');
    const across = pair('src/rewrite.go', 'src/handlers.go', 'rules');
    const vendored = pair('src/app.go', 'third_party/lib.go', 'lib');
    const hunks = [...within, ...across, ...vendored];
    markMovedLines(hunks, noHead, unmovedFiles(filesFor(hunks, { 'yarn.lock': 'generated', 'src/rewrite.go': 'generated', 'third_party/lib.go': 'vendored' })));
    expect(anyMoved(hunks)).toBe(false);
    // The same moves in hand-written files.
    markMovedLines(across, noHead, unmovedFiles(filesFor(across)));
    expect(across.every((h) => h.lines.every((l) => l.moved))).toBe(true);
  });

  it('points a block moved out of a renamed file at its old path', () => {
    const fn = ['export function total(items) {', '  const sum = (n, item) => n + item.price;', '  return items.reduce(sum, 0);', '}'];
    const from = hunkFromDiff('src/new-name.ts', ...fn.map((l) => `-${l}`));
    from.oldFile = 'src/old-name.ts';
    const to = hunkFromDiff('src/other.ts', ...fn.map((l) => `+${l}`));
    markMovedLines([from, to], noHead, NONE);
    expect(to.lines[0].moved).toMatchObject({ file: 'src/old-name.ts', line: 1, kind: 'moved' });
    expect(from.lines[0].moved).toMatchObject({ file: 'src/other.ts', line: 1, kind: 'moved' });
  });

  it('does not call a reindent, or a few short lines, a move', () => {
    const reindent = hunkFromDiff('src/a.ts', '-if (a) {', '-  go(everything);', '-}', '+  if (a) {', '+    go(everything);', '+  }');
    const short = [hunkFromDiff('src/b.ts', '-}', '-}', '-}'), hunkFromDiff('src/c.ts', '+}', '+}', '+}')];
    markMovedLines([reindent, ...short], noHead, NONE);
    expect(anyMoved([reindent, ...short])).toBe(false);
  });

  it('does not call boilerplate a move when the file it left still has it, or the file it reached already had it', () => {
    // Error handling removed from one function of payments.ts, which keeps the same handler in another.
    const removed = [hunkFromDiff('src/payments.ts', ...CATCH.map((l) => `-${l}`)), hunkFromDiff('src/users.ts', '+  await save(user);', ...CATCH.map((l) => `+${l}`))];
    markMovedLines(removed, (p) => (p === 'src/payments.ts' ? ['try {', '  refund();', ...CATCH, '}'].join('\n') : undefined), NONE);
    expect(anyMoved(removed)).toBe(false);
    // Error handling added to users.ts next to the same handler it already had.
    const usersHead = ['  await save(user);', ...CATCH, '}', 'try {', '  load();', ...CATCH, '}'];
    const added = [
      hunkFromDiff('src/payments.ts', ...CATCH.map((l) => `-${l}`)),
      hunkFromDiff('src/users.ts', '+  await save(user);', ...CATCH.map((l) => `+${l}`), ' }', ' try {', '   load();', ...CATCH.map((l) => ` ${l}`), ' }'),
    ];
    markMovedLines(added, (p) => (p === 'src/users.ts' ? usersHead.join('\n') + '\n' : ''), NONE);
    expect(anyMoved(added)).toBe(false);
    // With the only copy gone from payments.ts and new to users.ts, it reads as a move.
    const moved = [hunkFromDiff('src/payments.ts', ...CATCH.map((l) => `-${l}`)), hunkFromDiff('src/users.ts', '+  await save(user);', ...CATCH.map((l) => `+${l}`))];
    markMovedLines(moved, noHead, NONE);
    expect(moved[0].lines.every((l) => l.moved?.kind === 'moved')).toBe(true);
  });

  it('does not call boilerplate a move between a deleted file and a new one when another changed file keeps it', () => {
    const RETURN = ['if err != nil {', '\tlog.Printf("query for open loans failed: %v", err)', '\tmetrics.Inc("loan_query_errors")', '\tspan.End()', '\treturn nil, err', '}'];
    // loans.go deleted and loanids.go new, so neither end has a head and a base to check.
    const deleted = hunkFromDiff('loans.go', '-loans, err := LoadLoansCSV(path)', ...RETURN.map((l) => `-${l}`));
    const added = hunkFromDiff('loanids.go', '+bq, err := bigquery.NewClient(ctx)', ...RETURN.map((l) => `+${l}`));
    // borrowers.go, changed elsewhere, has the same lines unchanged.
    const borrowersHead = ['rows, err := query(ctx)', ...RETURN, 'return rows, nil'];
    const kept = hunkFromDiff('borrowers.go', '-old()', ...borrowersHead.map((l) => ` ${l}`));
    const read = (p: string) => (p === 'borrowers.go' ? borrowersHead.join('\n') + '\n' : undefined);
    markMovedLines([deleted, added, kept], read, NONE);
    expect(anyMoved([deleted, added])).toBe(false);
    // Without that file, nothing says the lines are common: they read as moved.
    markMovedLines([deleted, added], read, NONE);
    expect(added.lines.filter((l) => l.moved).map((l) => l.moved!.kind)).toEqual(Array(6).fill('moved'));
  });

  it('calls a block removed from several places and added in one a merge, marking each place', () => {
    const hunks = [
      hunkFromDiff('src/ratios.ts', ...LONG.map((l) => `-${l}`)),
      hunkFromDiff('src/insurance.ts', ...LONG.map((l) => `-${l}`)),
      hunkFromDiff('src/shared.ts', ...LONG.map((l) => `+${l}`)),
    ];
    markMovedLines(hunks, noHead, NONE);
    expect(hunks[2].lines[0].moved).toEqual({ file: 'src/ratios.ts', line: 1, kind: 'merged', indent: 0, also: [{ file: 'src/insurance.ts', line: 1, side: 'del' }] });
    // Each file it left says where it went, naming the other.
    expect(hunks[1].lines[0].moved).toEqual({ file: 'src/shared.ts', line: 1, kind: 'merged', indent: 0, also: [{ file: 'src/ratios.ts', line: 1, side: 'del' }] });
    expect(hunks[1].lines.every((l) => l.moved)).toBe(true);
  });

  it('moves a few statements within a file, but between files only whole declarations or a longer run', () => {
    const del = (file: string, lines: string[]) => hunkFromDiff(file, ...lines.map((l) => `-${l}`));
    const add = (file: string, lines: string[]) => hunkFromDiff(file, ' keep();', ...lines.map((l) => `+${l}`));
    // Three statements: a move within a file, chance between two.
    const within = [del('src/a.ts', STEPS), add('src/a.ts', STEPS)];
    const across = [del('src/b.ts', STEPS), add('src/c.ts', STEPS)];
    markMovedLines([...within, ...across], noHead, NONE);
    expect(anyMoved(within)).toBe(true);
    // Nor does a move within a file make the same few lines elsewhere part of it.
    expect(anyMoved(across)).toBe(false);
    expect(within[0].lines[0].moved?.also).toEqual([]);
    // A short class, or a function with control flow inside, moves between files whole.
    const cls = ['export class UnknownBookError extends Error {', '  constructor(readonly isbn: string) {', '    super(`Unknown book ${isbn}`);', '  }', '}'];
    const fn = ['func isEmpty(rows []Row) bool {', '\tif len(rows) == 0 {', '\t\treturn true', '\t}', '\treturn false', '}'];
    for (const decl of [cls, fn]) {
      const pair = [del('src/d.ts', decl), add('src/e.ts', decl)];
      markMovedLines(pair, noHead, NONE);
      expect(pair[1].lines.filter((l) => l.moved)).toHaveLength(decl.length);
    }
    // Control flow is not a declaration, nor is a declaration cut short, nor one of three lines.
    const tiny = ['export interface Props {', '  children: ReactNode;', '}'];
    for (const partial of [['if (rows.length === 0) {', '  return true;', '}'], cls.slice(0, 4), tiny]) {
      const pair = [del('src/f.ts', partial), add('src/g.ts', partial)];
      markMovedLines(pair, noHead, NONE);
      expect(anyMoved(pair)).toBe(false);
    }
    // Two short blocks split by a small edit count together.
    const first = ['file, err := os.Open(path)', 'if err != nil {', '\treturn nil, fmt.Errorf("open loans csv %s: %w", path, err)'];
    const second = ['if len(rows) == 0 {', '\treturn nil, fmt.Errorf("loans csv %s is empty", path)', '}'];
    const split = [
      hunkFromDiff('loans.go', ...first.map((l) => `-${l}`), '-rows, err := csv.NewReader(file).ReadAll()', ...second.map((l) => `-${l}`)),
      hunkFromDiff('loanids.go', ...first.map((l) => `+${l}`), '+rows, err := reader.ReadAll()', ...second.map((l) => `+${l}`)),
    ];
    markMovedLines(split, noHead, NONE);
    expect(split[1].lines.filter((l) => l.moved)).toHaveLength(6);
  });

  it('lets smaller moves between two files through once a larger one between them is certain', () => {
    // Ten kept lines apart from the large move, so it does not count with it, and too small alone.
    const kept = Array.from({ length: 10 }, (_, i) => ` keep${i}();`);
    const moving = (file: string, sign: string, ...groups: string[][]) => hunkFromDiff(file, ...groups.flatMap((g, i) => [...(i ? kept : []), ...g.map((l) => `${sign}${l}`)]));
    const helper = ['private float floatValue() {', '  return strict ? FLOAT_STRICT : FLOAT;', '}'];
    const alone = [moving('src/Gson.java', '-', helper), moving('src/GsonBuilder.java', '+', helper)];
    markMovedLines(alone, noHead, NONE);
    expect(anyMoved(alone)).toBe(false);
    const together = [moving('src/Gson.java', '-', LONG, helper), moving('src/GsonBuilder.java', '+', LONG, helper)];
    markMovedLines(together, noHead, NONE);
    expect(together[1].lines.filter((l) => l.moved)).toHaveLength(LONG.length + helper.length);
  });

  it('lets a piece with no anchor through only right beside a certain move between the same files', () => {
    // The tail is removed and added in two places each, so no line of it is rare.
    const tail = ['if (handler === undefined) {', '  return error;', '}'];
    const head = (file: string, sign: string) => hunkFromDiff(file, ...LONG.map((l) => `${sign}${l}`), ' changed(line);', ...tail.map((l) => `${sign}${l}`));
    const elsewhere = [hunkFromDiff('src/c.ts', ...tail.map((l) => `-${l}`)), hunkFromDiff('src/d.ts', ' other();', ...tail.map((l) => `+${l}`))];
    const hunks = [head('src/a.ts', '-'), head('src/b.ts', '+'), ...elsewhere];
    markMovedLines(hunks, noHead, NONE);
    expect(hunks[1].lines.filter((l) => l.moved)).toHaveLength(LONG.length + tail.length);
    expect(anyMoved(elsewhere)).toBe(false);
  });

  it('does not call imports or a license header that follow a file elsewhere a move, but keeps comments moved with code', () => {
    const pair = (from: string, to: string, lines: string[], at = 0) => {
      const before = Array.from({ length: at }, (_, i) => ` line${i}();`);
      return [hunkFromDiff(from, ...before, ...lines.map((l) => `-${l}`)), hunkFromDiff(to, ...before, ...lines.map((l) => `+${l}`))];
    };
    const imports = pair('src/flask/sansio/app.py', 'src/flask/app.py', [
      'from .sessions import SecureCookieSessionInterface',
      'from .sessions import SessionInterface',
      'from .signals import request_started',
      'from .signals import request_finished',
      'from .signals import got_request_exception',
      'from .signals import appcontext_tearing_down',
    ]);
    const license = pair('OSGiTest.java', 'OSGiManifestIT.java', [
      '/*',
      ' * Copyright (C) 2023 Google Inc.',
      ' *',
      ' * Licensed under the Apache License, Version 2.0 (the "License");',
      ' * you may not use this file except in compliance with the License.',
      ' * You may obtain a copy of the License at',
      ' */',
    ]);
    markMovedLines([...imports, ...license], noHead, NONE);
    expect(anyMoved([...imports, ...license])).toBe(false);
    // The same comment lines in the middle of a file went with their code; so did a Markdown section.
    const comment = pair(
      'src/completions.go',
      'src/complete.go',
      [
        '// Let the logic continue so as to add any ValidArgsFunction completions,',
        '// even if we already found sub-commands, for commands that have subcommands',
        '// but also specify a ValidArgsFunction of their own, which is allowed.',
        '// See the documentation of ValidArgsFunction for how the two combine',
        '// when both are set, and what the shell is told to do with each.',
        '// Flags are completed separately, further down.',
      ],
      40,
    );
    const section = pair('bash_completions.md', 'shell_completions.md', [
      '# Debugging',
      '',
      '# Cobra provides a hidden command for completions.',
      '# Run it to see what the shell will be offered,',
      '# for example with helm and a partial status argument,',
      '# and read the directive printed at the end,',
      '# which says how the shell should treat the results.',
    ]);
    markMovedLines([...comment, ...section], noHead, NONE);
    expect(comment[1].lines.filter((l) => l.moved)).toHaveLength(6);
    expect(section[1].lines.filter((l) => l.moved)).toHaveLength(7);
  });

  it('gives no note to one statement and its brackets, but counts it toward the move it ends', () => {
    // Four lines, too few to move between files alone; with the tail split off by a changed line, six.
    const head = ['public void testSetDateFormatWithValidPattern() {', '  GsonBuilder builder = new GsonBuilder();', '  String validPattern = "yyyy-MM-dd";', '  Gson gson = builder.create();'];
    const tail = ['  builder.setDateFormat(validPattern);', '}', '}'];
    const side = (file: string, sign: string, edit: string) => hunkFromDiff(file, ...head.map((l) => `${sign}${l}`), `${sign}${edit}`, ...tail.map((l) => `${sign}${l}`));
    const hunks = [side('DefaultTypeAdaptersTest.java', '-', '  assertThat(gson).isNotNull();'), side('GsonBuilderTest.java', '+', '  assertThat(gson.toJson(null)).isEqualTo("null");')];
    markMovedLines(hunks, noHead, NONE);
    expect(hunks[1].lines.filter((l) => l.moved).map((l) => l.text)).toEqual(head);
    // Within a file the tail alone, one statement and brackets, is no move either.
    const alone = hunkFromDiff('src/command.go', ...tail.map((l) => `-${l}`), ' keep();', ...tail.map((l) => `+${l}`));
    markMovedLines([alone], noHead, NONE);
    expect(anyMoved([alone])).toBe(false);
  });

  it('does not call code put in a block comment a move', () => {
    const body = ['project := NewProjectFromPath(wd)', 'initializeProject(project)', 'fmt.Println("Your Cobra application is ready at")'];
    const diffOf = (open: string, close: string) =>
      `@@ -1,5 +1,7 @@\n run := func() {\n${body.map((l) => `-\t${l}`).join('\n')}\n }\n+${open}\n${body.map((l) => `+\t\t${l}`).join('\n')}\n+${close}\n keep()\n`;
    const headOf = (open: string, close: string) => () => ['run := func() {', '}', open, ...body.map((l) => `\t\t${l}`), close, 'keep()'].join('\n') + '\n';
    const marked = (open: string, close: string, file: string) => {
      const { hunks } = parseUnifiedDiff(gitDiff([file, diffOf(open, close)]));
      markMovedLines(hunks, headOf(open, close), NONE);
      return anyMoved(hunks);
    };
    expect(marked('/*', '*/', 'cmd/init.go')).toBe(false);
    // The same lines wrapped in a block that runs them still moved, and `/*` in a glob is no comment.
    expect(marked('if verbose {', '}', 'cmd/init.go')).toBe(true);
    expect(marked('files := glob("src/**/*.go"); if len(files) > 0 {', '}', 'cmd/init.go')).toBe(true);
  });

  it('calls a block re-indented in place when a block near it shifted the same way stayed', () => {
    const B = ['charge(order.card, order.total);', 'sendReceipt(order.customer);', 'markPaid(order.id);'];
    const A = ["notify(order.customer, 'paid');", "audit.log('order', order.id);", 'archive(order);'];
    // The diff kept `keep();` between B's halves, though B, like A below it, only moved in two columns.
    const bOnly = ['@@ -1,4 +1,4 @@', ...B.map((l) => `-  ${l}`), ' keep();', ...B.map((l) => `+    ${l}`)];
    const both = ['@@ -1,9 +1,9 @@', ...bOnly.slice(1), ' other();', ...A.map((l) => `-  ${l}`), ' ', ...A.map((l) => `+    ${l}`)];
    const head = ['keep();', ...B.map((l) => `    ${l}`), 'other();', '', ...A.map((l) => `    ${l}`)].join('\n') + '\n';
    const kinds = (body: string[]) => {
      const { hunks } = parseUnifiedDiff(gitDiff(['src/orders.ts', body.join('\n') + '\n']));
      markMovedLines(hunks, () => head, NONE);
      return hunks[0].lines.filter((l) => l.moved && B.includes(l.text.trim())).map((l) => l.moved!.kind);
    };
    expect(kinds(bOnly)).toEqual(Array(6).fill('moved'));
    expect(kinds(both)).toEqual(Array(6).fill('reindented'));
  });

  it('needs each moved block to hold a line removed or added just once', () => {
    // A rewrite that keeps a common fragment in two of its runs: no line in it is rare.
    const fragment = ['} catch (err) {', '  logger.error(err);', '}'];
    const rewrite = hunkFromDiff(
      'src/a.ts',
      ...fragment.map((l) => `-${l}`),
      ' keep();',
      ...fragment.map((l) => `-${l}`),
      ' keep();',
      ...fragment.map((l) => `+${l}`),
      ' keep();',
      ...fragment.map((l) => `+${l}`),
    );
    markMovedLines([rewrite], noHead, NONE);
    expect(anyMoved([rewrite])).toBe(false);
    // The same fragment once on each side moves.
    const once = hunkFromDiff('src/a.ts', ...fragment.map((l) => `-${l}`), ' keep();', ...fragment.map((l) => `+${l}`));
    markMovedLines([once], noHead, NONE);
    expect(once.lines.filter((l) => l.moved)).toHaveLength(6);
    // Lines removed from two places and added in one still anchor, on the side they are added.
    const merged = [hunkFromDiff('src/b.ts', ...LONG.map((l) => `-${l}`)), hunkFromDiff('src/c.ts', ...LONG.map((l) => `-${l}`)), hunkFromDiff('src/d.ts', ...LONG.map((l) => `+${l}`))];
    markMovedLines(merged, noHead, NONE);
    expect(merged[2].lines.every((l) => l.moved?.kind === 'merged')).toBe(true);
  });

  it('records how far a moved block shifted its indent, and stops where its own nesting changes', () => {
    const shifted = [hunkFromDiff('app/orders.py', ...LONG.map((l) => `-        ${l}`)), hunkFromDiff('app/billing.py', ...LONG.map((l) => `+    ${l}`))];
    markMovedLines(shifted, noHead, NONE);
    expect(shifted[1].lines.map((l) => l.moved?.indent)).toEqual(Array(6).fill(-4));
    // The last line left the block it was nested in: the rest is too short to be a move.
    const nested = [hunkFromDiff('app/orders.py', ...LONG.map((l) => `-    ${l}`)), hunkFromDiff('app/billing.py', ...LONG.slice(0, -1).map((l) => `+    ${l}`), `+${LONG.at(-1)}`)];
    markMovedLines(nested, noHead, NONE);
    expect(anyMoved(nested)).toBe(false);
  });

  it('calls a block that passed only blank kept lines re-indented in place, or not moved at all', () => {
    // The steps are wrapped one level deeper, with a blank line kept above them.
    const diffOf = (indent: string) => gitDiff(['test/page.spec.ts', `@@ -1,5 +1,5 @@\n${block('-', '  ', STEPS)} \n${block('+', indent, STEPS)} })\n`]);
    const headOf = (indent: string) => () => ['', ...STEPS.map((l) => indent + l), '})'].join('\n') + '\n';
    const wrapped = parseUnifiedDiff(diffOf('    ')).hunks;
    markMovedLines(wrapped, headOf('    '), NONE);
    expect(wrapped[0].lines.filter((l) => l.moved).map((l) => [l.moved!.kind, l.moved!.indent])).toEqual(Array(6).fill(['reindented', 2]));
    // At the same indent, only the diff's alignment changed: nothing moved.
    const aligned = parseUnifiedDiff(diffOf('  ')).hunks;
    markMovedLines(aligned, headOf('  '), NONE);
    expect(anyMoved(aligned)).toBe(false);
    // Past a kept statement the steps run in another order: a move.
    const reordered = parseUnifiedDiff(gitDiff(['test/page.spec.ts', `@@ -1,6 +1,6 @@\n${block('-', '  ', STEPS)}   await page.reload();\n${block('+', '    ', STEPS)} })\n`])).hunks;
    markMovedLines(reordered, noHead, NONE);
    expect(reordered[0].lines.filter((l) => l.moved).map((l) => [l.moved!.kind, l.moved!.indent])).toEqual(Array(6).fill(['moved', 2]));
  });

  it('pairs text edited alike in two files within each file', () => {
    const between = block(' ', '  ', ['first();', 'second();', 'third();', 'fourth();', 'fifth();']);
    const edit = `@@ -1,8 +1,8 @@\n${block('-', '  ', STEPS)}${between}${block('+', '  ', STEPS)}`;
    const { hunks } = parseUnifiedDiff(gitDiff(['src/a.ts', edit], ['src/b.ts', edit]));
    markMovedLines(hunks, noHead, NONE);
    for (const h of hunks) expect(h.lines.filter((l) => l.moved).map((l) => [l.moved!.file, l.moved!.kind])).toEqual(Array(6).fill([h.file, 'moved']));
  });

  it('calls a block added in two places a copy, marking each place and naming the others', () => {
    const hunks = [
      hunkFromDiff('src/scaffold.ts', ...LONG.map((l) => `-${l}`)),
      hunkFromDiff('src/app.ts', ...LONG.map((l) => `+${l}`)),
      hunkFromDiff('src/blueprints.ts', ...LONG.map((l) => `+${l}`)),
    ];
    markMovedLines(hunks, noHead, NONE);
    expect(hunks[0].lines[0].moved).toEqual({ file: 'src/app.ts', line: 1, kind: 'copied', indent: 0, also: [{ file: 'src/blueprints.ts', line: 1, side: 'add' }] });
    // The second copy says where it came from, naming the first.
    expect(hunks[2].lines[0].moved).toEqual({ file: 'src/scaffold.ts', line: 1, kind: 'copied', indent: 0, also: [{ file: 'src/app.ts', line: 1, side: 'add' }] });
    expect(hunks[2].lines.every((l) => l.moved)).toBe(true);
  });
});

describe('review comments on fused hunks', () => {
  const draft = (anchor: Draft['anchor']): Draft => ({ id: 'd', repo: 'o/r', pr: 1, headSha: 'head', anchor, label: 'nit', body: 'x', posted: false, createdAt: '' });

  it('never attaches to expanded context, and keeps a range only inside one of GitHub’s hunks', () => {
    const { hunks } = parseTourDiff(MOVE_DIFF, readHead);
    const t = tour(hunks, [{ hunkIds: [hunks[0].id] }]);
    const id = hunks[0].id;
    const onGap = buildReviewPayload(t, [draft({ type: 'line', hunkId: id, file: 'src/fees.tsx', line: 12, side: 'RIGHT' })], 'COMMENT', '');
    expect(onGap.payload.comments[0].line).not.toBe(12);
    expect(onGap.moved).toHaveLength(1);
    const across = buildReviewPayload(t, [draft({ type: 'range', hunkId: id, file: 'src/fees.tsx', startLine: 8, line: 15, side: 'RIGHT' })], 'COMMENT', '');
    expect(across.payload.comments[0]).toMatchObject({ line: 15 });
    expect(across.payload.comments[0].start_line).toBeUndefined();
    const within = buildReviewPayload(t, [draft({ type: 'range', hunkId: id, file: 'src/fees.tsx', startLine: 4, line: 8, side: 'RIGHT' })], 'COMMENT', '');
    expect(within.payload.comments[0]).toMatchObject({ start_line: 4, line: 8 });
  });

  it('says so when a range is cut to one line, and never posts its suggestion as one GitHub can apply', () => {
    const { hunks } = parseTourDiff(MOVE_DIFF, readHead);
    const t = tour(hunks, [{ hunkIds: [hunks[0].id] }]);
    const d = { ...draft({ type: 'range', hunkId: hunks[0].id, file: 'src/fees.tsx', startLine: 8, line: 15, side: 'RIGHT' }), suggestion: 'a\nb\nc' };
    const { payload, moved } = buildReviewPayload(t, [d], 'COMMENT', '');
    expect(payload.comments[0].start_line).toBeUndefined();
    expect(payload.comments[0].body).not.toContain('```suggestion');
    expect(payload.comments[0].body).toContain('```\na\nb\nc\n```');
    expect(payload.comments[0].body).toContain('Originally on lines 8-15');
    expect(moved).toEqual([expect.objectContaining({ draftId: 'd', note: expect.stringContaining('with the suggestion as plain code') })]);
    // A suggestion moved to the nearest line would replace the wrong code, too.
    const gone = buildReviewPayload(t, [{ ...draft({ type: 'line', hunkId: hunks[0].id, file: 'src/fees.tsx', line: 12, side: 'RIGHT' }), suggestion: 'x' }], 'COMMENT', '');
    expect(gone.payload.comments[0].body).not.toContain('```suggestion');
  });
});

describe('progress on fused hunks', () => {
  // The same two edits, 3 unchanged lines apart (fused), then 8 apart after the base gained
  // five lines between them (a rebase): two hunks.
  const lines = (n: number, edit: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `l${i + 1}`);
  const ctx = (from: number, to: number, name = (n: number) => `l${n}`) => Array.from({ length: to - from + 1 }, (_, i) => ` ${name(from + i)}`);
  const file = (hunks: string[][]) => `diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n${hunks.map((h) => h.join('\n')).join('\n')}\n`;
  const near = file([
    ['@@ -7,7 +7,7 @@', ...ctx(7, 9), '-l10', '+L10', ...ctx(11, 13)],
    ['@@ -17,7 +17,7 @@', ...ctx(17, 19), '-l20', '+L20', ...ctx(21, 23)],
  ]);
  const nearHead = lines(30, { 10: 'L10', 20: 'L20' }).join('\n') + '\n';
  // l1..l15, five new lines, l16..l30: l20 is now line 25.
  const farName = (n: number) => (n <= 15 ? `l${n}` : n <= 20 ? `x${n - 15}` : `l${n - 5}`);
  const far = file([
    ['@@ -7,7 +7,7 @@', ...ctx(7, 9), '-l10', '+L10', ...ctx(11, 13)],
    ['@@ -22,7 +22,7 @@', ...ctx(22, 24, farName), '-l20', '+L20', ...ctx(26, 28, farName)],
  ]);
  const farHead = Array.from({ length: 35 }, (_, i) => (i + 1 === 10 ? 'L10' : i + 1 === 25 ? 'L20' : farName(i + 1))).join('\n') + '\n';
  const fused = parseTourDiff(near, () => nearHead).hunks;
  const apart = parseTourDiff(far, () => farHead).hunks;

  it('keys a fused hunk by the GitHub hunks it joins', () => {
    expect(fused).toHaveLength(1);
    expect(apart).toHaveLength(2);
    expect(fused[0].parts).toEqual(apart.map((h) => h.contentHash));
  });

  it('keeps read state when the same changes fuse, or stop fusing, on another head', () => {
    const states = Object.fromEntries(hunkKeys(fused[0]).map((k) => [k, 'read' as const]));
    expect(apart.map((h) => stateOf(states, h))).toEqual(['read', 'read']);
    const one = { [apart[0].contentHash]: 'read' as const };
    expect(stateOf(one, fused[0])).toBe('unread');
    expect(stateOf({ ...one, [apart[1].contentHash]: 'skipped' }, fused[0])).toBe('skipped');
  });

  it('does not call a hunk new on re-review just because it fused differently', () => {
    const ctxNone = { postedDrafts: [], threads: [], diffPrevToNext: '' };
    expect(computeReReview(tour(fused), tour(apart), ctxNone).newHunkIds).toEqual([]);
    expect(computeReReview(tour(apart), tour(fused), ctxNone).newHunkIds).toEqual([]);
    expect(computeReReview(tour(apart.slice(0, 1)), tour(fused), ctxNone).newHunkIds).toEqual([fused[0].id]);
  });

  it('applies a move saved for one part to the fused hunk', () => {
    const t = tour(fused, [{ id: 'a', hunkIds: [fused[0].id] }, { id: 'b' }]);
    const moved = applyMoves(t.chapters, t, { [apart[1].contentHash]: 'b' });
    expect(moved.find((c) => c.id === 'b')?.hunkIds).toEqual([fused[0].id]);
  });
});
