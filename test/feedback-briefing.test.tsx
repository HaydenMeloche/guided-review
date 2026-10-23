import { describe, expect, it } from 'vitest';
import type { FeedbackChapter } from '../src/review/feedback.js';
import { render } from 'ink-testing-library';
import { FeedbackBriefing } from '../src/tui/author/FeedbackBriefing.js';
import { buildFeedback, groupFeedback, reviewerStatus } from '../src/review/feedback.js';
import { hunk, tour as makeTour } from './fixtures/tour.js';

const h = hunk('h1', 'src/pay.ts', [{ kind: 'add', text: 'x', newLine: 2 }]);
const tour = makeTour([h], [{ id: 'c0', title: 'Retry failed payments', hunkIds: ['h1'] }], {
  repo: 'acme/pay',
  pr: 4,
  title: 'Retry payments',
  author: 'dev',
  headSha: 'head1234',
  mode: 'agent',
  intent: 'Retries failed card payments up to three times with backoff, so a brief outage at the provider no longer fails the checkout.',
  description: 'This adds retries.\n\n- three attempts\n- 200ms backoff\n\nCloses #12.',
});
const threads = [1, 2, 3].map((n) => ({
  id: `T${n}`,
  path: 'src/pay.ts',
  line: 2,
  originalLine: 2,
  originalCommit: 'head1234',
  isResolved: false,
  isOutdated: false,
  comments: [{ author: 'ann', body: 'Why?', createdAt: '2026-10-01T00:00:00Z' }],
}));
const reviews = [
  { id: 1, author: 'ann', state: 'CHANGES_REQUESTED', body: 'Look at retries.', submittedAt: '2026-10-01T00:00:00Z', url: 'u' },
  { id: 2, author: 'bob', state: 'APPROVED', body: '', submittedAt: '2026-10-02T00:00:00Z', url: 'u' },
];
const items = buildFeedback(tour, threads, { author: 'dev', diffs: new Map() });
const noop = () => {};
const themes = [
  { text: 'Two reviewers question the retry policy in pay.ts and whether three attempts is too many for the provider limits', threadIds: ['T1', 'T2'] },
  { text: 'Naming nits in the migration', threadIds: ['T3'] },
];

function frame(width: number, height: number, extra: Partial<Parameters<typeof FeedbackBriefing>[0]> = {}): string[] {
  const ui = render(
    <FeedbackBriefing
      tour={tour}
      items={items}
      groups={groupFeedback(items, tour.chapters)}
      reviewers={reviewerStatus(reviews, 'dev')}
      reviews={reviews}
      comments={[{ id: 1, author: 'c', body: 'hi', createdAt: '', url: '' }]}
      queued={1}
      showHidden={false}
      silent={0}
      notes={[]}
      themes={themes}
      writing="Writing the summary and chapter titles…"
      width={width}
      height={height}
      active
      onStart={noop}
      onSend={noop}
      onToggleHidden={noop}
      onFullTour={noop}
      onRefresh={noop}
      onQuit={noop}
      {...extra}
    />,
  );
  const lines = ui.lastFrame()!.split('\n');
  ui.unmount();
  return lines;
}

describe('the feedback briefing', () => {
  it('puts the PR on the left and the feedback on the right on a wide terminal', () => {
    const lines = frame(140, 30);
    expect(lines).toHaveLength(30);
    const row = lines.find((l) => l.includes('Retries failed card payments'))!;
    expect(row).toContain('Reviews');
    expect(lines.some((l) => l.includes('From you'))).toBe(true);
    expect(lines.some((l) => /Retry failed payments · pay\.ts .*3 thread\(s\)/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes('│ Themes'))).toBe(true);
    expect(lines.some((l) => l.trimEnd().endsWith('limits (2)'))).toBe(true);
    expect(lines.some((l) => l.includes('Writing the summary'))).toBe(true);
  });

  it('lists failing and running checks by name beside the feedback, and passing ones as a count', () => {
    const items = [
      { name: 'test (ubuntu)', state: 'failed' as const, outcome: 'FAILURE', required: true, workflow: 'CI', jobId: 1 },
      { name: 'lint', state: 'pending' as const, outcome: 'IN_PROGRESS', required: false, workflow: 'CI' },
      { name: 'build', state: 'passed' as const, outcome: 'SUCCESS', required: false, workflow: 'CI' },
      { name: 'docs', state: 'skipped' as const, outcome: 'SKIPPED', required: false },
    ];
    const lines = frame(140, 34, { checks: { passed: 2, failed: 1, pending: 1, failedNames: ['test (ubuntu)'], requiredFailed: [], requiredPending: [], items }, onChecks: noop });
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    expect(at(/│ Checks · c to view them and their logs/)).toBeGreaterThan(at(/│ Reviews/));
    expect(lines[at(/Checks · c/) + 1]).toMatch(/✗ CI \/ test \(ubuntu\) failed · required/);
    expect(lines[at(/Checks · c/) + 2]).toMatch(/● CI \/ lint running/);
    expect(lines[at(/Checks · c/) + 3]).toMatch(/✓ 1 passed · 1 skipped/);
    expect(
      frame(140, 34, { checks: { passed: 0, failed: 0, pending: 0, failedNames: [], requiredFailed: [], requiredPending: [], items: [] } }).some((l) => l.includes('No checks have reported')),
    ).toBe(true);
  });

  it('stacks the feedback above the PR on a narrow one, without overlapping rows', () => {
    for (const height of [24, 30, 40]) {
      const lines = frame(90, height);
      expect(lines).toHaveLength(height);
      expect(lines.some((l) => l.includes('g to read 1 general comment(s)'))).toBe(true);
      expect(lines.some((l) => l.includes('Retry failed payments · pay.ts'))).toBe(true);
      const reviews = lines.findIndex((l) => l.includes('Reviews'));
      const intent = lines.findIndex((l) => l.includes('Retries failed card'));
      expect(reviews).toBeGreaterThan(0);
      expect(intent === -1 || intent > reviews).toBe(true);
    }
  });

  it('keeps the selected chapter on screen as j moves down a long list', async () => {
    const groups: FeedbackChapter[] = Array.from({ length: 15 }, (_, i) => ({ ...groupFeedback(items, tour.chapters)[0], id: `g${i}`, title: `Chapter ${i + 1}` }));
    for (const [width, height] of [
      [140, 24],
      [140, 30],
      [90, 30],
      [90, 40],
    ]) {
      const ui = render(
        <FeedbackBriefing
          tour={tour}
          items={items}
          groups={groups}
          reviewers={reviewerStatus(reviews, 'dev')}
          reviews={reviews}
          comments={[]}
          queued={0}
          showHidden={false}
          silent={0}
          notes={[]}
          themes={themes}
          readiness={{ level: 'blocked', summary: 'Blocked: changes requested', blockers: [], warnings: [], canMerge: false, canMarkReady: false, canUpdateBranch: false }}
          width={width}
          height={height}
          active
          onStart={noop}
          onSend={noop}
          onToggleHidden={noop}
          onFullTour={noop}
          onRefresh={noop}
          onQuit={noop}
        />,
      );
      for (let i = 0; i < groups.length; i++) {
        const lines = ui.lastFrame()!.split('\n');
        expect(lines).toHaveLength(height);
        expect(
          lines.some((l) => l.includes(`Chapter ${i + 1} `)),
          `${width}x${height}, chapter ${i + 1}`,
        ).toBe(true);
        ui.stdin.write('j');
        await new Promise((r) => setTimeout(r, 15));
      }
      ui.unmount();
    }
  });

  it('says why n, p and Enter go nowhere when there is no feedback', async () => {
    const show = (opts: { items: typeof items; reviews: typeof reviews; canMerge?: boolean }) =>
      render(
        <FeedbackBriefing
          tour={tour}
          items={opts.items}
          groups={[]}
          reviewers={[]}
          reviews={opts.reviews}
          comments={[]}
          queued={0}
          showHidden={false}
          silent={0}
          notes={[]}
          readiness={{ level: 'ready', summary: 'Ready to merge', blockers: [], warnings: [], canMerge: !!opts.canMerge, canMarkReady: false, canUpdateBranch: false }}
          width={140}
          height={30}
          active
          onStart={() => {
            throw new Error('nothing to start');
          }}
          onSend={noop}
          onMerge={noop}
          onToggleHidden={noop}
          onFullTour={noop}
          onRefresh={noop}
          onQuit={noop}
        />,
      );
    const tick = () => new Promise((r) => setTimeout(r, 15));

    let ui = show({ items: [], reviews: [] });
    ui.stdin.write('n');
    await tick();
    expect(ui.lastFrame()).toContain('No reviews yet, so there is no feedback to work through.');
    ui.unmount();

    ui = show({ items: [], reviews, canMerge: true });
    ui.stdin.write('\r');
    await tick();
    expect(ui.lastFrame()).toContain('The reviews left no threads to work through. M merges the PR.');
    ui.unmount();

    ui = show({ items, reviews });
    ui.stdin.write('p');
    await tick();
    expect(ui.lastFrame()).toContain('Every thread is resolved: H shows them.');
    ui.unmount();
  });
});
