import { describe, expect, it } from 'vitest';
import { openRequest, type RequestEvent } from '../src/github/gh.js';

const teams = new Set(['acme/backend']);
const at = (h: number) => `2026-10-16T${String(h).padStart(2, '0')}:00:00Z`;

describe('openRequest', () => {
  it('keeps a request to the viewer by name until they review', () => {
    const asked: RequestEvent[] = [{ kind: 'requested', at: at(1), user: 'Me' }];
    expect(openRequest(asked, 'me', teams)).toEqual({ reviewedBy: [] });
    expect(openRequest([...asked, { kind: 'review', at: at(2), author: 'me' }], 'me', teams)).toBeUndefined();
  });

  it('keeps a team request after a teammate reviews, naming them', () => {
    const events: RequestEvent[] = [
      { kind: 'review', at: at(1), author: 'early' },
      { kind: 'requested', at: at(2), team: 'acme/backend' },
      { kind: 'review', at: at(3), author: 'alice' },
      { kind: 'review', at: at(4), author: 'alice' },
    ];
    expect(openRequest(events, 'me', teams)).toEqual({ team: 'acme/backend', reviewedBy: ['alice'] });
  });

  it('drops a request to a team the viewer is not on, or one that was removed', () => {
    expect(openRequest([{ kind: 'requested', at: at(1), team: 'acme/frontend' }], 'me', teams)).toBeUndefined();
    expect(
      openRequest(
        [
          { kind: 'requested', at: at(1), team: 'acme/backend' },
          { kind: 'removed', at: at(2), team: 'acme/backend' },
        ],
        'me',
        teams,
      ),
    ).toBeUndefined();
  });

  it('brings a PR back when it is requested again after the viewer reviewed', () => {
    const events: RequestEvent[] = [
      { kind: 'requested', at: at(1), team: 'acme/backend' },
      { kind: 'review', at: at(2), author: 'me' },
      { kind: 'requested', at: at(3), user: 'me' },
    ];
    expect(openRequest(events, 'me', teams)).toEqual({ reviewedBy: [] });
  });
});
