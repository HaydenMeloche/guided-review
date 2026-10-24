import React, { useState } from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { CodeRef, Draft, Hunk, ReadState, Tour } from '../src/types.js';
import type { RepoIndex, SymbolResults } from '../src/analysis/repoIndex.js';
import { SuggestionError, type SuggestionResult, type SuggestOptions } from '../src/agent/suggest.js';
import { ChapterScreen } from '../src/tui/ChapterScreen.js';
import { SubmitScreen } from '../src/tui/SubmitScreen.js';
import { ThreadView } from '../src/tui/ThreadView.js';
import { CommentEditor } from '../src/tui/CommentEditor.js';
import type { ReferenceServices } from '../src/tui/composer.js';
import type { RecentLocation } from '../src/tui/references.js';
import { linesHash } from '../src/review/refs.js';
import type { States } from '../src/tui/nav.js';
import { diffLines, filesFor, hunk as makeHunk, tour as makeTour } from './fixtures/tour.js';
import { waitFor } from './helpers/waitFor.js';

vi.mock('../src/github/gh.js', async (orig) => ({ ...(await orig<typeof import('../src/github/gh.js')>()), postReview: vi.fn(async () => ({ id: 1, url: 'https://example.test/review/1' })) }));
// $EDITOR for Ctrl+G and the AI line's e: writes fixed code instead of opening an editor.
vi.mock('../src/util/editor.js', () => ({ openInEditor: (file: string) => fs.writeFileSync(file, 'qty += once(n);\n') }));

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const ESC = '\u001b';
const RIGHT = '\u001b[C';
const LEFT = '\u001b[D';
const DOWN = '\u001b[B';
const CTRL = { r: '\u0012', p: '\u0010', t: '\u0014', o: '\u000f', g: '\u0007', u: '\u0015' };
const HEAD = 'h'.repeat(40);

let root: string;
const CANCEL = ['export async function cancelOrder(id) {', '  const order = await get(id);', '  if (done) return;', '  release(items);', '  qty += n;', '}'];
const RETRIES = ['function retry(id) {', '  return cancelOrder(id);', '}'];
const TESTS = Array.from({ length: 130 }, (_, i) => (i === 119 ? "it('cancels an order once', () => {" : `// line ${i + 1}`));

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-builder-'));
  const write = (p: string, lines: string[]) => {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), lines.join('\n') + '\n');
  };
  write('src/orders/cancel.ts', CANCEL);
  write('src/jobs/retries.ts', RETRIES);
  write('test/orders.test.ts', TESTS);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(opts: { mode?: Tour['mode']; expanded?: boolean } = {}): Tour {
  const cancelLines = diffLines([' export async function cancelOrder(id) {', '   const order = await get(id);', '+  if (done) return;', '+  release(items);', '+  qty += n;', ' }'], 1);
  if (opts.expanded) cancelLines.push({ kind: 'ctx', text: '// below', newLine: 7, oldLine: 4, expanded: true });
  const a: Hunk = makeHunk('hA', 'src/orders/cancel.ts', cancelLines, {
    symbols: ['cancelOrder'],
    tests: [
      { testFile: 'test/orders.test.ts', testName: 'cancels an order once', startLine: 120, lines: ["it('cancels an order once', () => {", '  cancel();', '});'], source: 'coverage', confidence: 0.9 },
      { testFile: 'test/orders.test.ts', testName: 'orders.test.ts', startLine: 1, lines: ['// line 1'], source: 'naming', confidence: 0.3 },
    ],
  });
  const b: Hunk = makeHunk('hB', 'src/jobs/retries.ts', diffLines([' function retry(id) {', '+  return cancelOrder(id);', ' }'], 1));
  return makeTour([a, b], [{ hunkIds: ['hA', 'hB'] }], {
    repo: 'acme/shop',
    pr: 482,
    url: 'https://github.com/acme/shop/pull/482',
    headSha: HEAD,
    baseSha: 'b'.repeat(40),
    mode: opts.mode ?? 'plain',
    files: filesFor([a, b]),
    blastRadius: [{ symbol: 'cancelOrder', hunkId: 'hA', callers: [{ file: 'src/jobs/retries.ts', line: 2, text: 'return cancelOrder(id);' }] }],
    existingThreads: [{ id: 't1', path: 'src/orders/cancel.ts', line: 4, isResolved: false, isOutdated: false, comments: [{ id: '991', author: 'alice', body: 'Is this retried?', createdAt: '' }] }],
  });
}

// A RepoIndex stand-in: symbol and file lookups over fixed lists.
function fakeIndex(): RepoIndex {
  const symbols = [
    {
      name: 'releaseInventory',
      qualified: 'src/orders/cancel.ts#InventoryService.releaseInventory',
      kind: 'method' as const,
      file: 'src/orders/cancel.ts',
      startLine: 3,
      endLine: 5,
      exported: true,
      owner: 'InventoryService',
    },
  ];
  return {
    symbols: async (q: string) =>
      Object.assign(
        symbols.filter((s) => s.name.toLowerCase().startsWith(q.toLowerCase())),
        { truncated: false },
      ) as SymbolResults,
    files: async (q: string) => ['src/orders/cancel.ts', 'src/jobs/retries.ts'].filter((p) => p.includes(q)).map((p) => ({ path: p, score: 1, changed: true })),
    enclosingDecl: async () => ({ name: 'cancelOrder', qualified: 'x', file: 'src/orders/cancel.ts', kind: 'function', startLine: 1, endLine: 6, exported: true, calls: [], side: 'head' }),
    possibleCallers: async (name: string) => (name === 'releaseInventory' ? [{ file: 'src/jobs/retries.ts', line: 9, text: 'inventory.releaseInventory(items)' }] : []),
  } as unknown as RepoIndex;
}

function Harness(props: { tour: Tour; onDraft?: (d: Draft) => void; initial?: Draft[]; references?: Partial<ReferenceServices>; agent?: boolean; width?: number }) {
  const [pos, setPos] = useState({ ci: 0, hi: 0 });
  const [states, setStates] = useState<States>({});
  const [drafts, setDrafts] = useState<Draft[]>(props.initial ?? []);
  return (
    <ChapterScreen
      tour={props.tour}
      chapters={props.tour.chapters}
      states={states}
      drafts={drafts}
      ci={pos.ci}
      hi={pos.hi}
      order="flow"
      deltaOnly={false}
      width={props.width ?? 150}
      height={44}
      services={{ root, confirms: {}, setConfirm: () => {} }}
      references={{ host: 'github.com', repoIndex: fakeIndex, ...props.references }}
      agent={props.agent ? { cwd: root } : undefined}
      setPos={(ci, hi) => setPos({ ci, hi })}
      setState={(h: Hunk, s: ReadState) => setStates((prev) => ({ ...prev, [h.contentHash]: s }))}
      saveDraft={(d) => {
        setDrafts((ds) => [...ds.filter((x) => x.id !== d.id), d]);
        props.onDraft?.(d);
      }}
      deleteDraft={() => {}}
      moveHunk={() => {}}
      toggleOrder={() => {}}
      toggleDelta={() => {}}
      openSubmit={() => {}}
      openBriefing={() => {}}
      openInAgent={() => {}}
      quit={() => {}}
    />
  );
}

const lineDraft = (line: number, extra: Partial<Draft> = {}): Draft => ({
  id: 'd1',
  repo: 'acme/shop',
  pr: 482,
  headSha: HEAD,
  anchor: { type: 'line', hunkId: 'hA', file: 'src/orders/cancel.ts', line, side: 'RIGHT' },
  label: 'question',
  body: 'Could a retry release twice?',
  posted: false,
  createdAt: '2026-10-01T00:00:00Z',
  ...extra,
});

const ofText = (frame: string | undefined, text: string) => (frame ?? '').split('\n').findIndex((l) => l.includes(text));

describe('comment composer', () => {
  it('keeps a comment without references as it was: Enter saves, Tab cycles the label, no refs stored', async () => {
    const drafts: Draft[] = [];
    const ui = render(<Harness tour={fixture()} onDraft={(d) => drafts.push(d)} />);
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on src/orders/cancel.ts:3'));
    expect(ui.lastFrame()).toContain('enter: save draft');
    expect(ui.lastFrame()).toContain('@ people/code');
    expect(ui.lastFrame()).not.toMatch(/ctrl\+[pt]/);
    expect(ui.lastFrame()).not.toContain('evidence');
    ui.stdin.write('\t');
    await tick();
    ui.stdin.write('plain note');
    await tick();
    ui.stdin.write('\r');
    await waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0].label).toBe('suggestion');
    expect(drafts[0].body).toBe('plain note');
    expect(Object.keys(drafts[0])).not.toContain('refs');
    expect(Object.keys(drafts[0])).not.toContain('suggestionMeta');
    ui.unmount();
  });

  // "Could a retry here" with the cursor before "here", then `query` typed there.
  const typeMidText = async (ui: ReturnType<typeof render>, query: string) => {
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on'));
    ui.stdin.write('Could a retry here');
    await tick();
    for (let i = 0; i < 4; i++) {
      ui.stdin.write(LEFT);
      await tick();
    }
    ui.stdin.write(query);
  };

  it('@tests: lists the linked tests and inserts one at the cursor, with the ref the hunk’s test gives', async () => {
    const drafts: Draft[] = [];
    const ui = render(<Harness tour={fixture()} onDraft={(d) => drafts.push(d)} />);
    await typeMidText(ui, '@tests:');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ ✓ cancels an order once'));
    const frame = ui.lastFrame()!;
    // The coverage test first, the name guess after it; no people for a filter.
    expect(ofText(frame, '✓ orders.test.ts')).toBeGreaterThan(ofText(frame, '✓ cancels an order once'));
    expect(frame).not.toContain('People');
    expect(frame).toContain('tests linked to this change · backspace');
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('Could a retry `orders.test.ts:120-122` here'));
    ui.stdin.write('\r');
    await waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0].body).toBe('Could a retry `orders.test.ts:120-122` here');
    expect(drafts[0].refs).toEqual([expect.objectContaining({ kind: 'range', path: 'test/orders.test.ts', startLine: 120, endLine: 122, commitSha: HEAD, label: 'orders.test.ts:120-122' })]);
    expect(Object.keys(drafts[0].refs![0]).sort()).toEqual(['commitSha', 'endLine', 'id', 'kind', 'label', 'linesHash', 'path', 'startLine']);
    ui.unmount();
  });

  it('@threads: inserts a thread reference that shows as its discussion; ordinary code shows nothing', async () => {
    const drafts: Draft[] = [];
    const ui = render(<Harness tour={fixture()} onDraft={(d) => drafts.push(d)} />);
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on'));
    ui.stdin.write('@threads:');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ ¶ @alice: Is this retried?'));
    // A thread previews its comments and has no lines to pick.
    expect(ui.lastFrame()).not.toContain('→ pick lines');
    expect(ui.lastFrame()).toContain('review threads on this PR');
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('`thread:cancel.ts:4`'));
    ui.stdin.write(LEFT);
    await waitFor(() => expect(ui.lastFrame()).toContain('→ discussion on src/orders/cancel.ts:4'));
    ui.stdin.write(RIGHT);
    await tick();
    ui.stdin.write('\r');
    await waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0].refs).toEqual([
      expect.objectContaining({ kind: 'thread', path: 'src/orders/cancel.ts', startLine: 4, label: 'thread:cancel.ts:4', threadUrl: 'https://github.com/acme/shop/pull/482#discussion_r991' }),
    ]);
    ui.unmount();
    const plain = render(<Harness tour={fixture()} />);
    await tick();
    plain.stdin.write('c');
    await waitFor(() => expect(plain.lastFrame()).toContain('Comment on'));
    plain.stdin.write('`nope`');
    await waitFor(() => expect(plain.lastFrame()).toContain('`nope`'));
    plain.stdin.write(LEFT);
    await tick(60);
    expect(plain.lastFrame()).not.toContain('→ ');
    plain.unmount();
  });

  it('deleting a code reference deletes its reference when the draft is saved', async () => {
    const drafts: Draft[] = [];
    const ref: CodeRef = { id: 'r1', kind: 'range', path: 'src/jobs/retries.ts', commitSha: HEAD, startLine: 2, label: 'retries.ts:2' };
    const ui = render(<Harness tour={fixture()} initial={[lineDraft(3, { body: 'Same as `retries.ts:2`', refs: [ref] })]} onDraft={(d) => drafts.push(d)} />);
    await tick();
    ui.stdin.write('E');
    await waitFor(() => expect(ui.lastFrame()).toContain('Same as `retries.ts:2`'));
    expect(ui.lastFrame()).toContain(`→ src/jobs/retries.ts:2 @${HEAD.slice(0, 7)}`);
    ui.stdin.write(CTRL.u);
    await tick();
    ui.stdin.write('rewritten');
    await tick();
    ui.stdin.write('\r');
    await waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0].body).toBe('rewritten');
    expect('refs' in drafts[0]).toBe(false);
    ui.unmount();
  });

  it('@callers: lists the blast radius’s callers as possible, matched by name, and inserts one', async () => {
    const drafts: Draft[] = [];
    const ui = render(<Harness tour={fixture()} onDraft={(d) => drafts.push(d)} />);
    await typeMidText(ui, '@callers:');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ ↳ return cancelOrder(id);'));
    expect(ui.lastFrame()).toContain('possible callers of cancelOrder() · matched by');
    expect(ui.lastFrame()).not.toContain('People');
    ui.stdin.write('\t');
    await waitFor(() => expect(ui.lastFrame()).toContain('Could a retry `retries.ts:2` here'));
    ui.stdin.write('\r');
    await waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0].refs).toEqual([expect.objectContaining({ kind: 'range', path: 'src/jobs/retries.ts', startLine: 2, label: 'retries.ts:2', linesHash: linesHash(RETRIES[1]) })]);
    ui.unmount();
  });

  it('@callers:name searches call sites of that name', async () => {
    const ui = render(<Harness tour={fixture()} />);
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on'));
    ui.stdin.write('@callers:releaseInventory');
    await waitFor(() => expect(ui.lastFrame()).toContain('↳ inventory.releaseInvento'));
    expect(ui.lastFrame()).toContain('possible callers of releaseInventory()');
    ui.unmount();
  });

  it('@thr offers the threads filter; Tab keeps the list open on it, then lists the threads', async () => {
    const ui = render(<Harness tour={{ ...fixture(), mentionUsers: ['thea', 'bob'] }} />);
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on'));
    ui.stdin.write('see @th');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ threads:'));
    const frame = ui.lastFrame()!;
    // Filters above people, each under its header.
    const order = ['Filters', '▸ threads:', 'People', '@thea'].map((t) => ofText(frame, t));
    expect(order.every((n, i) => n > -1 && (i === 0 || n > order[i - 1]))).toBe(true);
    expect(frame).toContain('existing review threads');
    ui.stdin.write('\t');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ ¶ @alice: Is this retried?'));
    expect(ui.lastFrame()).toContain('see @threads:');
    expect(ui.lastFrame()).not.toContain('`');
    ui.unmount();
  });

  it('Ctrl+R does nothing in the composer', async () => {
    const ui = render(<Harness tour={fixture()} />);
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on'));
    ui.stdin.write('abc');
    await waitFor(() => expect(ui.lastFrame()).toContain('abc'));
    const before = ui.lastFrame();
    ui.stdin.write(CTRL.r);
    await tick(60);
    expect(ui.lastFrame()).toBe(before);
    ui.unmount();
  });

  it('@ completion inserts the symbol as a code span and stores its ref', async () => {
    const drafts: Draft[] = [];
    const ui = render(<Harness tour={fixture()} onDraft={(d) => drafts.push(d)} />);
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on'));
    ui.stdin.write('See @rel');
    await waitFor(() => expect(ui.lastFrame()).toContain('ƒ releaseInventory  method'));
    ui.stdin.write('\t');
    await waitFor(() => expect(ui.lastFrame()).toContain('See `releaseInventory()`'));
    ui.stdin.write('\r');
    await waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0].body).toBe('See `releaseInventory()`');
    expect(drafts[0].refs).toEqual([
      expect.objectContaining({
        kind: 'symbol',
        label: 'releaseInventory()',
        path: 'src/orders/cancel.ts',
        startLine: 3,
        endLine: 5,
        commitSha: HEAD,
        linesHash: linesHash(CANCEL.slice(2, 5).join('\n')),
      }),
    ]);
    ui.unmount();
  });

  it('@ with nothing typed lists recent places, then the changed files’ declarations', async () => {
    const recent: RecentLocation[] = [{ path: 'src/jobs/retries.ts', line: 2, why: 'dwell', at: 1 }];
    const ui = render(<Harness tour={fixture()} references={{ recent: () => recent }} />);
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on'));
    ui.stdin.write('@');
    await waitFor(() => expect(ui.lastFrame()).toContain('◷ src/jobs/retries.ts:2'));
    // Down past the people to the declarations: the list keeps five rows above its two hint lines.
    for (let i = 0; i < 3; i++) {
      ui.stdin.write(DOWN);
      await tick();
    }
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ ƒ releaseInventory'));
    const frame = ui.lastFrame();
    expect(ofText(frame, '◷ src/jobs/retries.ts:2')).toBeGreaterThan(-1);
    expect(ofText(frame, '◷ src/jobs/retries.ts:2')).toBeLessThan(ofText(frame, 'ƒ releaseInventory'));
    ui.unmount();
  });

  it('Ctrl+G records the suggestion as written by hand', async () => {
    const drafts: Draft[] = [];
    const ui = render(<Harness tour={fixture()} onDraft={(d) => drafts.push(d)} />);
    await tick();
    ui.stdin.write('j');
    await tick();
    ui.stdin.write('j');
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on src/orders/cancel.ts:5'));
    ui.stdin.write(CTRL.g);
    await waitFor(() => expect(ui.lastFrame()).toContain('+ qty += once(n);'));
    ui.stdin.write('\r');
    await waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0].suggestion).toBe('qty += once(n);');
    expect(drafts[0].suggestionMeta).toEqual({ source: 'manual', headSha: HEAD, originalHash: linesHash('  qty += n;') });
    ui.unmount();
  });

  it('A does nothing in the chapter screen', async () => {
    const ui = render(<Harness tour={fixture()} />);
    await tick();
    const before = ui.lastFrame();
    expect(before).not.toMatch(/pin/i);
    ui.stdin.write('A');
    await tick(60);
    expect(ui.lastFrame()).toBe(before);
    ui.stdin.write('?');
    await waitFor(() => expect(ui.lastFrame()).toContain('Focus the test pane'));
    expect(ui.lastFrame()).not.toMatch(/pin/i);
    ui.unmount();
  });
});

describe('@ completion preview', () => {
  const editor = (opts: { width?: number; mentions?: string[]; onSave?: (d: Draft) => void; onCancel?: () => void } = {}) => (
    <CommentEditor
      draft={lineDraft(3, { body: '' })}
      target="src/orders/cancel.ts:3"
      width={opts.width ?? 120}
      mentions={opts.mentions}
      env={{ tour: fixture(), root, host: 'github.com', repoIndex: fakeIndex }}
      onSave={opts.onSave ?? (() => {})}
      onCancel={opts.onCancel ?? (() => {})}
    />
  );
  const at = `@ ${HEAD.slice(0, 7)}`;

  it('shows the highlighted item beside the list and follows ↑/↓', async () => {
    const ui = render(editor());
    await tick();
    ui.stdin.write('@f:');
    await waitFor(() => expect(ui.lastFrame()).toContain(`src/orders/cancel.ts ${at}`));
    expect(ui.lastFrame()).toContain('export async function cancelOrder');
    // Side by side: the list's first row and the preview's title share a line. Only code
    // matches `@f:`, so the lone group has no header.
    const frame = ui.lastFrame()!;
    expect(frame).not.toMatch(/^\s*Code\s*$/m);
    expect(ofText(frame, '▤ src/orders/cancel.ts')).toBe(ofText(frame, `src/orders/cancel.ts ${at}`));
    ui.stdin.write(DOWN);
    await waitFor(() => expect(ui.lastFrame()).toContain(`src/jobs/retries.ts ${at}`));
    expect(ui.lastFrame()).toContain('function retry(id)');
    ui.unmount();
  });

  it('stacks the preview under the list when the field is narrow', async () => {
    const ui = render(editor({ width: 70 }));
    await tick();
    ui.stdin.write('@f:');
    await waitFor(() => expect(ui.lastFrame()).toContain(`src/orders/cancel.ts ${at}`));
    const frame = ui.lastFrame()!;
    expect(ofText(frame, `src/orders/cancel.ts ${at}`)).toBeGreaterThan(ofText(frame, '▸ ▤ src/orders/cancel.ts'));
    expect(ofText(frame, '▸ ▤ src/orders/cancel.ts')).toBeGreaterThan(-1);
    ui.unmount();
  });

  it('→ chooses lines in the preview; Enter inserts them as a range at a mid-text cursor', async () => {
    const saved: Draft[] = [];
    const ui = render(editor({ onSave: (d) => saved.push(d) }));
    await tick();
    ui.stdin.write('Look here');
    await tick();
    for (let i = 0; i < 4; i++) {
      ui.stdin.write(LEFT);
      await tick();
    }
    ui.stdin.write('@rel');
    await waitFor(() => expect(ui.lastFrame()).toContain('ƒ releaseInventory'));
    ui.stdin.write(RIGHT);
    await waitFor(() => expect(ui.lastFrame()).toContain('enter insert lines'));
    expect(ui.lastFrame()).toContain('▶    3');
    ui.stdin.write('j');
    await tick();
    ui.stdin.write('v');
    await tick();
    ui.stdin.write('j');
    await waitFor(() => expect(ui.lastFrame()).toContain('▶    5'));
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('Look `cancel.ts:4-5` here'));
    expect(ui.lastFrame()).not.toContain('enter insert lines');
    ui.stdin.write('\r');
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].body).toBe('Look `cancel.ts:4-5` here');
    expect(saved[0].refs).toEqual([
      expect.objectContaining({ kind: 'range', path: 'src/orders/cancel.ts', startLine: 4, endLine: 5, label: 'cancel.ts:4-5', commitSha: HEAD, linesHash: linesHash(CANCEL.slice(3, 5).join('\n')) }),
    ]);
    ui.unmount();
  });

  it('← or Esc returns from the preview to the list, a second Esc closes the list, a third cancels', async () => {
    let cancelled = false;
    const ui = render(editor({ onCancel: () => (cancelled = true) }));
    await tick();
    ui.stdin.write('@rel');
    await waitFor(() => expect(ui.lastFrame()).toContain('ƒ releaseInventory'));
    ui.stdin.write(RIGHT);
    await waitFor(() => expect(ui.lastFrame()).toContain('enter insert lines'));
    ui.stdin.write(LEFT);
    await waitFor(() => expect(ui.lastFrame()).toContain('→ pick lines'));
    expect(ui.lastFrame()).toContain('@rel');
    ui.stdin.write(RIGHT);
    await waitFor(() => expect(ui.lastFrame()).toContain('enter insert lines'));
    ui.stdin.write(ESC);
    await waitFor(() => expect(ui.lastFrame()).toContain('→ pick lines'));
    ui.stdin.write(ESC);
    await waitFor(() => expect(ui.lastFrame()).not.toContain('ƒ releaseInventory'));
    expect(cancelled).toBe(false);
    ui.stdin.write(ESC);
    await waitFor(() => expect(cancelled).toBe(true));
    ui.unmount();
  });

  it('lists people first and code after, each under a header; a person inserts @name', async () => {
    const ui = render(editor({ mentions: ['alice', 'bob'] }));
    await tick();
    ui.stdin.write('hi @');
    await waitFor(() => expect(ui.lastFrame()).toContain('ƒ releaseInventory'));
    const frame = ui.lastFrame()!;
    const order = ['People', '▸ @alice', '@bob', 'Code', 'ƒ releaseInventory'].map((t) => ofText(frame, t));
    expect(order.every((n, i) => n > -1 && (i === 0 || n > order[i - 1]))).toBe(true);
    expect(frame).not.toContain(at); // a person has no preview
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('hi @alice'));
    expect(ui.lastFrame()).not.toContain('ƒ releaseInventory');
    ui.unmount();
  });

  it('inserts picked code as a code span at a mid-text cursor, highlights it, and shows its target', async () => {
    const saved: Draft[] = [];
    const ui = render(editor({ mentions: ['alice'], onSave: (d) => saved.push(d) }));
    await tick();
    ui.stdin.write('Look here');
    await tick();
    for (let i = 0; i < 4; i++) {
      ui.stdin.write(LEFT);
      await tick();
    }
    ui.stdin.write('@rel');
    await waitFor(() => expect(ui.lastFrame()).toContain('ƒ releaseInventory'));
    expect(ui.lastFrame()).not.toContain('People');
    ui.stdin.write('\t');
    await waitFor(() => expect(ui.lastFrame()).toContain('Look `releaseInventory()` here'));
    expect(ui.lastFrame()).not.toContain('→ ');
    ui.stdin.write(LEFT);
    await waitFor(() => expect(ui.lastFrame()).toContain(`→ src/orders/cancel.ts:3-5 @${HEAD.slice(0, 7)}`));
    ui.stdin.write('\r');
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].body).toBe('Look `releaseInventory()` here');
    expect(saved[0].refs).toEqual([expect.objectContaining({ kind: 'symbol', label: 'releaseInventory()', path: 'src/orders/cancel.ts', startLine: 3, endLine: 5 })]);
    ui.unmount();
  });

  it('opens nothing for an email address', async () => {
    const ui = render(editor({ mentions: ['bar'] }));
    await tick();
    ui.stdin.write('mail foo@bar');
    await waitFor(() => expect(ui.lastFrame()).toContain('mail foo@bar'));
    await tick(150);
    expect(ui.lastFrame()).not.toContain('tab insert · ↑↓ choose');
    ui.unmount();
  });

  it('says under the list what the keys do and what narrows it, or what the filter shows', async () => {
    const ui = render(editor({ mentions: ['alice'] }));
    await tick();
    ui.stdin.write('@');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ @alice'));
    // On a person: no lines to pick.
    expect(ui.lastFrame()).toContain('tab insert · ↑↓ choose · esc close');
    expect(ui.lastFrame()).toContain('narrow with  f: files  s: symbols  callers:  tests:  threads:  recent:');
    ui.stdin.write('callers:');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ ↳ return cancelOrder(id);'));
    expect(ui.lastFrame()).toContain('tab insert · ↑↓ choose · → pick lines · esc close');
    expect(ui.lastFrame()).toContain('possible callers of cancelOrder() · matched by name · backspace to clear filter');
    expect(ui.lastFrame()).not.toContain('narrow with');
    for (const [filter, says] of [
      ['tests', 'tests linked to this change'],
      ['threads', 'review threads on this PR'],
      ['recent', 'recent places in this review'],
      ['f', 'files · backspace'],
      ['symbols', 'symbols · backspace'],
    ]) {
      ui.stdin.write(CTRL.u);
      await tick();
      ui.stdin.write(`@${filter}:`);
      await waitFor(() => expect(ui.lastFrame()).toContain(says));
    }
    ui.unmount();
  });

  it('shows no preview for @ mentions', async () => {
    const ui = render(editor({ mentions: ['alice', 'bob'] }));
    await tick();
    ui.stdin.write('hi @al');
    await waitFor(() => expect(ui.lastFrame()).toContain('@alice'));
    expect(ui.lastFrame()).not.toContain(at);
    expect(ui.lastFrame()).not.toContain('pick lines');
    ui.unmount();
  });
});

describe('room for the @ list', () => {
  it('gives the comment the full width and most of the pane while the list is open, then brings the tests back', async () => {
    const ui = render(<Harness tour={fixture()} />);
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on'));
    expect(ui.lastFrame()).toContain('▸ cancels an order once'); // the tests pane beside the code
    ui.stdin.write('See @f:canc');
    await waitFor(() => expect(ui.lastFrame()).toContain('▤ src/orders/cancel.ts'));
    // The composer reports the open list after it renders, so the layout follows a frame later.
    await waitFor(() => expect(ui.lastFrame()).not.toContain('▸ cancels an order once'));
    const open = ui.lastFrame()!;
    // Side by side: the list's row and the preview's title share a line.
    expect(ofText(open, '▤ src/orders/cancel.ts')).toBe(ofText(open, `src/orders/cancel.ts @ ${HEAD.slice(0, 7)}`));
    ui.stdin.write(ESC);
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ cancels an order once'));
    ui.unmount();
  });
});

describe('composer keys', () => {
  it('ignores Ctrl+P: no anchor picker, and the composer is unchanged', async () => {
    const drafts: Draft[] = [];
    const ui = render(<Harness tour={fixture()} onDraft={(d) => drafts.push(d)} />);
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on src/orders/cancel.ts:3'));
    ui.stdin.write('stay');
    await waitFor(() => expect(ui.lastFrame()).toContain('stay'));
    const before = ui.lastFrame();
    ui.stdin.write(CTRL.p);
    await tick();
    await tick();
    expect(ui.lastFrame()).toBe(before);
    expect(ui.lastFrame()).not.toContain('CHOOSE WHERE');
    ui.stdin.write('\r');
    await waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0]).toMatchObject({ body: 'stay', anchor: { line: 3, hunkId: 'hA' } });
    ui.unmount();
  });

  it('says what Ctrl+T does, in fewer words when narrow, without truncating it away', async () => {
    const t = fixture({ mode: 'agent' });
    const editor = (width: number, height: number) =>
      render(
        <CommentEditor
          draft={lineDraft(5)}
          target="src/orders/cancel.ts:5"
          hunk={t.hunks.hA}
          width={width}
          height={height}
          env={{ tour: t, root, host: 'github.com', repoIndex: fakeIndex, agent: { cwd: root } }}
          onSave={() => {}}
          onCancel={() => {}}
        />,
      );
    for (const [width, height, says] of [
      [120, 14, '@ people/code · ctrl+t suggest a code change with AI'],
      [48, 14, '@ people/code · ctrl+t suggest a fix with AI'],
      [120, 30, 'enter save · @ people/code · ctrl+t suggest a code change with AI · ctrl+g $EDITOR · esc'],
    ] as const) {
      const ui = editor(width, height);
      await waitFor(() => expect(ui.lastFrame()).toContain(says));
      ui.unmount();
    }
  });

  it('says a suggestion from an earlier head applies only when its lines read the same now, as posting does', async () => {
    for (const [hash, says] of [
      [linesHash('  qty += n;'), 'applies to L5'],
      ['changed', 'plain code block: The suggestion was written on old and the lines changed since.'],
    ] as const) {
      const meta = { source: 'manual' as const, headSha: 'old', originalHash: hash };
      const t = fixture();
      const ui = render(
        <CommentEditor
          draft={lineDraft(5, { suggestion: 'qty += once(n);', suggestionMeta: meta })}
          target="src/orders/cancel.ts:5"
          hunk={t.hunks.hA}
          width={120}
          height={30}
          env={{ tour: t, root, host: 'github.com', repoIndex: fakeIndex }}
          onSave={() => {}}
          onCancel={() => {}}
        />,
      );
      await waitFor(() => expect(ui.lastFrame()).toContain(says));
      ui.unmount();
    }
  });
});

describe('AI suggestion line', () => {
  const result: SuggestionResult = {
    code: '  qty += once(n);',
    explanation: 'once() skips a retried cancel.',
    assumptions: ['once() is idempotent'],
    citations: [{ path: 'src/jobs/retries.ts', startLine: 2 }],
    notes: [],
    model: { provider: 'claude-code', model: 'test-model' },
  };
  // A comment on L5 (`qty += n;`), optionally with body text, then Ctrl+T.
  const openLine = async (ui: ReturnType<typeof render>, body = '') => {
    await tick();
    ui.stdin.write('j');
    await tick();
    ui.stdin.write('j');
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on src/orders/cancel.ts:5'));
    if (body) {
      ui.stdin.write(body);
      await waitFor(() => expect(ui.lastFrame()).toContain(body));
    }
    ui.stdin.write(CTRL.t);
    await waitFor(() => expect(ui.lastFrame()).toContain('Describe the change (optional)'));
    expect(ui.lastFrame()).toContain('enter generate · esc cancel');
  };
  const agentHarness = (generate: ReferenceServices['generate'], drafts: Draft[] = []) =>
    render(<Harness tour={fixture({ mode: 'agent' })} agent references={{ generate }} onDraft={(d) => drafts.push(d)} />);

  it('opens inline under the body, with the code still in view and no model shown', async () => {
    const ui = agentHarness(async () => result);
    await openLine(ui, 'twice?');
    const frame = ui.lastFrame()!;
    expect(frame).toContain('✦');
    expect(frame).toContain('twice?');
    expect(frame).toContain('release(items);'); // the diff above the composer
    expect(frame).not.toContain('qa ·');
    expect(frame).not.toContain('claude-code');
    expect(frame).not.toContain('What should change?');
    ui.unmount();
  });

  it('passes the references the body names to the prompt, and no other code', async () => {
    const calls: SuggestOptions[] = [];
    const ui = agentHarness(async (o) => {
      calls.push(o);
      return result;
    });
    await tick();
    ui.stdin.write('j');
    await tick();
    ui.stdin.write('j');
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on src/orders/cancel.ts:5'));
    ui.stdin.write('like @rel');
    await waitFor(() => expect(ui.lastFrame()).toContain('ƒ releaseInventory'));
    ui.stdin.write('\t');
    await waitFor(() => expect(ui.lastFrame()).toContain('like `releaseInventory()`'));
    ui.stdin.write('not `x`');
    await tick();
    ui.stdin.write(CTRL.t);
    await waitFor(() => expect(ui.lastFrame()).toContain('Describe the change (optional)'));
    ui.stdin.write('\r');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].refs?.map((r) => r.label)).toEqual(['releaseInventory()']);
    ui.unmount();
  });

  it('generates inline, refines with `previous`, and accepts with the body cursor kept', async () => {
    const calls: SuggestOptions[] = [];
    const generate = vi.fn(async (o: SuggestOptions) => {
      calls.push(o);
      return result;
    });
    const drafts: Draft[] = [];
    const ui = agentHarness(generate, drafts);
    await tick();
    ui.stdin.write('j');
    await tick();
    ui.stdin.write('j');
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on src/orders/cancel.ts:5'));
    ui.stdin.write('retry twice');
    await tick();
    ui.stdin.write(LEFT);
    await tick();
    ui.stdin.write(LEFT);
    await tick();
    ui.stdin.write(CTRL.t);
    await waitFor(() => expect(ui.lastFrame()).toContain('Describe the change (optional)'));
    ui.stdin.write('make it idempotent');
    await tick();
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('✦ proposal'));
    expect(calls[0]).toMatchObject({ instruction: 'make it idempotent', anchor: { line: 5 }, enclosing: { name: 'cancelOrder' } });
    expect(calls[0].tests).toHaveLength(2);
    expect(calls[0].callers).toHaveLength(1);
    expect(calls[0].previous).toBeUndefined();
    let frame = ui.lastFrame()!;
    expect(frame).toContain('-   qty += n;');
    expect(frame).toContain('+   qty += once(n);');
    expect(frame).toContain('not verified · applies on L5');
    expect(frame).toContain('why once() skips a retried cancel.');
    expect(frame).toContain('1 assumption · 1 citation ✓');
    expect(frame).toContain('retry twice'); // the body stays
    expect(frame).toContain('enter accept · r refine · e edit · esc discard');
    expect(frame).not.toContain('test-model');

    ui.stdin.write('r');
    await waitFor(() => expect(ui.lastFrame()).toContain('✦ make it idempotent'));
    ui.stdin.write(' with a lock');
    await tick();
    ui.stdin.write('\r');
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].previous).toEqual({ code: '  qty += once(n);', feedback: 'make it idempotent with a lock' });
    await waitFor(() => expect(ui.lastFrame()).toContain('✦ proposal'));
    ui.stdin.write('c'); // not a result key
    await tick(60);
    expect(ui.lastFrame()).toContain('✦ proposal');

    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('AI suggestion accepted'));
    frame = ui.lastFrame()!;
    expect(frame).not.toContain('✦');
    ui.stdin.write('X');
    await waitFor(() => expect(ui.lastFrame()).toContain('retry twiXce'));
    ui.stdin.write('\r');
    await waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0].body).toBe('retry twiXce');
    expect(drafts[0].suggestion).toBe('  qty += once(n);');
    expect(drafts[0].suggestionMeta).toMatchObject({
      source: 'ai',
      headSha: HEAD,
      originalHash: linesHash('  qty += n;'),
      model: { provider: 'claude-code', model: 'test-model' },
      explanation: 'once() skips a retried cancel.',
      assumptions: ['once() is idempotent'],
    });
    expect('refs' in drafts[0]).toBe(false);
    ui.unmount();
  });

  it('accepts with a and edits in $EDITOR with e', async () => {
    for (const [key, code] of [
      ['a', '  qty += once(n);'],
      ['e', 'qty += once(n);'],
    ] as const) {
      const drafts: Draft[] = [];
      const ui = agentHarness(async () => result, drafts);
      await openLine(ui, 'note');
      ui.stdin.write('\r');
      await waitFor(() => expect(ui.lastFrame()).toContain('✦ proposal'));
      ui.stdin.write(key);
      await waitFor(() => expect(ui.lastFrame()).toContain('AI suggestion accepted'));
      ui.stdin.write('\r');
      await waitFor(() => expect(drafts).toHaveLength(1));
      expect(drafts[0].suggestion).toBe(code);
      expect(drafts[0].suggestionMeta?.source).toBe('ai');
      ui.unmount();
    }
  });

  it('Esc on the proposal restores the suggestion the draft had', async () => {
    const drafts: Draft[] = [];
    const ui = agentHarness(async () => ({ ...result, code: '  qty += twice(n);' }), drafts);
    await openLine(ui, 'note');
    ui.stdin.write(ESC);
    await waitFor(() => expect(ui.lastFrame()).not.toContain('Describe the change'));
    ui.stdin.write(CTRL.g);
    await waitFor(() => expect(ui.lastFrame()).toContain('Suggestion updated'));
    ui.stdin.write(CTRL.t);
    await waitFor(() => expect(ui.lastFrame()).toContain('Describe the change'));
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('+   qty += twice(n);'));
    ui.stdin.write(ESC);
    await waitFor(() => expect(ui.lastFrame()).toContain('Proposal discarded'));
    expect(ui.lastFrame()).toContain('+ qty += once(n);');
    ui.stdin.write('\r');
    await waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0].suggestion).toBe('qty += once(n);');
    expect(drafts[0].suggestionMeta?.source).toBe('manual');
    ui.unmount();
  });

  it('Esc while generating aborts and returns to the instruction with its text', async () => {
    let signal: AbortSignal | undefined;
    const generate = (o: SuggestOptions) =>
      new Promise<SuggestionResult>((_resolve, reject) => {
        signal = o.signal;
        o.onText?.('{"replacement":');
        o.signal?.addEventListener('abort', () => reject(new SuggestionError('aborted', 'Suggestion cancelled.')));
      });
    const ui = agentHarness(generate);
    await openLine(ui);
    ui.stdin.write('idempotent');
    await tick();
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('generating… 15 chars'));
    expect(ui.lastFrame()).toContain('esc stop');
    ui.stdin.write(ESC);
    await waitFor(() => expect(ui.lastFrame()).toContain('Cancelled. Nothing was changed.'));
    expect(signal?.aborted).toBe(true);
    expect(ui.lastFrame()).toContain('✦ idempotent');
    ui.unmount();
  });

  it('shows request errors on the line; Esc returns to the instruction', async () => {
    for (const error of [new SuggestionError('failed', 'The suggestion failed: rate limited'), new SuggestionError('not-applicable', 'Lines 5-6 span more than one GitHub hunk.')]) {
      const ui = agentHarness(async () => {
        throw error;
      });
      await openLine(ui);
      ui.stdin.write('idempotent');
      await tick();
      ui.stdin.write('\r');
      await waitFor(() => expect(ui.lastFrame()).toContain(`✦ ${error.message}`));
      expect(ui.lastFrame()).toContain('enter retry · esc back · nothing was changed');
      expect(ui.lastFrame()).toContain('Comment on src/orders/cancel.ts:5');
      ui.stdin.write(ESC);
      await waitFor(() => expect(ui.lastFrame()).toContain('✦ idempotent'));
      ui.unmount();
    }
  });

  it('is off without an agent and says so on the line', async () => {
    const generate = vi.fn();
    const ui = render(<Harness tour={fixture()} references={{ generate }} />);
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on'));
    expect(ui.lastFrame()).not.toContain('ctrl+t');
    ui.stdin.write(CTRL.t);
    await waitFor(() => expect(ui.lastFrame()).toContain('✦ AI is off'));
    expect(ui.lastFrame()).toContain('ctrl+g');
    expect(ui.lastFrame()).toContain('esc close');
    ui.stdin.write(ESC);
    await waitFor(() => expect(ui.lastFrame()).not.toContain('AI is off'));
    expect(ui.lastFrame()).toContain('Comment on');
    expect(generate).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('refuses a removed line with the reason, on the line', async () => {
    const t = fixture({ mode: 'agent' });
    t.hunks.hA.lines.splice(2, 0, { kind: 'del', text: '  old();', oldLine: 3 });
    const generate = vi.fn();
    const ui = render(<Harness tour={t} agent references={{ generate }} />);
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on src/orders/cancel.ts:3'));
    ui.stdin.write(CTRL.t);
    await waitFor(() => expect(ui.lastFrame()).toContain('✦ No AI suggestion here'));
    expect(ui.lastFrame()).toContain('removed lines');
    expect(generate).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('grows the inline slot for a proposal and cuts a long one short, keeping the commented line in view', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `  step${i + 1}();`).join('\n');
    const ui = agentHarness(async () => ({ ...result, code: long }));
    await openLine(ui, 'note');
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('✦ proposal'));
    const frame = ui.lastFrame()!;
    const shown = frame.split('\n').filter((l) => /\+ {3}step\d+\(\);/.test(l)).length;
    expect(shown).toBeGreaterThan(8); // more than the usual 11-row slot holds
    expect(shown).toBeLessThan(60);
    expect(frame).toMatch(/… \d+ more lines/);
    expect(frame).toContain('why once() skips a retried cancel.');
    const cursorRow = ofText(frame, '▶');
    expect(cursorRow).toBeGreaterThanOrEqual(0);
    expect(frame.split('\n')[cursorRow]).toContain('qty += n;');
    expect(cursorRow).toBeLessThan(ofText(frame, '✦ proposal'));
    ui.unmount();
  });
});

describe('submit screen', () => {
  const submit = (drafts: Draft[], extra: Partial<React.ComponentProps<typeof SubmitScreen>> = {}) => (
    <SubmitScreen
      tour={fixture()}
      chapters={fixture().chapters}
      states={{}}
      drafts={drafts}
      width={140}
      height={44}
      host="github.com"
      onEdit={() => {}}
      onDelete={() => {}}
      onPosted={() => {}}
      onBack={() => {}}
      {...extra}
    />
  );

  it('notes on a draft row what posting changes, without blocking P', async () => {
    const drafts = [
      lineDraft(9, { id: 'moved', body: 'Moved one' }),
      lineDraft(3, { id: 'plain', body: 'Plain one', suggestion: 'x', suggestionMeta: { source: 'manual', headSha: 'old', originalHash: 'nope' } }),
      lineDraft(3, { id: 'body', body: 'Flow one', anchor: { type: 'chapter', chapterId: 'gone' } }),
      lineDraft(4, { id: 'same', body: 'Stays put' }),
    ];
    const ui = render(submit(drafts));
    await waitFor(() => expect(ui.lastFrame()).toContain('moves to line 6'));
    const frame = ui.lastFrame()!;
    expect(frame).toContain('suggestion posts as plain code');
    expect(frame).toContain('posts in the review body');
    expect(frame.split('\n').find((l) => l.includes('Stays put'))).not.toMatch(/moves|posts/);
    expect(frame).not.toMatch(/Pre-flight|checking references/i);
    ui.stdin.write('P');
    await waitFor(() => expect(ui.lastFrame()).toContain('Y / n'));
    ui.unmount();
  });

  it('p previews and P posts with the same rule: a suggestion whose lines read the same at the new head stays applicable', async () => {
    const { postReview } = await import('../src/github/gh.js');
    vi.mocked(postReview).mockClear();
    const draft = lineDraft(5, { suggestion: 'x', suggestionMeta: { source: 'ai', headSha: 'old', originalHash: linesHash('  qty += n;') } });
    const ui = render(submit([draft]));
    await waitFor(() => expect(ui.lastFrame()).toContain('Drafts (1)'));
    expect(ui.lastFrame()).not.toContain('plain code');
    ui.stdin.write('p');
    await waitFor(() => expect(ui.lastFrame()).toContain('As posted on src/orders/cancel.ts:5 RIGHT'));
    expect(ui.lastFrame()).toContain('```suggestion');
    ui.stdin.write(ESC);
    await waitFor(() => expect(ui.lastFrame()).toContain('Drafts (1)'));
    ui.stdin.write('P');
    await waitFor(() => expect(ui.lastFrame()).toContain('Y / n'));
    ui.stdin.write('y');
    await waitFor(() => expect(postReview).toHaveBeenCalled());
    expect(vi.mocked(postReview).mock.calls[0][2].comments[0].body).toContain('```suggestion\nx\n```');
    ui.unmount();
  });
});

describe('thread reply', () => {
  it('Esc with the mention list open closes only the list', async () => {
    const thread = fixture().existingThreads[0];
    let closed = false;
    const ui = render(<ThreadView threads={[thread]} width={80} height={20} mentions={['alice', 'bob']} startReply onReply={async () => {}} onClose={() => (closed = true)} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Reply to review thread'));
    ui.stdin.write('hi @al');
    await waitFor(() => expect(ui.lastFrame()).toContain('tab insert · ↑↓ choose · esc close'));
    // Mentions only: the actions line alone, no filters.
    expect(ui.lastFrame()).not.toMatch(/narrow with|pick lines/);
    ui.stdin.write(ESC);
    await waitFor(() => expect(ui.lastFrame()).not.toContain('tab insert · ↑↓ choose'));
    expect(ui.lastFrame()).toContain('Reply to review thread');
    expect(ui.lastFrame()).toContain('hi @al');
    ui.stdin.write(ESC);
    await waitFor(() => expect(ui.lastFrame()).not.toContain('Reply to review thread'));
    expect(closed).toBe(false);
    ui.unmount();
  });

  it('@ offers people only: no code group, and no list for a path or filter', async () => {
    const thread = fixture().existingThreads[0];
    const ui = render(<ThreadView threads={[thread]} width={80} height={20} mentions={['alice', 'bob']} startReply onReply={async () => {}} onClose={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Reply to review thread'));
    ui.stdin.write('hi @');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ @alice'));
    expect(ui.lastFrame()).not.toMatch(/People|Code|searching/);
    ui.stdin.write('f:');
    await waitFor(() => expect(ui.lastFrame()).toContain('hi @f:'));
    await tick(60);
    expect(ui.lastFrame()).not.toContain('tab insert · ↑↓ choose');
    ui.unmount();
  });
});
