import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { KeysLive } from '../src/tui/input.js';
import { SubmitScreen } from '../src/tui/SubmitScreen.js';
import { TourIntro } from '../src/tui/TourIntro.js';
import { hunk, tour } from './fixtures/tour.js';

const tick = () => new Promise((r) => setTimeout(r, 20));

// App turns KeysLive off while the quit question is up, so the key that answers it (Esc to stay)
// does not also act on the popup or screen under it.
describe('keys while App asks a question', () => {
  it('keeps Esc from leaving the submit screen under the quit question', async () => {
    const onBack = vi.fn();
    const review = tour([hunk('h1', 'src/item.ts', [{ kind: 'add', text: 'const item = 1;', newLine: 1 }])], [{ hunkIds: ['h1'] }]);
    const screen = (live: boolean) => (
      <KeysLive.Provider value={live}>
        <SubmitScreen tour={review} chapters={review.chapters} states={{}} drafts={[]} width={90} height={30} onEdit={() => {}} onDelete={() => {}} onPosted={() => {}} onBack={onBack} />
      </KeysLive.Provider>
    );
    const ui = render(screen(false));
    await tick();
    ui.stdin.write('\u001b');
    await tick();
    expect(onBack).not.toHaveBeenCalled();
    ui.rerender(screen(true));
    await tick();
    ui.stdin.write('q');
    await tick();
    expect(onBack).toHaveBeenCalled();
    ui.unmount();
  });

  it('keeps q on the loading card from going back to the PR list under the quit question', async () => {
    const onBack = vi.fn();
    const ui = render(
      <KeysLive.Provider value={false}>
        <TourIntro width={60} height={14} lines={() => ['acme/app#42']} onBack={onBack} onQuit={() => {}} />
      </KeysLive.Provider>,
    );
    await tick();
    ui.stdin.write('q');
    await tick();
    expect(onBack).not.toHaveBeenCalled();
    ui.unmount();
  });
});
