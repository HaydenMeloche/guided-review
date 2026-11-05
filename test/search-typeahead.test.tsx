import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { SearchPanel } from '../src/tui/chapter/SearchPanel.js';
import { hunk, tour } from './fixtures/tour.js';

const tick = () => new Promise((r) => setTimeout(r, 20));

// Keys typed while gr is busy reach it together: "STAFF50\r" is the text and then Enter.
describe('the search panel with Enter typed ahead', () => {
  it('searches the text and goes to its first match, without Enter in the query', async () => {
    const review = tour(
      [hunk('h1', 'src/a.ts', [{ kind: 'add', text: 'const a = 1;', newLine: 1 }]), hunk('h2', 'src/pricing.ts', [{ kind: 'add', text: "{ code: 'STAFF50' }", newLine: 18 }])],
      [{ hunkIds: ['h1', 'h2'] }],
    );
    const onGo = vi.fn();
    const ui = render(<SearchPanel tour={review} chapters={review.chapters} last={{ query: '', sel: 0 }} width={90} height={12} onClose={() => {}} onGo={onGo} />);
    await tick();
    ui.stdin.write('STAFF50\r');
    await tick();
    expect(onGo).toHaveBeenCalledOnce();
    expect(onGo.mock.calls[0][0]).toMatchObject({ hunkId: 'h2', where: 'src/pricing.ts:18' });
    expect(onGo.mock.calls[0][1]).toEqual({ query: 'STAFF50', sel: 0 });
    ui.unmount();
  });

  it('still goes to the highlighted match on a separate Enter', async () => {
    const review = tour([hunk('h1', 'src/a.ts', [{ kind: 'add', text: 'x one', newLine: 1 }]), hunk('h2', 'src/b.ts', [{ kind: 'add', text: 'x two', newLine: 2 }])], [{ hunkIds: ['h1', 'h2'] }]);
    const onGo = vi.fn();
    const ui = render(<SearchPanel tour={review} chapters={review.chapters} last={{ query: '', sel: 0 }} width={90} height={12} onClose={() => {}} onGo={onGo} />);
    await tick();
    ui.stdin.write('x');
    await tick();
    ui.stdin.write('\u001b[B'); // down to the second match
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(onGo.mock.calls[0][0]).toMatchObject({ hunkId: 'h2' });
    expect(onGo.mock.calls[0][1]).toEqual({ query: 'x', sel: 1 });
    ui.unmount();
  });
});
