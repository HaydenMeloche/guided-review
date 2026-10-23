import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { parseReviewers } from '../src/review/reviewers.js';
import { ReviewersScreen } from '../src/tui/ReviewersScreen.js';
import { waitFor } from './helpers/waitFor.js';

const gh = vi.hoisted(() => ({
  fetchPendingReviewers: vi.fn(),
  fetchReviews: vi.fn(),
  getMentionUsers: vi.fn(),
  fetchOrgTeams: vi.fn(),
  requestReviewers: vi.fn(),
  removeReviewRequests: vi.fn(),
}));
vi.mock('../src/github/gh.js', () => gh);

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('parseReviewers', () => {
  it('reads people and teams, with or without @, apart by spaces or commas', () => {
    expect(parseReviewers('@alice bob,  @o/core, carol @Alice', 'o/r', 'me')).toEqual({ users: ['alice', 'bob', 'carol'], teams: ['core'] });
    expect(parseReviewers('   ', 'o/r', 'me')).toEqual({ users: [], teams: [] });
    expect(parseReviewers('dependabot[bot]', 'o/r', 'me').users).toEqual(['dependabot[bot]']);
  });

  it('refuses the author, a team in another organization, and names GitHub would not have', () => {
    expect(parseReviewers('alice @Me', 'o/r', 'me').error).toContain('wrote the PR');
    expect(parseReviewers('@other/core', 'o/r', 'me').error).toContain('not a team in o');
    expect(parseReviewers('al!ce', 'o/r', 'me').error).toContain('not a GitHub username');
    expect(parseReviewers('-alice', 'o/r', 'me').error).toContain('not a GitHub username');
  });
});

describe('the reviewers popup', () => {
  beforeEach(() => {
    for (const f of Object.values(gh)) f.mockReset();
    gh.fetchPendingReviewers.mockResolvedValue({ author: 'me', users: ['alice'], teams: ['core'] });
    gh.fetchReviews.mockResolvedValue([{ id: 1, author: 'bob', state: 'CHANGES_REQUESTED', body: '', submittedAt: '2026-10-20T10:00:00Z', url: 'u' }]);
    gh.getMentionUsers.mockResolvedValue(['alice', 'bob', 'carol', 'me']);
    gh.fetchOrgTeams.mockResolvedValue(['core', 'payments', 'platform']);
    gh.requestReviewers.mockResolvedValue(undefined);
    gh.removeReviewRequests.mockResolvedValue(undefined);
  });

  it('lists who is asked and who reviewed', async () => {
    const ui = render(<ReviewersScreen repo="o/r" number={7} width={80} height={20} onClose={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('@alice waiting'));
    const frame = ui.lastFrame()!;
    expect(frame).toContain('Reviewers of o/r#7');
    expect(frame).toContain('2 asked and not answered yet');
    expect(frame).toContain('@o/core waiting');
    expect(frame).toContain('@bob changes requested');
    ui.unmount();
  });

  it('asks the people typed, completing their names', async () => {
    const onClose = vi.fn();
    const ui = render(<ReviewersScreen repo="o/r" number={7} width={80} height={20} onClose={onClose} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('@alice waiting'));
    ui.stdin.write('a');
    await waitFor(() => expect(ui.lastFrame()).toContain('Ask to review:'));
    ui.stdin.write('ca');
    // The author and people already asked are not offered.
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ @carol'));
    expect(ui.lastFrame()).not.toContain('@me');
    await tick();
    ui.stdin.write('\t');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('tab insert'));
    ui.stdin.write('@o/core2');
    await waitFor(() => expect(ui.lastFrame()).toContain('@o/core2'));
    ui.stdin.write('\r');
    await waitFor(() => expect(gh.requestReviewers).toHaveBeenCalledWith('o/r', 7, ['carol'], ['core2']));
    await waitFor(() => expect(ui.lastFrame()).toContain('Asked @carol, @o/core2 to review.'));
    ui.stdin.write('\u001b');
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    ui.unmount();
  });

  it("completes the organization's teams, after @ or once org/ is typed", async () => {
    const ui = render(<ReviewersScreen repo="o/r" number={7} width={80} height={20} onClose={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('@alice waiting'));
    await waitFor(() => expect(gh.fetchOrgTeams).toHaveBeenCalledWith('o/r'));
    ui.stdin.write('a');
    await waitFor(() => expect(ui.lastFrame()).toContain('Ask to review:'));
    // Teams list with people after @; a team already asked (core) is not offered.
    ui.stdin.write('@p');
    await waitFor(() => expect(ui.lastFrame()).toContain('@o/payments'));
    expect(ui.lastFrame()).toContain('@o/platform');
    expect(ui.lastFrame()).not.toMatch(/@o\/core\s+team/);
    for (let i = 0; i < '@p'.length; i++) {
      ui.stdin.write('\u007f');
      await tick();
    }
    ui.stdin.write('o/pl');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ @o/platform'));
    expect(ui.lastFrame()).not.toContain('@o/payments');
    await tick();
    ui.stdin.write('\t');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('tab insert'));
    ui.stdin.write('\r');
    await waitFor(() => expect(gh.requestReviewers).toHaveBeenCalledWith('o/r', 7, [], ['platform']));
    ui.unmount();
  });

  it('says why it will not ask the author, and sends nothing', async () => {
    const ui = render(<ReviewersScreen repo="o/r" number={7} width={80} height={20} onClose={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('@alice waiting'));
    ui.stdin.write('a');
    await waitFor(() => expect(ui.lastFrame()).toContain('Ask to review:'));
    ui.stdin.write('@me ');
    await waitFor(() => expect(ui.lastFrame()).toContain('@me'));
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('wrote the PR'));
    expect(gh.requestReviewers).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('withdraws a request and asks a reviewer again', async () => {
    const ui = render(<ReviewersScreen repo="o/r" number={7} width={80} height={20} onClose={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('@alice waiting'));
    ui.stdin.write('x');
    await waitFor(() => expect(gh.removeReviewRequests).toHaveBeenCalledWith('o/r', 7, ['alice']));
    await waitFor(() => expect(ui.lastFrame()).toContain('@alice is no longer asked to review.'));
    ui.stdin.write('j');
    ui.stdin.write('j');
    await waitFor(() => expect(ui.lastFrame()).toContain('ask again'));
    ui.stdin.write('r');
    await waitFor(() => expect(gh.requestReviewers).toHaveBeenCalledWith('o/r', 7, ['bob']));
    ui.unmount();
  });

  it('shows what GitHub says when it refuses', async () => {
    gh.requestReviewers.mockRejectedValue(new Error('Reviews may only be requested from collaborators.'));
    const ui = render(<ReviewersScreen repo="o/r" number={7} width={80} height={20} onClose={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('@alice waiting'));
    ui.stdin.write('a');
    await waitFor(() => expect(ui.lastFrame()).toContain('Ask to review:'));
    ui.stdin.write('stranger ');
    await waitFor(() => expect(ui.lastFrame()).toContain('stranger'));
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('Reviews may only be requested from collaborators.'));
    // The names stay in the field to be corrected.
    expect(ui.lastFrame()).toContain('Ask to review:');
    expect(ui.lastFrame()).toContain('stranger');
    ui.unmount();
  });

  it('keeps the popup open while a request is in flight, then closes saying it changed', async () => {
    let finish: () => void = () => {};
    gh.requestReviewers.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
    const onClose = vi.fn();
    const ui = render(<ReviewersScreen repo="o/r" number={7} width={80} height={20} onClose={onClose} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('@bob changes requested'));
    ui.stdin.write('j');
    ui.stdin.write('j');
    await waitFor(() => expect(ui.lastFrame()).toContain('ask again'));
    ui.stdin.write('r');
    await waitFor(() => expect(ui.lastFrame()).toContain('Asking for a review…'));
    ui.stdin.write('\u001b');
    await tick();
    expect(onClose).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(ui.lastFrame()).toContain('Asked @bob to review again.'));
    ui.stdin.write('\u001b');
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    ui.unmount();
  });
});
