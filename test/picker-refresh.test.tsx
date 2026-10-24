import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { PickerScreen, clipboardPR, type Target } from '../src/tui/PickerScreen.js';
import { fetchPRPreview, listReviewRequests, type PRPreview, type ReviewRequest } from '../src/github/gh.js';
import type { Store } from '../src/store/db.js';
import { waitFor } from './helpers/waitFor.js';

vi.mock('../src/github/gh.js', async (importOriginal) => ({
  parsePRArg: (await importOriginal<typeof import('../src/github/gh.js')>()).parsePRArg,
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

function picker(opts: { clipboard?: () => Promise<string | undefined>; onPick?: (t: Target) => void; refreshMs?: number } = {}) {
  const readClipboard = opts.clipboard ?? (async () => undefined);
  return render(
    <PickerScreen
      store={store}
      width={120}
      height={25}
      onPick={opts.onPick ?? (() => {})}
      onQuit={() => {}}
      downloads={{}}
      onDownload={() => {}}
      readClipboard={readClipboard}
      refreshMs={opts.refreshMs}
    />,
  );
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

describe('picker clipboard', () => {
  it('offers a copied PR link and opens it with p', async () => {
    vi.mocked(listReviewRequests).mockResolvedValue([pr(1, 'First')]);
    const onPick = vi.fn();
    const ui = picker({ clipboard: async () => 'https://github.com/other/repo/pull/482/files\n', onPick });
    await waitFor(() => expect(ui.lastFrame()).toContain('From clipboard  p open tour · x dismiss'));
    expect(ui.lastFrame()).toContain('   #482');
    expect(ui.lastFrame()).toContain('    other/repo');
    ui.stdin.write('p');
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({ repo: 'other/repo', number: 482 }));
    ui.unmount();
    // Opened once; coming back to the picker doesn't offer it again.
    expect(clipboardPR('https://github.com/other/repo/pull/482/files')).toBeUndefined();
  });

  it('fetches the title of a copied PR that is not in the list', async () => {
    vi.mocked(listReviewRequests).mockResolvedValue([pr(1, 'First')]);
    vi.mocked(fetchPRPreview).mockResolvedValueOnce({ title: 'Fix retry backoff', author: 'sam' } as PRPreview);
    const ui = picker({ clipboard: async () => 'https://github.com/other/repo/pull/7' });
    await waitFor(() => expect(ui.lastFrame()).toContain('   #7 Fix retry backoff'));
    expect(ui.lastFrame()).toContain('other/repo · @sam');
    ui.unmount();
  });

  it('shows the title of a listed PR and dismisses with x', async () => {
    vi.mocked(listReviewRequests).mockResolvedValue([pr(1, 'First')]);
    const ui = picker({ clipboard: async () => 'acme/app#1' });
    await waitFor(() => expect(ui.lastFrame()).toContain('From clipboard'));
    expect(ui.lastFrame()).toContain('acme/app · @dev');
    ui.stdin.write('x');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('From clipboard'));
    ui.unmount();
  });

  it('ignores clipboard text that is not a PR', () => {
    expect(clipboardPR('hello world')).toBeUndefined();
    expect(clipboardPR('482')).toBeUndefined();
    expect(clipboardPR('https://github.com/acme/app/issues/3')).toBeUndefined();
  });
});
