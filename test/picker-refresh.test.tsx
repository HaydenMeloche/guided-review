import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { PickerScreen, type Target } from '../src/tui/PickerScreen.js';
import { listReviewRequests, type ReviewRequest } from '../src/github/gh.js';
import type { Store } from '../src/store/db.js';
import { waitFor } from './helpers/waitFor.js';

vi.mock('../src/github/gh.js', () => ({
  listReviewRequests: vi.fn(),
  fetchPRPreview: vi.fn(() => new Promise(() => {})),
}));

const pr = (number: number, title: string): ReviewRequest => ({
  repo: 'acme/app',
  number,
  title,
  author: 'dev',
  url: `https://github.com/acme/app/pull/${number}`,
  updatedAt: '2026-10-08T00:00:00Z',
  isDraft: false,
  labels: [],
});

const store = { listTours: () => [], listDrafts: () => [] } as unknown as Store;

function picker(opts: { onPick?: (t: Target) => void; refreshMs?: number } = {}) {
  return render(<PickerScreen store={store} width={120} height={25} onPick={opts.onPick ?? (() => {})} onQuit={() => {}} downloads={{}} onDownload={() => {}} refreshMs={opts.refreshMs} />);
}

afterEach(() => vi.mocked(listReviewRequests).mockReset());

describe('picker refresh', () => {
  it('keeps the list on screen with a spinner while refreshing, and stays on the same PR', async () => {
    let resolve: (p: ReviewRequest[]) => void = () => {};
    vi.mocked(listReviewRequests)
      .mockResolvedValueOnce([pr(1, 'First'), pr(2, 'Second')])
      .mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const ui = picker();
    await waitFor(() => expect(ui.lastFrame()).toContain('Second'));
    ui.stdin.write('j');
    await waitFor(() => expect(ui.lastFrame()).toMatch(/│ acme\/app#2/));

    ui.stdin.write('r');
    await waitFor(() => expect(ui.lastFrame()).toContain('refreshing'));
    expect(ui.lastFrame()).toContain('#1 First');
    expect(ui.lastFrame()).toContain('#2 Second');

    // A new PR lands above the highlighted one; the highlight follows #2.
    resolve([pr(3, 'Third'), pr(1, 'First'), pr(2, 'Second')]);
    await waitFor(() => expect(ui.lastFrame()).toContain('#3 Third'));
    expect(ui.lastFrame()).not.toContain('refreshing');
    expect(ui.lastFrame()).toMatch(/│ acme\/app#2/);
    ui.unmount();
  });

  it('keeps the old list when a refresh fails', async () => {
    vi.mocked(listReviewRequests)
      .mockResolvedValueOnce([pr(1, 'First')])
      .mockRejectedValueOnce(new Error('network down'));
    const ui = picker();
    await waitFor(() => expect(ui.lastFrame()).toContain('#1 First'));
    ui.stdin.write('r');
    await waitFor(() => expect(ui.lastFrame()).toContain('Refresh failed: network down'));
    expect(ui.lastFrame()).toContain('#1 First');
    ui.unmount();
  });

  it('refreshes on its own', async () => {
    vi.mocked(listReviewRequests)
      .mockResolvedValueOnce([pr(1, 'First')])
      .mockResolvedValue([pr(1, 'First'), pr(2, 'Second')]);
    const ui = picker({ refreshMs: 30 });
    await waitFor(() => expect(ui.lastFrame()).toContain('#2 Second'));
    ui.unmount();
  });
});
