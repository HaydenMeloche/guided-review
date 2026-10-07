import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRepoMentionUsers } from '../src/github/gh.js';
import { run } from '../src/util/exec.js';

vi.mock('../src/util/exec.js', () => ({ run: vi.fn() }));
const mockedRun = vi.mocked(run);

beforeEach(() => mockedRun.mockReset());

describe('repository mention users', () => {
  it('reads every collaborator page, removes duplicates, and sorts logins', async () => {
    mockedRun.mockResolvedValue(
      JSON.stringify([
        [
          { login: 'Zoe', type: 'User' },
          { login: 'build-bot', type: 'Bot' },
        ],
        [
          { login: 'alice', type: 'User' },
          { login: 'Zoe', type: 'User' },
        ],
      ]),
    );
    expect(await fetchRepoMentionUsers('owner/repo')).toEqual(['alice', 'build-bot', 'Zoe']);
    expect(mockedRun.mock.calls[0][1]).toEqual(['api', '--paginate', '--slurp', 'repos/owner/repo/collaborators?affiliation=all&per_page=100']);
  });
});
