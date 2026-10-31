import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { PickerScreen } from '../src/tui/PickerScreen.js';
import type { Store } from '../src/store/db.js';
import { waitFor } from './helpers/waitFor.js';

vi.mock('../src/github/gh.js', async (orig) => ({
  parsePRArg: (await orig<typeof import('../src/github/gh.js')>()).parsePRArg,
  listReviewRequests: vi.fn(async () => []),
  listAuthoredPRs: vi.fn(async () => ({ prs: [], truncated: false })),
  listReviewedPRs: vi.fn(async () => ({
    prs: [
      {
        repo: 'acme/web',
        number: 330,
        title: 'Checkout: discount codes',
        author: 'mira',
        url: 'https://github.com/acme/web/pull/330',
        updatedAt: '2026-10-08T00:00:00Z',
        isDraft: false,
        labels: [],
        reviewedAt: '2026-10-01T00:00:00Z',
        newCommits: 2,
        replies: 1,
      },
      {
        repo: 'acme/api',
        number: 801,
        title: 'Soft-delete accounts',
        author: 'tom',
        url: 'https://github.com/acme/api/pull/801',
        updatedAt: '2026-10-07T00:00:00Z',
        isDraft: false,
        labels: [],
        reviewedAt: '2026-10-01T00:00:00Z',
        newCommits: 0,
        replies: 0,
      },
    ],
    truncated: false,
  })),
  fetchPRPreview: vi.fn(() => new Promise(() => {})),
  viewerLogin: vi.fn(async () => 'me'),
}));

const store = { listTours: () => [], listDrafts: () => [] } as unknown as Store;

describe('Reviewed by you in the picker', () => {
  it('lists the PR with new commits and replies, and counts the quiet one', async () => {
    const onPick = vi.fn();
    const ui = render(<PickerScreen store={store} width={120} height={24} onPick={onPick} onQuit={() => {}} readClipboard={async () => undefined} downloads={{}} onDownload={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Reviewed by you (1)'));
    const frame = ui.lastFrame()!;
    expect(frame).toContain('#330 Checkout: discount codes');
    expect(frame).toContain('@mira · 2 new commits · 1 reply to you');
    expect(frame).not.toContain('Soft-delete accounts');
    expect(frame).toContain('1 PR you reviewed has nothing new since');
    // Enter opens it as a review.
    ui.stdin.write('\r');
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({ repo: 'acme/web', number: 330 }));
    ui.unmount();
  });
});
