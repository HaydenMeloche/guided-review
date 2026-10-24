import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { PickerScreen } from '../src/tui/PickerScreen.js';
import type { Store } from '../src/store/db.js';
import { waitFor } from './helpers/waitFor.js';

// Three repos of five PRs each: every repo heading lands somewhere as the list scrolls.
const prs = ['acme/api', 'acme/web', 'acme/cli'].flatMap((repo, r) =>
  Array.from({ length: 5 }, (_, i) => ({
    repo,
    number: r * 10 + i + 1,
    title: `PR ${r * 10 + i + 1}`,
    author: 'dev',
    url: `https://github.com/${repo}/pull/${r * 10 + i + 1}`,
    updatedAt: new Date(Date.UTC(2026, 9, 20 - r, 12 - i)).toISOString(),
    isDraft: false,
    labels: [],
  })),
);
// Your PRs: none until a test sets them.
const yours = (n: number, threads: number) => ({
  repo: n < 14 ? 'acme/web' : 'acme/cli',
  number: n,
  title: `PR ${n}`,
  author: 'me',
  url: `https://github.com/acme/x/pull/${n}`,
  updatedAt: new Date(Date.UTC(2026, 9, 10, 12, 60 - n)).toISOString(),
  isDraft: false,
  labels: [],
  openThreads: threads,
  unresolvedThreads: threads,
  reviewDecision: '',
  mergeStateStatus: 'BLOCKED',
  newReview: false,
  noReviewers: false,
  checks: '',
});
let authored: { prs: ReturnType<typeof yours>[]; truncated: boolean } = { prs: [], truncated: false };
vi.mock('../src/github/gh.js', async (orig) => ({
  parsePRArg: (await orig<typeof import('../src/github/gh.js')>()).parsePRArg,
  listReviewRequests: vi.fn(async () => prs),
  AUTHORED_LIMIT: 200,
  listAuthoredPRs: vi.fn(async () => authored),
  fetchPRPreview: vi.fn(() => new Promise(() => {})),
  viewerLogin: vi.fn(async () => 'me'),
}));

const store = { listTours: () => [], listDrafts: () => [] } as unknown as Store;
const tick = () => new Promise((r) => setTimeout(r, 15));

describe('scrolling the picker', () => {
  it('keeps the selected PR on screen all the way down and back up', async () => {
    for (const height of [10, 13, 16, 21]) {
      const ui = render(<PickerScreen store={store} width={80} height={height} onPick={() => {}} onQuit={() => {}} readClipboard={async () => undefined} downloads={{}} onDownload={() => {}} />);
      await waitFor(() => expect(ui.lastFrame()).toContain('PR 1'));
      const shown = () => {
        const lines = ui.lastFrame()!.split('\n');
        expect(lines).toHaveLength(height);
        // The list runs to the bottom row while there is more below it.
        if (!lines.join('\n').includes('PR 25')) expect(lines.at(-1)!.trim(), lines.join('\n')).not.toBe('');
        return lines.find((l) => l.includes('▌'))?.match(/#\d+ (PR \d+)/)?.[1];
      };
      const order = prs.map((p) => p.title);
      for (const [i, title] of order.entries()) {
        expect(shown(), `height ${height}, down to ${i}`).toBe(title);
        ui.stdin.write('j');
        await tick();
      }
      for (const [i, title] of [...order.entries()].reverse()) {
        expect(shown(), `height ${height}, up to ${i}`).toBe(title);
        ui.stdin.write('k');
        await tick();
      }
      ui.unmount();
    }
    // 120 key presses, each waiting for its frame: past the default five seconds on a slow runner.
  }, 20_000);

  it('holds still while the selection moves within the view, and shows the lines under the last PR', async () => {
    authored = { prs: [11, 12, 13, 14, 15, 16].map((n) => yours(n, 2)).concat([yours(21, 0), yours(22, 0)]), truncated: true };
    const ui = render(<PickerScreen store={store} width={70} height={16} onPick={() => {}} onQuit={() => {}} readClipboard={async () => undefined} downloads={{}} onDownload={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('PR 1'));
    const list = () => ui.lastFrame()!.split('\n').slice(3);
    // G, once Your PRs are in: the last of them.
    for (
      let i = 0;
      i < 100 &&
      !list()
        .find((l) => l.includes('▌'))
        ?.includes('PR 16');
      i++
    ) {
      ui.stdin.write('G');
      await tick();
    }
    expect(list().find((l) => l.includes('▌'))).toContain('PR 16');
    expect(ui.lastFrame()).toContain('w shows them');
    expect(ui.lastFrame()).toContain('Showing the first 200 of your open PRs.');
    const firstPR = () =>
      list()
        .find((l) => /#\d+ PR/.test(l))
        ?.match(/#\d+/)?.[0];
    const top = firstPR();
    // Back up through PRs already on screen: the list stays where it is.
    for (let i = 0; i < 3; i++) {
      ui.stdin.write('k');
      await tick();
    }
    expect(list().find((l) => l.includes('▌'))).toContain('PR 13');
    expect(firstPR()).toBe(top);
    ui.unmount();
    authored = { prs: [], truncated: false };
  });
});
