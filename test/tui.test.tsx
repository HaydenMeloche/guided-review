import React, { useState } from 'react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { ChapterOrder, Draft, ExistingThread, Hunk, MovedTo, ReadState, Tour } from '../src/types.js';
import { buildFixture, ctx, head } from './fixtures/invoiceFlow.js';
import { buildSymbolIndex } from '../src/analysis/symbols.js';
import { buildChapters } from '../src/analysis/flows.js';
import { pairTests } from '../src/analysis/tests.js';
import { classifyFiles } from '../src/analysis/kinds.js';
import { defaultRepoConfig } from '../src/config.js';
import { buildReviewPayload } from '../src/review/submit.js';
import { ChapterScreen } from '../src/tui/ChapterScreen.js';
import { ThreadView } from '../src/tui/ThreadView.js';
import { SubmitScreen } from '../src/tui/SubmitScreen.js';
import { BriefingScreen } from '../src/tui/BriefingScreen.js';
import { ORDER_SEQUENCE, positionAfterOrderChange, progress, sortChapters, type States } from '../src/tui/nav.js';
import { waitFor } from './helpers/waitFor.js';
import { filesFor, hunkFromDiff, tour as makeTour } from './fixtures/tour.js';

// Never reach GitHub from a test: confirming the submit screen posts through this.
vi.mock('../src/agent/agent.js', async (orig) => ({ ...(await orig<typeof import('../src/agent/agent.js')>()), ask: vi.fn(async () => ({ value: 'An answer.' })) }));
vi.mock('../src/github/gh.js', async (orig) => ({ ...(await orig<typeof import('../src/github/gh.js')>()), postReview: vi.fn(async () => ({ id: 1, url: 'https://example.test/review/1' })) }));

// A short settle for keypresses that change no output but must land before the next key
// (e.g. letting a newly active input handler attach). Waits on output use waitFor.
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function fixtureTour(): Tour {
  const { files, hunks } = buildFixture();
  classifyFiles(files, hunks, { gitattributes: '', readHead: ctx.readHead, config: defaultRepoConfig() });
  const index = buildSymbolIndex(files, hunks, ctx);
  pairTests(files, hunks, { root: '/nonexistent', readHead: ctx.readHead, listFiles: () => Object.keys(head) });
  const built = buildChapters(files, hunks, index);
  return makeTour(Object.values(hunks), built.chapters, {
    repo: 'acme/billing',
    pr: 7,
    title: 'Add invoice creation',
    url: 'https://github.com/acme/billing/pull/7',
    author: 'dev',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    createdAt: '2026-10-09T00:00:00Z',
    intent: 'Adds POST /invoices.',
    flags: built.flags,
    notes: built.notes,
    overview: built.overview,
    files,
  });
}

function Harness(props: {
  tour: Tour;
  onDraft: (d: Draft) => void;
  onState: (s: States) => void;
  startCi?: number;
  width?: number;
  onBriefing?: () => void;
  onReply?: (body: string) => Promise<void>;
  onDelete?: (d: Draft) => void;
  onTheme?: () => void;
  agent?: { cwd: string };
}) {
  const { tour } = props;
  const [pos, setPos] = useState({ ci: props.startCi ?? 0, hi: 0 });
  const [states, setStates] = useState<States>({});
  const [drafts, setDrafts] = useState<Draft[]>([]);
  return (
    <ChapterScreen
      tour={tour}
      chapters={tour.chapters}
      states={states}
      drafts={drafts}
      ci={pos.ci}
      hi={pos.hi}
      order="flow"
      deltaOnly={false}
      agent={props.agent}
      width={props.width ?? 150}
      height={40}
      setPos={(ci, hi) => setPos({ ci, hi })}
      setState={(h: Hunk, s: ReadState) =>
        setStates((prev) => {
          const next = { ...prev, [h.contentHash]: s };
          props.onState(next);
          return next;
        })
      }
      saveDraft={(d) => {
        setDrafts((ds) => [...ds.filter((x) => x.id !== d.id), d]);
        props.onDraft(d);
      }}
      deleteDraft={(d) => {
        setDrafts((ds) => ds.filter((x) => x.id !== d.id));
        props.onDelete?.(d);
      }}
      replyToThread={props.onReply ? async (_thread, body) => props.onReply!(body) : undefined}
      moveHunk={() => {}}
      toggleOrder={() => {}}
      toggleDelta={() => {}}
      openSubmit={() => {}}
      openBriefing={() => props.onBriefing?.()}
      openInAgent={() => {}}
      onTheme={props.onTheme}
      quit={() => {}}
    />
  );
}

describe('ChapterScreen', () => {
  it('opens the color theme picker on L', async () => {
    const onTheme = vi.fn();
    const ui = render(<Harness tour={fixtureTour()} onDraft={() => {}} onState={() => {}} onTheme={onTheme} />);
    await tick();
    ui.stdin.write('L');
    await waitFor(() => expect(onTheme).toHaveBeenCalledTimes(1));
    ui.unmount();
  });

  it('keeps the keyboard alive when an overlay would have nothing to show', async () => {
    const tour = fixtureTour();
    // A chapter emptied by moves, with a checklist but no checkout yet (no services).
    tour.chapters[0] = { ...tour.chapters[0], hunkIds: [], collapsed: false, checklist: [{ id: 'k', item: 'Migrations reviewed', pattern: '**', status: 'unknown' }] };
    const ui = render(<Harness tour={tour} onDraft={() => {}} onState={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('This chapter has no hunks.'));
    ui.stdin.write('a');
    await waitFor(() => expect(ui.lastFrame()).toContain('Nothing to ask about here.'));
    ui.stdin.write('i');
    await waitFor(() => expect(ui.lastFrame()).toContain('The checklist opens once the checkout is ready.'));
    ui.stdin.write('h');
    await waitFor(() => expect(ui.lastFrame()).toContain('Start or end a range selection'));
    ui.unmount();
  });

  it('renders linked changed tests with diff markers in the Tests pane', async () => {
    const tour = fixtureTour();
    const hunk = tour.hunks[tour.chapters[0].hunkIds[0]];
    hunk.tests = [
      {
        testFile: 'test/invoice.test.ts',
        testName: 'creates invoice',
        startLine: 1,
        lines: ["it('creates invoice', () => {", '  expect(createInvoice()).toBeTruthy();', '});'],
        source: 'name-match',
        confidence: 0.65,
        testFileStatus: 'added',
        testChange: 'new',
        diffHunks: [
          {
            header: '@@ -0,0 +1,3 @@',
            lines: [
              { kind: 'add', newLine: 1, text: "it('creates invoice', () => {" },
              { kind: 'add', newLine: 2, text: '  expect(createInvoice()).toBeTruthy();' },
              { kind: 'add', newLine: 3, text: '});' },
            ],
          },
        ],
      },
    ];
    const ui = render(<Harness tour={tour} onDraft={() => {}} onState={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('● new'));
    expect(ui.lastFrame()).toContain("+ it('creates invoice'");
    expect(ui.lastFrame()).toContain('+   expect(createInvoice())');
    ui.unmount();
  });

  it('keeps both panes visible when the selected test has longer code', async () => {
    const tour = fixtureTour();
    const hunk = tour.hunks[tour.chapters[0].hunkIds[0]];
    hunk.tests = [
      { testFile: 'test/short.test.ts', testName: 'short', startLine: 1, lines: ['expect(1);'], source: 'name-match', confidence: 0.8 },
      { testFile: 'test/long.test.ts', testName: 'long', startLine: 1, lines: [`expect(${Array(8).fill('invoice.total').join(' + ')}).toBeGreaterThan(0);`], source: 'name-match', confidence: 0.8 },
    ];
    const ui = render(<Harness tour={tour} onDraft={() => {}} onState={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toMatch(/│\s*Tests/));
    const boundary = () => {
      const frame = ui.lastFrame()!;
      const row = frame.split('\n').find((line) => /│\s*Tests/.test(line));
      if (!row) throw new Error(frame);
      return row.search(/│\s*Tests/);
    };
    const shortBoundary = boundary();
    ui.stdin.write('t');
    await waitFor(() => expect(ui.lastFrame()).toContain('t/esc'));
    ui.stdin.write('n');
    await waitFor(() => expect(boundary()).toBeLessThan(shortBoundary));
    expect(ui.lastFrame()).toContain('long.test.ts');
    expect(ui.lastFrame()).toContain('invoice.total');
    expect(ui.lastFrame()).toContain('import { Router }');
    ui.stdin.write('t');
    // The layout should not change: wait for the key bar to leave test focus, then check it.
    await waitFor(() => expect(ui.lastFrame()).not.toContain('t/esc'));
    expect(boundary()).toBeLessThan(shortBoundary);
    expect(ui.lastFrame()).toContain('import { Router }');
    ui.unmount();
  });

  it('gives the toggled pane the full width below the side-by-side breakpoint', async () => {
    const tour = fixtureTour();
    const hunk = tour.hunks[tour.chapters[0].hunkIds[0]];
    hunk.tests = [{ testFile: 'test/invoice.test.ts', testName: 'checks invoice', startLine: 1, lines: ['expect(invoice.total).toBe(42);'], source: 'name-match', confidence: 0.8 }];
    const ui = render(<Harness tour={tour} width={90} onDraft={() => {}} onState={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('import { Router }'));
    ui.stdin.write('t');
    await waitFor(() => expect(ui.lastFrame()).toContain('expect(invoice.total).toBe(42);'));
    expect(ui.lastFrame()).not.toContain('import { Router }');
    ui.stdin.write('t');
    await waitFor(() => expect(ui.lastFrame()).toContain('import { Router }'));
    ui.unmount();
  });

  it('wraps long source and test lines on a narrow terminal', async () => {
    const tour = fixtureTour();
    const hunk = tour.hunks[tour.chapters[0].hunkIds[0]];
    hunk.lines = [{ kind: 'add', newLine: 1, text: `${'source_prefix_'.repeat(12)}SOURCE_END` }];
    hunk.tests = [{ testFile: 'test/invoice.test.ts', testName: 'checks invoice', startLine: 1, lines: [`${'test_prefix_'.repeat(12)}TEST_END`], source: 'name-match', confidence: 0.8 }];
    const ui = render(<Harness tour={tour} width={90} onDraft={() => {}} onState={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('SOURCE_END'));
    ui.stdin.write('t');
    await waitFor(() => expect(ui.lastFrame()).toContain('TEST_END'));
    ui.unmount();
  });

  it('moves backward through tests and comments on the selected test line', async () => {
    const tour = fixtureTour();
    const sourceHunk = tour.hunks[tour.chapters[0].hunkIds[0]];
    const testFile = 'test/new-invoice.test.ts';
    const first = 'it("creates an invoice", () => {';
    const assertion = '  expect(createInvoice()).toBeTruthy();';
    const second = 'it("rejects an invoice", () => {});';
    const testLines: Hunk['lines'] = [
      { kind: 'add', text: first, newLine: 1 },
      { kind: 'add', text: assertion, newLine: 2 },
      { kind: 'add', text: second, newLine: 3 },
    ];
    tour.hunks['test-hunk'] = { ...sourceHunk, id: 'test-hunk', contentHash: 'test-hunk', file: testFile, lines: testLines };
    sourceHunk.tests = [
      {
        testFile,
        testName: 'creates an invoice',
        startLine: 1,
        lines: [first, assertion],
        source: 'name-match',
        confidence: 0.8,
        diffHunks: [{ header: '@@ -0,0 +1,2 @@', lines: testLines.slice(0, 2) }],
      },
      { testFile, testName: 'rejects an invoice', startLine: 3, lines: [second], source: 'name-match', confidence: 0.8, diffHunks: [{ header: '@@ -0,0 +3 @@', lines: testLines.slice(2) }] },
    ];
    const drafts: Draft[] = [];
    const ui = render(<Harness tour={tour} onDraft={(draft) => drafts.push(draft)} onState={() => {}} />);
    await tick();
    ui.stdin.write('t');
    await tick();
    ui.stdin.write('n');
    await waitFor(() => expect(ui.lastFrame()).toContain(second));
    expect(ui.lastFrame()).not.toContain(assertion);
    ui.stdin.write('p');
    await waitFor(() => expect(ui.lastFrame()).toContain('expect(createInvoice())'));
    expect(ui.lastFrame()).not.toContain(second);
    ui.stdin.write('j');
    await waitFor(() => expect(ui.lastFrame()).toMatch(/▶\s*2\s*│\s*\+/));
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain(`Comment on ${testFile}:2`));
    const commentRows = ui.lastFrame()!.split('\n');
    const selectedRow = commentRows.findIndex((row) => row.includes('▶') && row.includes('expect(createInvoice())'));
    const editorRow = commentRows.findIndex((row) => row.includes(`Comment on ${testFile}:2`));
    expect(selectedRow).toBeGreaterThan(-1);
    expect(editorRow).toBeGreaterThan(selectedRow);
    expect(editorRow - selectedRow).toBeLessThanOrEqual(2);
    expect(ui.lastFrame()).toContain('src/routes/invoices.ts');
    ui.stdin.write('Please check this assertion');
    await tick();
    ui.stdin.write('\r');
    await waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0].anchor).toEqual({ type: 'line', hunkId: 'test-hunk', file: testFile, line: 2, side: 'RIGHT' });
    expect(buildReviewPayload(tour, drafts, 'COMMENT', '').payload.comments[0]).toMatchObject({ path: testFile, line: 2, side: 'RIGHT' });
    ui.stdin.write('a');
    await waitFor(() => expect(ui.lastFrame()).toContain(`Ask about ${testFile}:2`));
    const askRows = ui.lastFrame()!.split('\n');
    const askLine = askRows.findIndex((row) => row.includes(`Ask about ${testFile}:2`));
    expect(askLine).toBeGreaterThan(askRows.findIndex((row) => row.includes('▶') && row.includes('expect(createInvoice())')));
    ui.stdin.write('\u001b');
    await tick();
    ui.stdin.write('t');
    await waitFor(() => expect(ui.lastFrame()).toMatch(/n\/p\s+hunk/));
    ui.unmount();
  });
  it('shows all comments in a thread and replies from the selected line', async () => {
    const tour = fixtureTour();
    const hunk = tour.hunks[tour.chapters[0].hunkIds[0]];
    const index = hunk.lines.findIndex((line) => line.kind !== 'ctx');
    const line = hunk.lines[index];
    const oldSide = line.kind === 'del';
    tour.existingThreads = [
      {
        id: 'thread-1',
        path: hunk.file,
        line: oldSide ? undefined : line.newLine,
        originalLine: line.oldLine,
        isResolved: false,
        isOutdated: oldSide,
        comments: [
          { id: '42', author: 'alice', body: 'Could this fail?', createdAt: '' },
          { id: '43', author: 'bob', body: 'I think so.', createdAt: '' },
        ],
      },
    ];
    let reply = '';
    const ui = render(
      <Harness
        tour={tour}
        onDraft={() => {}}
        onState={() => {}}
        onReply={async (body) => {
          reply = body;
        }}
      />,
    );
    await waitFor(() => expect(ui.lastFrame()).toContain('1 review thread · 2 comments · e to read'));
    ui.stdin.write('e');
    await waitFor(() => expect(ui.lastFrame()).toContain('@alice'));
    expect(ui.lastFrame()).toContain('Could this fail?');
    expect(ui.lastFrame()).toContain('@bob');
    expect(ui.lastFrame()).toContain('I think so.');
    ui.stdin.write('y');
    await waitFor(() => expect(ui.lastFrame()).toContain('Reply to review thread'));
    expect(ui.lastFrame()).toContain('Could this fail?');
    expect(ui.lastFrame()).toContain(line.text.trim().slice(0, 20));
    ui.stdin.write('Agreed @al');
    await waitFor(() => expect(ui.lastFrame()).toContain('tab insert · ↑↓ choose'));
    expect(ui.lastFrame()).toContain('@alice');
    ui.stdin.write('\t');
    await tick();
    // Enter asks first; n goes back to the reply, and y posts it.
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('Post this reply on'));
    ui.stdin.write('n');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('Post this reply on'));
    expect(reply).toBe('');
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('Post this reply on'));
    ui.stdin.write('y');
    await waitFor(() => expect(reply).toBe('Agreed @alice'));
    await waitFor(() => expect(ui.lastFrame()).not.toContain('Reply to review thread'));
    expect(ui.lastFrame()).toContain('Reply posted on');
    ui.stdin.write('y');
    await waitFor(() => expect(ui.lastFrame()).toContain('Reply to review thread'));
    expect(ui.lastFrame()).toContain(line.text.trim().slice(0, 20));
    ui.unmount();
  });
  it('suggests repository collaborators in a draft mention', async () => {
    const tour = fixtureTour();
    tour.mentionUsers = ['zoe', 'alex'];
    const ui = render(<Harness tour={tour} onDraft={() => {}} onState={() => {}} />);
    await tick();
    ui.stdin.write('c');
    await tick();
    ui.stdin.write('@zo');
    await waitFor(() => expect(ui.lastFrame()).toContain('@zoe'));
    ui.stdin.write('\t');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('tab insert · ↑↓ choose'));
    expect(ui.lastFrame()).toContain('@zoe ');
    ui.unmount();
  });
  it('shows and opens the briefing shortcut from a hunk or focused tests', async () => {
    const tour = fixtureTour();
    const hunk = tour.hunks[tour.chapters[0].hunkIds[0]];
    hunk.tests = [{ testFile: 'test/invoice.test.ts', testName: 'creates invoice', startLine: 1, lines: ['it("creates invoice", () => {})'], source: 'name-match', confidence: 0.65 }];
    let opened = 0;
    const ui = render(<Harness tour={tour} onDraft={() => {}} onState={() => {}} onBriefing={() => opened++} />);
    await waitFor(() => expect(ui.lastFrame()).toMatch(/esc\s+back/));
    ui.stdin.write('b');
    await waitFor(() => expect(opened).toBe(1));
    ui.stdin.write('t');
    await tick();
    ui.stdin.write('b');
    await waitFor(() => expect(opened).toBe(2));
    ui.unmount();
  });

  it('shows changed YAML keys instead of a pending narration message', async () => {
    const tour = fixtureTour();
    const ci = tour.chapters.findIndex((chapter) => chapter.kind === 'config');
    const ui = render(<Harness tour={tour} startCi={ci} onDraft={() => {}} onState={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Changed keys: port'));
    expect(ui.lastFrame()).not.toContain('Narration is still being written');
    ui.unmount();
  });

  it('keeps test gap details collapsed until requested', async () => {
    const tour = fixtureTour();
    tour.chapters[0].untestedBranches = ['src/routes/invoices.ts:8 — failed invoice creation'];
    const ui = render(<Harness tour={tour} onDraft={() => {}} onState={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('1 possible untested behavior'));
    expect(ui.lastFrame()).not.toContain('failed invoice creation');
    ui.stdin.write('U');
    await waitFor(() => expect(ui.lastFrame()).toContain('failed invoice creation'));
    ui.stdin.write('U');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('failed invoice creation'));
    ui.unmount();
  });

  it('shows questions beside the selected code without hiding the chapter', async () => {
    const tour = fixtureTour();
    const chapter = tour.chapters[0];
    const hunk = tour.hunks[chapter.hunkIds[0]];
    const ui = render(<Harness tour={tour} onDraft={() => {}} onState={() => {}} agent={{ cwd: '/tmp' }} />);
    await tick();
    ui.stdin.write('a');
    await waitFor(() => expect(ui.lastFrame()).toContain('Ask about'));
    expect(ui.lastFrame()).toContain(chapter.title);
    expect(ui.lastFrame()).toContain(hunk.file);
    expect(ui.lastFrame()).toContain(hunk.lines.find((line) => line.kind !== 'ctx')!.text.slice(0, 30));
    expect(ui.lastFrame()).toContain('enter: ask');
    ui.stdin.write('\u001b');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('Ask about'));
    expect(ui.lastFrame()).toContain('hunk 1/');
    ui.unmount();
  });

  it('keeps earlier questions in the thread when asking a follow-up', async () => {
    const tour = fixtureTour();
    const ui = render(
      <BriefingScreen
        tour={tour}
        chapters={tour.chapters}
        order="flow"
        cycleOrder={() => {}}
        states={{}}
        agent={{ cwd: '/tmp' }}
        width={140}
        height={45}
        onStart={() => {}}
        onSubmit={() => {}}
        onQuit={() => {}}
      />,
    );
    await tick();
    ui.stdin.write('a');
    await tick();
    ui.stdin.write('why nullable');
    await tick();
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('enter: follow up'));
    ui.stdin.write('who calls it');
    await tick();
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('2 questions'));
    expect(ui.lastFrame()).toContain('› why nullable');
    expect(ui.lastFrame()).toContain('› who calls it');
    ui.unmount();
  });

  it('walks hunks with n, marks them read, and saves a labelled draft', async () => {
    const tour = fixtureTour();
    let states: States = {};
    const drafts: Draft[] = [];
    const ui = render(<Harness tour={tour} onDraft={(d) => drafts.push(d)} onState={(s) => (states = s)} />);
    const first = tour.chapters[0];
    await waitFor(() => {
      expect(ui.lastFrame()).toContain(first.title.slice(0, 20));
      expect(ui.lastFrame()).toContain(`hunk 1/${first.hunkIds.length}`);
    });

    ui.stdin.write('n');
    await waitFor(() => expect(Object.values(states)).toEqual(['read']));
    expect(ui.lastFrame()).toContain(first.hunkIds.length > 1 ? `hunk 2/${first.hunkIds.length}` : 'hunk 1/');

    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on'));
    ui.stdin.write('\t'); // question -> suggestion
    await tick();
    ui.stdin.write('this leaks if the retry fails?');
    await tick();
    ui.stdin.write('\r');
    await waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0].label).toBe('suggestion');
    expect(drafts[0].body).toBe('this leaks if the retry fails?');
    expect(drafts[0].anchor.type).toBe('line');
    expect(ui.lastFrame()).toContain('Draft saved');
    ui.unmount();
  });

  it('edits and deletes the draft on the selected line', async () => {
    const tour = fixtureTour();
    const drafts: Draft[] = [];
    const deleted: Draft[] = [];
    const ui = render(<Harness tour={tour} onDraft={(d) => drafts.push(d)} onState={() => {}} onDelete={(d) => deleted.push(d)} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('hunk 1/'));

    ui.stdin.write('E');
    await waitFor(() => expect(ui.lastFrame()).toContain('No draft on this line'));

    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on'));
    ui.stdin.write('first take');
    await tick();
    ui.stdin.write('\r');
    await waitFor(() => expect(drafts).toHaveLength(1));
    await waitFor(() => expect(ui.lastFrame()).toContain('edit draft'));

    ui.stdin.write('E');
    await waitFor(() => expect(ui.lastFrame()).toContain('first take'));
    ui.stdin.write('\t'); // question -> suggestion
    await tick();
    ui.stdin.write(' revised');
    await tick();
    ui.stdin.write('\r');
    await waitFor(() => expect(drafts).toHaveLength(2));
    expect(drafts[1].id).toBe(drafts[0].id);
    expect(drafts[1].body).toBe('first take revised');
    expect(drafts[1].label).toBe('suggestion');
    expect(ui.lastFrame()).toContain('Draft updated');

    ui.stdin.write('X');
    await waitFor(() => expect(ui.lastFrame()).toContain('Delete this draft?'));
    ui.stdin.write('n');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('Delete this draft?'));
    expect(deleted).toHaveLength(0);

    ui.stdin.write('X');
    await waitFor(() => expect(ui.lastFrame()).toContain('Delete this draft?'));
    ui.stdin.write('y');
    await waitFor(() => expect(deleted.map((d) => d.id)).toEqual([drafts[0].id]));
    await waitFor(() => expect(ui.lastFrame()).toContain('Draft deleted'));
    ui.unmount();
  });

  it('skips a whole collapsed chapter with x', async () => {
    const tour = fixtureTour();
    const collapsedIdx = tour.chapters.findIndex((c) => c.collapsed);
    expect(collapsedIdx).toBeGreaterThan(-1);
    let states: States = {};
    function Collapsed() {
      const [s, setS] = useState<States>({});
      return (
        <ChapterScreen
          tour={tour}
          chapters={tour.chapters}
          states={s}
          drafts={[]}
          ci={collapsedIdx}
          hi={-1}
          order="flow"
          deltaOnly={false}
          width={150}
          height={40}
          setPos={() => {}}
          setState={(h, st) =>
            setS((p) => {
              states = { ...p, [h.contentHash]: st };
              return states;
            })
          }
          saveDraft={() => {}}
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
    const ui = render(<Collapsed />);
    await waitFor(() => expect(ui.lastFrame()).toContain('collapsed'));
    ui.stdin.write('x');
    const ids = tour.chapters[collapsedIdx].hunkIds;
    await waitFor(() => expect(Object.values(states).filter((v) => v === 'skipped')).toHaveLength(ids.length));
    ui.unmount();
  });
});

describe('ThreadView', () => {
  it('reacts to the selected comment and shows updated counts', async () => {
    let reacted = '';
    function ReactionsHarness() {
      const [threads, setThreads] = useState<ExistingThread[]>([
        {
          id: 'reactions',
          path: 'src/a.ts',
          line: 1,
          isResolved: false,
          isOutdated: false,
          comments: [
            { id: '1', nodeId: 'node-1', author: 'alice', body: 'First', createdAt: '', reactionGroups: [] },
            { id: '2', nodeId: 'node-2', author: 'bob', body: 'Second', createdAt: '', reactionGroups: [] },
          ],
        },
      ]);
      return (
        <ThreadView
          threads={threads}
          width={65}
          height={13}
          mentions={[]}
          onClose={() => {}}
          onReact={async (comment, content, remove) => {
            reacted = `${comment.nodeId}:${content}:${remove}`;
            setThreads((current) =>
              current.map((thread) => ({
                ...thread,
                comments: thread.comments.map((entry) =>
                  entry.nodeId === comment.nodeId ? { ...entry, reactionGroups: remove ? [] : [{ content, reactors: { totalCount: 1 }, viewerHasReacted: true }] } : entry,
                ),
              })),
            );
          }}
        />
      );
    }
    const ui = render(<ReactionsHarness />);
    ui.stdin.write('\t');
    await tick();
    ui.stdin.write('+');
    await waitFor(() => expect(ui.lastFrame()).toContain('React to @bob'));
    ui.stdin.write('5');
    await waitFor(() => expect(reacted).toBe('node-2:HEART:false'));
    expect(ui.lastFrame()).toContain('❤️1*');
    ui.stdin.write('+');
    await tick();
    ui.stdin.write('5');
    await waitFor(() => expect(reacted).toBe('node-2:HEART:true'));
    expect(ui.lastFrame()).not.toContain('❤️1*');
    ui.unmount();
  });

  it('scrolls through a long formatted comment', async () => {
    const ui = render(
      <ThreadView
        threads={[
          {
            id: 'long',
            path: 'src/a.ts',
            line: 1,
            isResolved: false,
            isOutdated: false,
            comments: [{ author: 'alice', body: '<details><summary>Why this matters</summary>\n\n**First point**\n\nSecond point\n\nThird point\n\nFinal point\n</details>', createdAt: '' }],
          },
        ]}
        width={45}
        height={7}
        mentions={[]}
        onClose={() => {}}
      />,
    );
    expect(ui.lastFrame()).toContain('@alice');
    expect(ui.lastFrame()).not.toContain('Final point');
    ui.stdin.write('J');
    await waitFor(() => expect(ui.lastFrame()).toContain('Why this matters'));
    for (let i = 0; i < 5; i++) {
      ui.stdin.write('J');
      await tick();
    }
    await waitFor(() => expect(ui.lastFrame()).toContain('Final point'));
    ui.unmount();
  });
});

describe('progress', () => {
  it('counts collapsed hunks as unread until opened or skipped', () => {
    const tour = fixtureTour();
    const p = progress(tour, {});
    expect(p.unread).toBe(Object.keys(tour.hunks).length);
    expect(p.readLines).toBe(0);
  });
});

describe('chapter order', () => {
  it('sorts by risk or changed-line count, with optional chapters last', () => {
    const tour = fixtureTour();
    const ids = Object.keys(tour.hunks).slice(0, 3);
    const base = tour.chapters[0];
    const chapters = [
      { ...base, id: 'large', hunkIds: [ids[0]], optional: false },
      { ...base, id: 'small', hunkIds: [ids[1]], optional: false },
      { ...base, id: 'optional', hunkIds: [ids[2]], optional: true },
    ];
    tour.hunks[ids[0]].risk = 1;
    tour.hunks[ids[1]].risk = 3;
    tour.hunks[ids[2]].risk = 3;
    tour.hunks[ids[0]].lines = Array(10).fill({ kind: 'add', text: 'x', newLine: 1 });
    tour.hunks[ids[1]].lines = [{ kind: 'add', text: 'x', newLine: 1 }];
    tour.hunks[ids[2]].lines = [{ kind: 'add', text: 'x', newLine: 1 }];
    expect(sortChapters(chapters, tour, 'risk').map((c) => c.id)).toEqual(['small', 'large', 'optional']);
    expect(sortChapters(chapters, tour, 'size').map((c) => c.id)).toEqual(['small', 'large', 'optional']);
  });

  it('keeps the same hunk selected when chapters are reordered or grouped by file', () => {
    const tour = fixtureTour();
    const before = tour.chapters;
    const selected = before[0].hunkIds[0];
    const after = [...before].reverse();
    const pos = positionAfterOrderChange(before, { ci: 0, hi: 0 }, after);
    expect(after[pos.ci].hunkIds[pos.hi]).toBe(selected);
    const file = [{ ...before[0], id: 'file-1', hunkIds: [selected] }];
    const filePos = positionAfterOrderChange(before, { ci: 0, hi: 0 }, file);
    expect(file[filePos.ci].hunkIds[filePos.hi]).toBe(selected);
  });
});

describe('BriefingScreen and SubmitScreen', () => {
  it('summarizes other reviewers and opens their full reviews', async () => {
    const tour = fixtureTour();
    tour.viewer = 'me';
    tour.existingReviews = [
      { id: 1, author: 'me', state: 'COMMENTED', body: 'My own note', submittedAt: '2026-01-01T00:00:00Z', url: 'https://example.com/1' },
      { id: 2, author: 'alice', state: 'CHANGES_REQUESTED', body: 'Please cover the error case.', submittedAt: '2026-01-02T00:00:00Z', url: 'https://example.com/2' },
    ];
    const ui = render(
      <BriefingScreen tour={tour} chapters={tour.chapters} order="flow" cycleOrder={() => {}} states={{}} width={140} height={45} onStart={() => {}} onSubmit={() => {}} onQuit={() => {}} />,
    );
    await waitFor(() => expect(ui.lastFrame()).toContain('Other reviewers'));
    expect(ui.lastFrame()).toContain('@alice');
    expect(ui.lastFrame()).not.toContain('My own note');
    ui.stdin.write('V');
    await waitFor(() => expect(ui.lastFrame()).toContain('reviewer feedback'));
    expect(ui.lastFrame()).toContain('Please cover the error case.');
    ui.unmount();
  });
  it('on your own PR, offers t to go back to its feedback', async () => {
    const tour = fixtureTour();
    let opened = 0;
    const ui = render(
      <BriefingScreen
        tour={tour}
        chapters={tour.chapters}
        order="flow"
        cycleOrder={() => {}}
        states={{}}
        width={140}
        height={45}
        onStart={() => {}}
        onSubmit={() => {}}
        onFeedback={() => opened++}
        onQuit={() => {}}
      />,
    );
    await waitFor(() => expect(ui.lastFrame()).toContain('your feedback'));
    ui.stdin.write('t');
    await waitFor(() => expect(opened).toBe(1));
    ui.unmount();
  });
  it('shows the active chapter order and cycles it with f', async () => {
    const tour = fixtureTour();
    function OrderedBriefing() {
      const [order, setOrder] = useState<ChapterOrder>('flow');
      return (
        <BriefingScreen
          tour={tour}
          chapters={sortChapters(tour.chapters, tour, order)}
          order={order}
          cycleOrder={() => setOrder((o) => ORDER_SEQUENCE[(ORDER_SEQUENCE.indexOf(o) + 1) % ORDER_SEQUENCE.length])}
          states={{}}
          width={140}
          height={45}
          onStart={() => {}}
          onSubmit={() => {}}
          onQuit={() => {}}
        />
      );
    }
    const ui = render(<OrderedBriefing />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Guided order'));
    ui.stdin.write('f');
    await waitFor(() => expect(ui.lastFrame()).toContain('Risk first order'));
    ui.stdin.write('f');
    await waitFor(() => expect(ui.lastFrame()).toContain('Small first order'));
    ui.unmount();
  });

  it('on a re-review, lists unchanged chapters greyed under the changes and D shows the full review', async () => {
    const tour = fixtureTour();
    expect(tour.chapters.length).toBeGreaterThan(1);
    const changed = tour.chapters[0];
    const unchanged = tour.chapters[1];
    tour.rereview = { previousHead: 'c'.repeat(40), newHunkIds: [changed.hunkIds[0]], comments: [] };
    const deltaChapters = tour.chapters.map((c) => ({ ...c, hunkIds: c.hunkIds.filter((id) => tour.rereview!.newHunkIds.includes(id)) })).filter((c) => c.hunkIds.length);
    const toggles: boolean[] = [];
    function ReReviewBriefing() {
      const [deltaOnly, setDeltaOnly] = useState(true);
      return (
        <BriefingScreen
          tour={tour}
          chapters={deltaOnly ? deltaChapters : tour.chapters}
          allChapters={tour.chapters}
          deltaOnly={deltaOnly}
          toggleDelta={() => setDeltaOnly((d) => (toggles.push(!d), !d))}
          order="flow"
          cycleOrder={() => {}}
          states={{}}
          width={140}
          height={45}
          onStart={() => {}}
          onSubmit={() => {}}
          onQuit={() => {}}
        />
      );
    }
    const ui = render(<ReReviewBriefing />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Changes only:'));
    const frame = ui.lastFrame()!;
    expect(frame).toContain(`1 of ${changed.hunkIds.length} hunks changed`);
    expect(frame).toContain(unchanged.title);
    expect(frame).toContain('unchanged');
    // The re-review note sits just above the chapter list, not under the description.
    expect(frame.indexOf('Changes only:')).toBeLessThan(frame.indexOf('Chapters'));
    expect(frame.indexOf('Changes only:')).toBeGreaterThan(frame.indexOf('Adds POST /invoices.'));
    ui.stdin.write('D');
    await waitFor(() => expect(ui.lastFrame()).toContain('Full review:'));
    expect(toggles).toEqual([false]);
    expect(ui.lastFrame()).not.toContain('· unchanged');
    ui.unmount();
  });

  it('on a re-review, the chapter screen badges the header, greys unchanged chapters, and offers D', async () => {
    const tour = fixtureTour();
    const changed = tour.chapters.find((c) => c.hunkIds.length > 1)!;
    const unchanged = tour.chapters.find((c) => c !== changed)!;
    tour.rereview = { previousHead: 'c'.repeat(40), newHunkIds: [changed.hunkIds[0]], comments: [] };
    const deltaChapters = [{ ...changed, hunkIds: [changed.hunkIds[0]] }];
    let toggled = 0;
    const ui = render(
      <ChapterScreen
        tour={tour}
        chapters={deltaChapters}
        allChapters={tour.chapters}
        states={{}}
        drafts={[]}
        ci={0}
        hi={0}
        order="flow"
        deltaOnly
        width={190}
        height={40}
        setPos={() => {}}
        setState={() => {}}
        saveDraft={() => {}}
        deleteDraft={() => {}}
        moveHunk={() => {}}
        toggleOrder={() => {}}
        toggleDelta={() => toggled++}
        openSubmit={() => {}}
        openBriefing={() => {}}
        openInAgent={() => {}}
        quit={() => {}}
      />,
    );
    await waitFor(() => expect(ui.lastFrame()).toContain('changes only'));
    expect(ui.lastFrame()).toContain(unchanged.title.slice(0, 15));
    expect(ui.lastFrame()).toContain(`${changed.hunkIds.length - 1} unchanged hidden`);
    expect(ui.lastFrame()).toContain('full review');
    ui.stdin.write('D');
    await waitFor(() => expect(toggled).toBe(1));
    ui.unmount();
  });

  it('shows PR questions alongside the briefing', async () => {
    const tour = fixtureTour();
    const ui = render(
      <BriefingScreen tour={tour} chapters={tour.chapters} order="flow" cycleOrder={() => {}} states={{}} width={140} height={45} onStart={() => {}} onSubmit={() => {}} onQuit={() => {}} />,
    );
    await tick();
    ui.stdin.write('a');
    await waitFor(() => expect(ui.lastFrame()).toContain('Ask about the whole PR'));
    expect(ui.lastFrame()).toContain('Chapters');
    ui.unmount();
  });

  it('renders the briefing with chapters and flags', async () => {
    const tour = fixtureTour();
    let started: number | undefined = -1;
    const ui = render(
      <BriefingScreen
        tour={tour}
        chapters={tour.chapters}
        order="flow"
        cycleOrder={() => {}}
        states={{}}
        width={140}
        height={45}
        onStart={(c) => (started = c)}
        onSubmit={() => {}}
        onQuit={() => {}}
      />,
    );
    await waitFor(() => expect(ui.lastFrame()).toContain('Adds POST /invoices.'));
    expect(ui.lastFrame()).toContain('Chapters');
    ui.stdin.write('n');
    await waitFor(() => expect(started).toBeUndefined());
    ui.unmount();
  });

  it('suggests a verdict and asks for confirmation before posting', async () => {
    const tour = fixtureTour();
    const h = Object.values(tour.hunks)[0];
    const line = h.lines.find((l) => l.kind === 'add')!.newLine!;
    const draft: Draft = {
      id: 'd1',
      repo: tour.repo,
      pr: tour.pr,
      headSha: tour.headSha,
      anchor: { type: 'line', hunkId: h.id, file: h.file, line, side: 'RIGHT' },
      label: 'blocking',
      body: 'This drops the error.',
      posted: false,
      createdAt: new Date().toISOString(),
    };
    const ui = render(
      <SubmitScreen tour={tour} chapters={tour.chapters} states={{}} drafts={[draft]} width={140} height={40} onEdit={() => {}} onDelete={() => {}} onPosted={() => {}} onBack={() => {}} />,
    );
    await waitFor(() => expect(ui.lastFrame()).toContain('Suggested: Request changes'));
    expect(ui.lastFrame()).toContain('This drops the error.');
    ui.stdin.write('P');
    await waitFor(() => expect(ui.lastFrame()).toContain('esc cancel'));
    ui.stdin.write('n'); // cancel: nothing posts
    await waitFor(() => expect(ui.lastFrame()).not.toContain('esc cancel'));
    expect(ui.lastFrame()).not.toContain('Posting');
    ui.unmount();
  });

  it('enter confirms posting, since yes is the default', async () => {
    const tour = fixtureTour();
    let posted: string | undefined;
    const ui = render(
      <SubmitScreen
        tour={tour}
        chapters={tour.chapters}
        states={{}}
        drafts={[]}
        width={140}
        height={40}
        onEdit={() => {}}
        onDelete={() => {}}
        onPosted={(_ids, review) => (posted = review.url)}
        onBack={() => {}}
      />,
    );
    await waitFor(() => expect(ui.lastFrame()).toContain('Submit review'));
    ui.stdin.write('P');
    await waitFor(() => expect(ui.lastFrame()).toContain('esc cancel'));
    ui.stdin.write('\r');
    await waitFor(() => expect(posted).toBe('https://example.test/review/1'));
    ui.unmount();
  });
});

describe('optional import chapter', () => {
  it('n steps past it; ] still opens it', async () => {
    const t = fixtureTour();
    const flowIdx = t.chapters.findIndex((c) => c.kind === 'flow');
    const imp = Object.values(t.hunks).find((h) => !t.chapters[flowIdx].hunkIds.includes(h.id))!;
    imp.importOnly = true;
    t.chapters = t.chapters.map((c) => ({ ...c, hunkIds: c.hunkIds.filter((id) => id !== imp.id) })).filter((c) => c.hunkIds.length);
    const fi = t.chapters.findIndex((c) => c.kind === 'flow');
    t.chapters.splice(fi + 1, 0, {
      id: 'imports',
      kind: 'imports',
      title: 'Import-only changes',
      risk: 0,
      hunkIds: [imp.id],
      linkedHunkIds: [],
      orphanReasons: {},
      untestedBranches: [],
      collapsed: true,
      optional: true,
    });
    const seen: [number, number][] = [];
    const last = t.chapters[fi].hunkIds.length - 1;
    const ui = render(
      <ChapterScreen
        tour={t}
        chapters={t.chapters}
        states={{}}
        drafts={[]}
        ci={fi}
        hi={last}
        order="flow"
        deltaOnly={false}
        width={150}
        height={40}
        setPos={(ci, hi) => seen.push([ci, hi])}
        setState={() => {}}
        saveDraft={() => {}}
        deleteDraft={() => {}}
        moveHunk={() => {}}
        toggleOrder={() => {}}
        toggleDelta={() => {}}
        openSubmit={() => {}}
        openBriefing={() => {}}
        openInAgent={() => {}}
        quit={() => {}}
      />,
    );
    await tick();
    ui.stdin.write('n');
    await waitFor(() => {
      if (fi + 2 < t.chapters.length) expect(seen.at(-1)?.[0]).toBe(fi + 2);
      else expect(ui.lastFrame()).toContain('Import-only changes are optional');
    });
    ui.stdin.write(']');
    await waitFor(() => expect(seen.at(-1)![0]).toBe(fi + 1));
    ui.unmount();
  });
});

describe('team checklist in the chapter screen', () => {
  function setup(services: Partial<import('../src/tui/ChapterScreen.js').Services> = {}) {
    const t = fixtureTour();
    const ci = t.chapters.findIndex((c) => c.kind === 'flow');
    t.chapters[ci].checklist = [{ id: 'ck_1', item: 'Migrations are reversible', pattern: 'db/**', status: 'fail', reason: 'down() is empty (db/1.sql:3)' }];
    const confirms: Record<string, boolean> = {};
    const calls: string[] = [];
    const svc = {
      root: '/tmp/none',
      confirms,
      setConfirm: (id: string, v: boolean) => {
        confirms[id] = v;
        calls.push(`confirm:${id}:${v}`);
      },
      ...services,
    };
    const ui = render(
      <ChapterScreen
        tour={t}
        chapters={t.chapters}
        states={{}}
        drafts={[]}
        ci={ci}
        hi={0}
        order="flow"
        deltaOnly={false}
        width={150}
        height={40}
        setPos={() => {}}
        setState={() => {}}
        saveDraft={() => {}}
        deleteDraft={() => {}}
        moveHunk={() => {}}
        toggleOrder={() => {}}
        toggleDelta={() => {}}
        openSubmit={() => {}}
        openBriefing={() => {}}
        openInAgent={() => {}}
        quit={() => {}}
        services={svc}
      />,
    );
    return { ui, calls, confirms };
  }

  it('i opens the team checklist and space confirms an item', async () => {
    const { ui, calls } = setup();
    await waitFor(() => expect(ui.lastFrame()).toContain('Team checklist: 1 item to confirm'));
    ui.stdin.write('i');
    await waitFor(() => expect(ui.lastFrame()).toContain('Migrations are reversible'));
    expect(ui.lastFrame()).toContain('down() is empty');
    ui.stdin.write(' ');
    await waitFor(() => expect(calls).toContain('confirm:ck_1:true'));
    ui.unmount();
  });
});

describe('lazy @mention users', () => {
  it('loads collaborators only when a comment editor opens, and offers them', async () => {
    const t = fixtureTour();
    t.mentionUsers = undefined;
    let loads = 0;
    const ui = render(
      <ChapterScreen
        tour={t}
        chapters={t.chapters}
        states={{}}
        drafts={[]}
        ci={t.chapters.findIndex((c) => c.kind === 'flow')}
        hi={0}
        order="flow"
        deltaOnly={false}
        width={150}
        height={40}
        setPos={() => {}}
        setState={() => {}}
        saveDraft={() => {}}
        deleteDraft={() => {}}
        moveHunk={() => {}}
        toggleOrder={() => {}}
        toggleDelta={() => {}}
        openSubmit={() => {}}
        openBriefing={() => {}}
        openInAgent={() => {}}
        quit={() => {}}
        services={{
          root: '/tmp/none',
          confirms: {},
          setConfirm: () => {},
          loadMentionUsers: async () => {
            loads++;
            return ['zed-collaborator'];
          },
        }}
      />,
    );
    await tick();
    expect(loads).toBe(0);
    ui.stdin.write('c');
    await waitFor(() => expect(loads).toBe(1));
    await waitFor(() => expect(ui.lastFrame()).toContain('enter: save draft'));
    ui.stdin.write('@zed');
    await waitFor(() => expect(ui.lastFrame()).toContain('zed-collaborator'));
    expect(loads).toBe(1);
    ui.unmount();
  });
});

describe('terminal escape injection', () => {
  const OSC52 = '\u001b]52;c;Y3VybCBodHRwczovL2V2aWwuZXhhbXBsZS94fHNo\u0007';
  const CLEAR = '\u009b2J';
  // Drop the sequences the app itself emits (SGR styling and OSC 8 links); nothing else
  // that can drive the terminal may remain.
  const leftover = (frame: string) => frame.replace(/\u001b\[[0-9;]*m/g, '').replace(/\u001b\]8;;[^\u0007\u001b]*\u0007/g, '');
  // Ink consumes unknown OSC sequences in its own output, so assert both that nothing
  // dangerous remains and (in the tests) that the payload shows up as plain text.
  const assertInert = (frame: string) => {
    expect(frame).not.toContain('\u001b]52');
    expect(frame).not.toMatch(/[\u0080-\u009f]/);
    expect(leftover(frame)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
  };

  function evilTour(): Tour {
    const t = fixtureTour();
    t.title = `Fix typo ${OSC52} ${CLEAR}`;
    t.author = `dev${OSC52}`;
    t.description = `Body ${OSC52} and ${CLEAR} here.\n\n![shot](https://img.example/a.png)\n\n<img src="https://img.example/b\u009d.png" alt="x${OSC52}">`;
    t.chapters[0] = { ...t.chapters[0], title: `Chapter ${OSC52}${CLEAR}` };
    t.notes = [`note ${CLEAR}`];
    t.viewer = 'me';
    t.existingReviews = [{ id: 9, author: `mallory${CLEAR}`, state: 'COMMENTED', body: `review ${OSC52}`, submittedAt: '2026-01-01T00:00:00Z', url: 'https://example.com/9' }];
    return t;
  }

  it('renders an attacker-controlled PR on the briefing without injecting sequences', async () => {
    const t = evilTour();
    const ui = render(
      <BriefingScreen tour={t} chapters={t.chapters} order="flow" cycleOrder={() => {}} states={{}} width={140} height={45} onStart={() => {}} onSubmit={() => {}} onQuit={() => {}} />,
    );
    await waitFor(() => expect(ui.lastFrame()).toContain('Fix typo'));
    const frame = ui.lastFrame()!;
    expect(frame).toContain('Body ]52;c;');
    expect(frame).toContain('Chapter ]52;c;');
    expect(frame).toContain('\u001b]8;;https://img.example/a.png\u0007'); // the app's own OSC 8 link survives
    assertInert(frame);
    ui.stdin.write('r');
    await waitFor(() => expect(ui.lastFrame()).toContain('from the author'));
    expect(ui.lastFrame()).toContain('[image: x52;c;'); // brackets in alt text are dropped
    assertInert(ui.lastFrame()!);
    ui.unmount();
  });

  it('renders an attacker-controlled PR on a chapter without injecting sequences', async () => {
    const t = evilTour();
    t.hunks[t.chapters[0].hunkIds[0]].narration = `Narration ${OSC52} ${CLEAR}`;
    const ui = render(<Harness tour={t} onDraft={() => {}} onState={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Narration'));
    // Stripping ESC leaves the payload as visible, inert text; this proves each path ran
    // through sanitizeTerminal (an unsanitized OSC would be consumed whole, never shown).
    expect(ui.lastFrame()).toContain('Fix typo ]52;c;');
    expect(ui.lastFrame()).toContain('Chapter ]52;c;');
    expect(ui.lastFrame()).toContain('Narration ]52;c;');
    assertInert(ui.lastFrame()!);
    ui.unmount();
  });
});

describe('feedback round: guide, tests, inline comments, description', () => {
  const screen = (t: Tour, hi = 0, width = 100) => (
    <ChapterScreen
      tour={t}
      chapters={t.chapters}
      states={{}}
      drafts={[]}
      ci={t.chapters.findIndex((c) => c.kind === 'flow')}
      hi={hi}
      order="flow"
      deltaOnly={false}
      width={width}
      height={40}
      setPos={() => {}}
      setState={() => {}}
      saveDraft={() => {}}
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

  it('keeps a filename-only test guess in the expanded warning', async () => {
    const t = fixtureTour();
    const h = t.hunks[t.chapters.find((c) => c.kind === 'flow')!.hunkIds[0]];
    h.tests = [{ testFile: 'src/x.test.ts', testName: 'x.test.ts', startLine: 1, lines: ['describe("x", () => {'], source: 'naming', confidence: 0.4 }];
    h.coverage = 'partial';
    h.narration = 'Creates the invoice and hands it to the repository.';
    const ui = render(screen(t));
    await waitFor(() => expect(ui.lastFrame()).toContain('No linked test'));
    expect(ui.lastFrame()).not.toContain('Nearest test file by name');
    ui.stdin.write('U');
    await waitFor(() => expect(ui.lastFrame()).toContain('No linked test case found'));
    const guide = ui
      .lastFrame()!
      .split('\n')
      .map((r) => r.split('│')[1] ?? '')
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(guide).toContain('Nearest test file by name: src/x.test.ts');
    expect(ui.lastFrame()).not.toContain('describe("x"');
    expect(ui.lastFrame()).toContain('Creates the invoice');
    ui.unmount();
  });

  it('hides whitespace-only changes by default, keeps real ones, and w shows them', async () => {
    const h = hunkFromDiff('src/a.ts', ' if (x) {', '-go();', '-stop();', '+  go();', '+  halt();', ' }');
    const t = makeTour([h], [{ hunkIds: [h.id] }], { files: filesFor([h]) });
    const ui = render(screen(t));
    await waitFor(() => expect(ui.lastFrame()).toContain('~   go();'));
    expect(ui.lastFrame()).not.toContain('- go();');
    expect(ui.lastFrame()).toContain('- stop();');
    expect(ui.lastFrame()).toContain('+   halt();');
    ui.stdin.write('w');
    await waitFor(() => expect(ui.lastFrame()).toContain('- go();'));
    ui.stdin.write('w');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('- go();'));
    ui.unmount();
  });

  it('shows a line that only gains words once, as the added line', async () => {
    const h = hunkFromDiff('src/a.ts', ' x', '-total = price;', '+total = price * qty;', ' y');
    const t = makeTour([h], [{ hunkIds: [h.id] }], { files: filesFor([h]) });
    const ui = render(screen(t));
    await waitFor(() => expect(ui.lastFrame()).toContain('+ total = price * qty;'));
    expect(ui.lastFrame()).not.toContain('-total = price;');
    // Old and new line numbers both show on the folded line.
    expect(ui.lastFrame()).toMatch(/2 +2 │ \+ total = price \* qty;/);
    ui.unmount();
  });

  it('keeps help on the key bar at any width and shows modes that are on', async () => {
    const h = hunkFromDiff('src/a.ts', '-go();', '+stop();');
    const t = makeTour([h], [{ hunkIds: [h.id] }], { files: filesFor([h]) });
    const ui = render(screen(t, 0, 60));
    await waitFor(() => expect(ui.lastFrame()).toMatch(/\? keys\s*$/m));
    // Too narrow for any hint beside the modes and help: the bar says how many it left out.
    expect(ui.lastFrame()).toMatch(/\+\d+ more/);
    expect(ui.lastFrame()).toContain('whitespace hidden');
    ui.stdin.write('w');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('whitespace hidden'));
    expect(ui.lastFrame()).toContain('n/p hunk');
    expect(ui.lastFrame()).not.toContain('e thread');
    expect(ui.lastFrame()).toMatch(/\? keys\s*$/m);
    ui.unmount();
  });

  it('offers e and y only on a line with a review thread', async () => {
    const h = hunkFromDiff('src/a.ts', '+one();', '+two();');
    const t = makeTour([h], [{ hunkIds: [h.id] }], { files: filesFor([h]) });
    t.existingThreads = [{ id: 't1', path: 'src/a.ts', line: 2, isResolved: false, isOutdated: false, comments: [{ id: '1', author: 'alice', body: 'Why?', createdAt: '' }] }];
    const ui = render(<Harness tour={t} onDraft={() => {}} onState={() => {}} onReply={async () => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('n/p hunk'));
    expect(ui.lastFrame()).not.toContain('e thread');
    expect(ui.lastFrame()).not.toContain('y reply');
    ui.stdin.write('j');
    await waitFor(() => expect(ui.lastFrame()).toContain('e thread'));
    expect(ui.lastFrame()).toContain('y reply');
    ui.stdin.write('k');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('e thread'));
    ui.unmount();
  });

  it('says so when a hunk only changes whitespace', async () => {
    const h = hunkFromDiff('src/a.ts', '-go();', '+  go();');
    const t = makeTour([h], [{ hunkIds: [h.id] }], { files: filesFor([h]) });
    const ui = render(screen(t));
    await waitFor(() => expect(ui.lastFrame()).toContain('whitespace-only changes hidden'));
    ui.unmount();
  });

  it('opens the comment editor inline under the selected line', async () => {
    const t = fixtureTour();
    const ui = render(screen(t));
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('Comment on'));
    const frame = ui.lastFrame()!;
    const rows = frame.split('\n');
    const cursorRow = rows.findIndex((r) => r.includes('▶'));
    const editorRow = rows.findIndex((r) => r.includes('Comment on'));
    expect(cursorRow).toBeGreaterThan(-1);
    expect(editorRow).toBeGreaterThan(cursorRow);
    expect(editorRow - cursorRow).toBeLessThanOrEqual(2);
    ui.unmount();
  });

  it('shows the author description on the briefing and r opens it in full', async () => {
    const t = fixtureTour();
    t.description = '<!-- template -->\nAdds invoices.\n\n![img](x.png)\nSee [the doc](https://example.com).\n' + Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
    const ui = render(
      <BriefingScreen tour={t} chapters={t.chapters} order="flow" cycleOrder={() => {}} states={{}} width={100} height={40} onStart={() => {}} onSubmit={() => {}} onQuit={() => {}} />,
    );
    await waitFor(() => expect(ui.lastFrame()).toContain('From the author'));
    expect(ui.lastFrame()).toContain('Adds invoices.');
    expect(ui.lastFrame()).not.toContain('template');
    expect(ui.lastFrame()).toContain('See the doc (example.com).');
    expect(ui.lastFrame()).toContain('r to read it all');
    ui.stdin.write('r');
    await waitFor(() => expect(ui.lastFrame()).toContain('from the author'));
    ui.unmount();
  });
});

describe('split view, test pane toggle and expanded context', () => {
  const screen = (t: Tour, extra: Partial<React.ComponentProps<typeof ChapterScreen>> = {}) => (
    <ChapterScreen
      tour={t}
      chapters={t.chapters}
      states={{}}
      drafts={[]}
      ci={0}
      hi={0}
      order="flow"
      deltaOnly={false}
      width={150}
      height={40}
      setPos={() => {}}
      setState={() => {}}
      saveDraft={() => {}}
      deleteDraft={() => {}}
      moveHunk={() => {}}
      toggleOrder={() => {}}
      toggleDelta={() => {}}
      openSubmit={() => {}}
      openBriefing={() => {}}
      openInAgent={() => {}}
      quit={() => {}}
      {...extra}
    />
  );

  it('folds the push notice into the header on esc, then goes back to the briefing, and shows narration quietly', async () => {
    const h = hunkFromDiff('src/a.ts', '-go();', '+stop();');
    const t = makeTour([h], [{ hunkIds: [h.id] }], { files: filesFor([h]) });
    let briefing = 0;
    const ui = render(screen(t, { banner: '▲ The author pushed abcd1234', busy: 'narrating 3/7', openBriefing: () => briefing++ }));
    await waitFor(() => expect(ui.lastFrame()).toContain('The author pushed abcd1234 · esc hides this'));
    expect(ui.lastFrame()!.split('\n')[0]).toContain('narrating 3/7');
    ui.stdin.write('\u001b');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('The author pushed'));
    expect(ui.lastFrame()!.split('\n')[0]).toContain('↑ new head · R');
    expect(briefing).toBe(0);
    ui.stdin.write('\u001b');
    await waitFor(() => expect(briefing).toBe(1));
    ui.unmount();
  });

  it('S shows the old line beside its replacement, and back', async () => {
    const h = hunkFromDiff('src/a.ts', ' keep();', '-const total = price;', '+const total = price * quantity - discount;', ' done();');
    const t = makeTour([h], [{ hunkIds: [h.id] }], { files: filesFor([h]) });
    const ui = render(screen(t));
    await waitFor(() => expect(ui.lastFrame()).toContain('+ const total = price * quantity'));
    expect(
      ui
        .lastFrame()!
        .split('\n')
        .some((r) => r.includes('-const total = price;') && r.includes('+const total')),
    ).toBe(false);
    ui.stdin.write('S');
    await waitFor(() =>
      expect(
        ui
          .lastFrame()!
          .split('\n')
          .some((r) => r.includes('- const total = price;') && r.includes('+ const total = price * quantity')),
      ).toBe(true),
    );
    expect(ui.lastFrame()).toContain('split');
    ui.stdin.write('S');
    await waitFor(() =>
      expect(
        ui
          .lastFrame()!
          .split('\n')
          .some((r) => r.includes('-const total = price;') && r.includes('+const total')),
      ).toBe(false),
    );
    ui.unmount();
  });

  it('T hides the test pane beside the code and t still opens the tests', async () => {
    const t = fixtureTour();
    const ci = t.chapters.findIndex((c) => c.hunkIds.some((id) => t.hunks[id].tests.some((x) => x.source !== 'naming')));
    const hi = t.chapters[ci].hunkIds.findIndex((id) => t.hunks[id].tests.some((x) => x.source !== 'naming'));
    const ui = render(screen(t, { ci, hi }));
    await waitFor(() => expect(ui.lastFrame()).toMatch(/Tests\s/));
    expect(ui.lastFrame()).not.toContain('· t ');
    ui.stdin.write('T');
    await waitFor(() => expect(ui.lastFrame()).toMatch(/◂ \d+ tests? · t/));
    expect(ui.lastFrame()).not.toMatch(/│ Tests/);
    ui.stdin.write('t');
    await waitFor(() => expect(ui.lastFrame()).toContain('back to code'));
    ui.unmount();
  });

  it('+ shows more of the file around the hunk, dimmed and not commentable, and - takes it away', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-ctx-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/a.ts'), Array.from({ length: 30 }, (_, i) => (i === 10 ? 'changed();' : `l${i + 1}();`)).join('\n') + '\n');
    const h = hunkFromDiff('src/a.ts', ' l10();', '-old();', '+changed();', ' l12();');
    for (const l of h.lines) {
      if (l.oldLine) l.oldLine += 9;
      if (l.newLine) l.newLine += 9;
    }
    const t = makeTour([h], [{ hunkIds: [h.id] }], { files: filesFor([h]) });
    const ui = render(screen(t, { services: { root, confirms: {}, setConfirm: () => {} } }));
    await waitFor(() => expect(ui.lastFrame()).toContain('changed();'));
    expect(ui.lastFrame()).not.toContain('l5();');
    ui.stdin.write('+');
    await waitFor(() => expect(ui.lastFrame()).toContain('l5();'));
    expect(ui.lastFrame()).toContain('l1();');
    expect(ui.lastFrame()).toContain('l22();');
    // The cursor stays on the changed line.
    expect(
      ui
        .lastFrame()!
        .split('\n')
        .find((r) => r.includes('▶')),
    ).toContain('- old();');
    for (let i = 0; i < 9; i++) ui.stdin.write('k');
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('outside the PR’s diff'));
    ui.stdin.write('-');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('l5();'));
    ui.unmount();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('shows a tests tab at the top right when the terminal is too narrow for them beside the code', async () => {
    const t = fixtureTour();
    const ci = t.chapters.findIndex((c) => c.hunkIds.some((id) => t.hunks[id].tests.some((x) => x.source !== 'naming')));
    const hi = t.chapters[ci].hunkIds.findIndex((id) => t.hunks[id].tests.some((x) => x.source !== 'naming'));
    const ui = render(screen(t, { ci, hi, width: 100 }));
    await waitFor(() => expect(ui.lastFrame()).toMatch(/◂ \d+ tests? · t\s*$/m));
    // On the title row, right-aligned with the hunk counter.
    expect(
      ui
        .lastFrame()!
        .split('\n')
        .find((r) => r.includes('◂')),
    ).toContain('· hunk');
    ui.stdin.write('t');
    await waitFor(() => expect(ui.lastFrame()).toContain('back to code'));
    expect(ui.lastFrame()).not.toContain('◂');
    ui.unmount();
  });

  it('refuses a comment range that crosses dimmed lines between fused hunks', async () => {
    const h = hunkFromDiff('src/a.ts', ' a();', '-b();', '+B();', ' c();', ' gap();', ' d();', '-e();', '+E();', ' f();');
    h.lines[4].expanded = true;
    const t = makeTour([h], [{ hunkIds: [h.id] }], { files: filesFor([h]) });
    const ui = render(screen(t));
    await waitFor(() => expect(ui.lastFrame()).toContain('+ B();'));
    ui.stdin.write('v');
    await tick();
    for (let i = 0; i < 5; i++) ui.stdin.write('j');
    await tick();
    ui.stdin.write('c');
    await waitFor(() => expect(ui.lastFrame()).toContain('crosses dimmed lines'));
    expect(ui.lastFrame()).not.toContain('Comment on');
    ui.unmount();
  });

  it('gives two blocks moved to different places a note each', async () => {
    const h = hunkFromDiff('src/a.ts', ' a();', '-one(block);', '-two(block);', '-three(block);', '-four(block);', '-five(block);', '-six(block);', ' b();');
    h.lines.forEach((l, i) => l.kind === 'del' && (l.moved = i <= 3 ? movedTo('src/x.ts', 10 + i) : movedTo('src/y.ts', 50 + i)));
    const t = makeTour([h], [{ hunkIds: [h.id] }], { files: filesFor([h]) });
    const ui = render(screen(t));
    await waitFor(() => expect(ui.lastFrame()).toContain('3 lines moved to src/x.ts:11'));
    expect(ui.lastFrame()).toContain('3 lines moved to src/y.ts:54');
    ui.unmount();
  });

  it('says when a file is too large to read more of', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-ctx-'));
    fs.mkdirSync(path.join(root, 'src'));
    // Just over 1 MB, the read limit for context. Plain text keeps highlighting out of the test.
    fs.writeFileSync(path.join(root, 'src/big.txt'), 'x();\n'.repeat(210_000));
    const h = hunkFromDiff('src/big.txt', ' x();', '+y();', ' x();');
    const t = makeTour([h], [{ hunkIds: [h.id] }], { files: filesFor([h]) });
    const ui = render(screen(t, { services: { root, confirms: {}, setConfirm: () => {} } }));
    await waitFor(() => expect(ui.lastFrame()).toContain('+ y();'));
    ui.stdin.write('+');
    await waitFor(() => expect(ui.lastFrame()).toContain('over 1 MB'));
    ui.unmount();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('says a new file has no context to add', async () => {
    const h = hunkFromDiff('src/new.ts', '+a();', '+b();');
    const t = makeTour([h], [{ hunkIds: [h.id] }], { files: filesFor([h], {}, { 'src/new.ts': 'added' }) });
    // No checkout needed: a new file has no context whether or not one is ready.
    const ui = render(screen(t));
    await waitFor(() => expect(ui.lastFrame()).toContain('+ b();'));
    ui.stdin.write('+');
    await waitFor(() => expect(ui.lastFrame()).toContain('this file is new'));
    ui.unmount();
  });

  it('says where a moved block went', async () => {
    const h = hunkFromDiff('src/a.ts', ' a();', '-first(block);', '-second(block);', '-third(block);', ' b();');
    h.lines.forEach((l, i) => l.kind === 'del' && (l.moved = movedTo('src/a.ts', 40 + i)));
    const t = makeTour([h], [{ hunkIds: [h.id] }], { files: filesFor([h]) });
    const ui = render(screen(t));
    await waitFor(() => expect(ui.lastFrame()).toContain('3 lines moved to line 41'));
    ui.unmount();
  });

  it('gives one note to a move split by a small edit', async () => {
    const h = hunkFromDiff('src/loans.go', '-open(path);', '-check(err);', '-defer close();', '-rows := read(file);', '-check(rows);', '-guard(empty);', '-index := -1');
    // Lines 1-3 went to 27-29 and lines 5-7 to 32-34; line 4 was rewritten in between.
    h.lines.forEach((l, i) => i !== 3 && (l.moved = { ...movedTo('src/loanids.go', i < 3 ? 27 + i : 28 + i), kind: 'merged', also: [{ file: 'src/ratios.go', line: 9, side: 'del' }] }));
    const ui = render(screen(makeTour([h], [{ hunkIds: [h.id] }], { files: filesFor([h]) })));
    await waitFor(() => expect(ui.lastFrame()).toContain('6 lines merged into src/loanids.go:27, split by 1 other line; also removed at src/ratios.go:9'));
    expect(ui.lastFrame()).not.toContain('3 lines merged');
    ui.unmount();
  });

  it('says how a moved block changed: its indent, a reindent in place, a copy, or a merge', async () => {
    const lines = (file: string) => hunkFromDiff(file, ' a();', '-first(block);', '-second(block);', '-third(block);', ' b();');
    const cases: [Hunk, (i: number) => MovedTo, string][] = [
      [lines('src/a.ts'), (i) => ({ ...movedTo('src/b.ts', 40 + i), indent: -4 }), '3 lines moved to src/b.ts:41, indent −4'],
      [lines('src/c.ts'), (i) => ({ ...movedTo('src/c.ts', 2 + i), kind: 'reindented', indent: 2 }), '3 lines re-indented in place (indent +2), now line 3'],
      [lines('src/d.ts'), (i) => ({ ...movedTo('src/e.ts', 10 + i), kind: 'copied', also: [{ file: 'src/f.ts', line: 20, side: 'add' }] }), '3 lines copied to src/e.ts:11; also added at src/f.ts:20'],
      [
        lines('src/g.ts'),
        (i) => ({ ...movedTo('src/h.ts', 10 + i), kind: 'merged', also: [{ file: 'src/i.ts', line: 30, side: 'del' }] }),
        '3 lines merged into src/h.ts:11; also removed at src/i.ts:30',
      ],
    ];
    for (const [h, at, note] of cases) {
      h.lines.forEach((l, i) => l.kind === 'del' && (l.moved = at(i)));
      const ui = render(screen(makeTour([h], [{ hunkIds: [h.id] }], { files: filesFor([h]) })));
      await waitFor(() => expect(ui.lastFrame()).toContain(note));
      ui.unmount();
    }
  });
});

function movedTo(file: string, line: number): MovedTo {
  return { file, line, kind: 'moved', indent: 0, also: [] };
}
