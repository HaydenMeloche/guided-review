import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { EndCard } from '../src/tui/chapter/EndCard.js';
import { waitFor } from './helpers/waitFor.js';

const card = (extra: Partial<Parameters<typeof EndCard>[0]> = {}) => {
  const props = {
    read: 1,
    skipped: 0,
    deferred: 0,
    unread: 0,
    drafts: 0,
    verdict: 'Approve',
    reasons: [],
    optional: false,
    onSubmit: vi.fn(),
    onOptional: vi.fn(),
    onClose: vi.fn(),
    onQuit: vi.fn(),
    ...extra,
  };
  return { props, ui: render(<EndCard {...props} />) };
};

describe('EndCard', () => {
  it('offers approve and merge on Enter when it is given one', async () => {
    const onApproveMerge = vi.fn();
    const { props, ui } = card({ onApproveMerge });
    expect(ui.lastFrame()).toContain('enter approve and merge');
    ui.stdin.write('\r');
    await waitFor(() => expect(onApproveMerge).toHaveBeenCalled());
    expect(props.onClose).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('closes on Enter otherwise', async () => {
    const { props, ui } = card();
    expect(ui.lastFrame()).not.toContain('approve and merge');
    expect(ui.lastFrame()).toContain('review drafts and submit');
    ui.stdin.write('\r');
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    ui.unmount();
  });
});
