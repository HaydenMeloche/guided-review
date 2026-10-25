import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { PickerScreen } from '../src/tui/PickerScreen.js';
import { fetchPRPreview, type AuthoredPR, type PRPreview } from '../src/github/gh.js';
import type { Store } from '../src/store/db.js';
import { waitFor } from './helpers/waitFor.js';

let resolveMine: (prs: AuthoredPR[], truncated?: boolean) => void = () => {};
vi.mock('../src/github/gh.js', async (orig) => ({
  parsePRArg: (await orig<typeof import('../src/github/gh.js')>()).parsePRArg,
  listReviewRequests: vi.fn(async () => [
    { repo: 'acme/app', number: 1, title: 'Review me', author: 'dev', url: 'https://github.com/acme/app/pull/1', updatedAt: '2026-10-08T00:00:00Z', isDraft: false, labels: [] },
  ]),
  listAuthoredPRs: vi.fn(() => new Promise<{ prs: AuthoredPR[]; truncated: boolean }>((r) => (resolveMine = (prs, truncated = false) => r({ prs, truncated })))),
  fetchPRPreview: vi.fn(() => new Promise(() => {})),
  viewerLogin: vi.fn(async () => 'me'),
}));

const store = { listTours: () => [], listDrafts: () => [] } as unknown as Store;

describe('Your PRs in the picker', () => {
  it('shows a loading line while they load, then their section, without holding up review requests', async () => {
    const ui = render(<PickerScreen store={store} width={120} height={24} onPick={() => {}} onQuit={() => {}} readClipboard={async () => undefined} downloads={{}} onDownload={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Review me'));
    expect(ui.lastFrame()).toContain('Your PRs');
    expect(ui.lastFrame()).toContain('loading…');
    resolveMine([
      {
        repo: 'me/app',
        number: 9,
        title: 'Mine',
        author: 'me',
        url: 'https://github.com/me/app/pull/9',
        updatedAt: '2026-10-08T00:00:00Z',
        isDraft: false,
        labels: [],
        openThreads: 0,
        unresolvedThreads: 0,
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'CLEAN',
        newReview: false,
        noReviewers: false,
        checks: 'SUCCESS',
      },
    ]);
    await waitFor(() => expect(ui.lastFrame()).toContain('✓ ready to merge'));
    expect(ui.lastFrame()).not.toContain('loading…');
    expect(ui.lastFrame()).toContain('Your PRs (1)');
    ui.unmount();
  });
});

describe('a repo in both sections', () => {
  it('heads a group in each, and the rows stay put as the selection moves', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ui = render(<PickerScreen store={store} width={100} height={30} onPick={() => {}} onQuit={() => {}} readClipboard={async () => undefined} downloads={{}} onDownload={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Review me'));
    resolveMine([
      {
        repo: 'acme/app',
        number: 9,
        title: 'Mine in the same repo',
        author: 'me',
        url: 'https://github.com/acme/app/pull/9',
        updatedAt: '2026-10-08T00:00:00Z',
        isDraft: false,
        labels: [],
        openThreads: 1,
        unresolvedThreads: 1,
        reviewDecision: '',
        mergeStateStatus: 'BLOCKED',
        newReview: false,
        noReviewers: false,
        checks: '',
      },
    ]);
    await waitFor(() => expect(ui.lastFrame()).toContain('Mine in the same repo'));
    for (const key of ['j', 'k', 'j']) {
      ui.stdin.write(key);
      await new Promise((r) => setTimeout(r, 20));
      const frame = ui.lastFrame()!;
      expect(frame.match(/acme\/app \(1\)/g)).toHaveLength(2);
      expect(frame.match(/Review me/g)).toHaveLength(1);
    }
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/);
    errors.mockRestore();
    ui.unmount();
  });
});

describe('a copied link', () => {
  const preview = (author: string): PRPreview => ({
    title: 'Copied PR',
    author,
    headRefName: 'f',
    baseRefName: 'main',
    headSha: 'abc',
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    isDraft: false,
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    labels: [],
    body: '',
    checks: { passed: 0, failed: 0, pending: 0, failedNames: [] },
    files: [],
  });

  for (const [author, label, mode] of [
    ['me', 'p open feedback', 'author'],
    ['someone', 'p open tour', undefined],
  ] as const) {
    it(`to ${author === 'me' ? 'your own PR opens its feedback' : 'someone else’s PR opens its tour'}`, async () => {
      vi.mocked(fetchPRPreview).mockResolvedValue(preview(author));
      const onPick = vi.fn();
      const url = `https://github.com/acme/other/pull/${author === 'me' ? 5 : 6}`;
      const ui = render(<PickerScreen store={store} width={100} height={30} onPick={onPick} onQuit={() => {}} readClipboard={async () => url} downloads={{}} onDownload={() => {}} />);
      await waitFor(() => expect(ui.lastFrame()).toContain(label));
      if (author === 'me') expect(ui.lastFrame()).toContain('your PR');
      ui.stdin.write('p');
      await waitFor(() => expect(onPick).toHaveBeenCalled());
      const target = { repo: 'acme/other', number: author === 'me' ? 5 : 6 };
      if (mode) expect(onPick).toHaveBeenCalledWith(target, mode);
      else expect(onPick).toHaveBeenCalledWith(target);
      ui.unmount();
    });
  }
});

describe('a PR merged this session', () => {
  it('leaves the list at once, even while GitHub still returns it', async () => {
    const mine: AuthoredPR = {
      repo: 'me/app',
      number: 9,
      title: 'Merged already',
      author: 'me',
      url: 'https://github.com/me/app/pull/9',
      updatedAt: '2026-10-08T00:00:00Z',
      isDraft: false,
      labels: [],
      openThreads: 0,
      unresolvedThreads: 0,
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      newReview: false,
      noReviewers: false,
      checks: 'SUCCESS',
    };
    const props = { store, width: 120, height: 24, onPick: () => {}, onQuit: () => {}, readClipboard: async () => undefined, downloads: {}, onDownload: () => {} };
    const ui = render(<PickerScreen {...props} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Review me'));
    resolveMine([mine]);
    await waitFor(() => expect(ui.lastFrame()).toContain('Merged already'));
    ui.rerender(<PickerScreen {...props} merged={new Set(['me/app#9', 'acme/app#1'])} />);
    await waitFor(() => expect(ui.lastFrame()).not.toContain('Merged already'));
    expect(ui.lastFrame()).not.toContain('Review me');
    ui.unmount();
  });
});

describe('Esc in the picker', () => {
  it('clears the selection and never quits; q quits', async () => {
    const onQuit = vi.fn();
    const ui = render(<PickerScreen store={store} width={120} height={24} onPick={() => {}} onQuit={onQuit} readClipboard={async () => undefined} downloads={{}} onDownload={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Review me'));
    ui.stdin.write(' ');
    await waitFor(() => expect(ui.lastFrame()).toContain('■'));
    ui.stdin.write('\u001b');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('■'));
    ui.stdin.write('\u001b');
    await waitFor(() => expect(ui.lastFrame()).toContain('q quits'));
    expect(onQuit).not.toHaveBeenCalled();
    ui.stdin.write('q');
    await waitFor(() => expect(onQuit).toHaveBeenCalledTimes(1));
    ui.unmount();
  });
});
