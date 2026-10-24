import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { PickerScreen } from '../src/tui/PickerScreen.js';
import { classifyError } from '../src/tui/ErrorBlock.js';
import type { Store } from '../src/store/db.js';
import { waitFor } from './helpers/waitFor.js';

vi.mock('../src/github/gh.js', async (orig) => ({
  parsePRArg: (await orig<typeof import('../src/github/gh.js')>()).parsePRArg,
  listReviewRequests: vi.fn(async () => []),
  listAuthoredPRs: vi.fn(async () => ({ prs: [], truncated: false })),
  fetchPRPreview: vi.fn(() => new Promise(() => {})),
  viewerLogin: vi.fn(async () => 'me'),
}));

const store = { listTours: () => [], listDrafts: () => [] } as unknown as Store;

describe('the empty PR list', () => {
  it('suggests what to run instead, and keeps only the keys that do something', async () => {
    const ui = render(<PickerScreen store={store} width={100} height={24} onPick={() => {}} onQuit={() => {}} readClipboard={async () => undefined} downloads={{}} onDownload={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Nothing is waiting on your review.'));
    expect(ui.lastFrame()).toContain('gr preview');
    expect(ui.lastFrame()).toContain('gr review 1234');
    expect(ui.lastFrame()).toContain('gr feedback');
    expect(ui.lastFrame()).not.toContain('/ filter');
    expect(ui.lastFrame()).toContain('r refresh');
    expect(ui.lastFrame()).toContain('? keys');
    ui.unmount();
  });
});

describe('classifyError', () => {
  it('names the next step for the common failures', () => {
    expect(classifyError('gh: To get started with GitHub CLI, please run:  gh auth login', 'x')).toMatchObject({ title: 'gh is not signed in to GitHub', command: 'gh auth login' });
    expect(classifyError('getaddrinfo ENOTFOUND api.github.com', 'x').title).toBe('GitHub could not be reached');
    expect(classifyError('GraphQL: Could not resolve to a PullRequest with the number of 99999.', 'x')).toMatchObject({ title: 'That PR was not found' });
    expect(classifyError('something else', 'Could not open the tour')).toEqual({ title: 'Could not open the tour', next: 'Press r to retry.' });
  });
});
