import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { DONE_MS, UpdateScreen } from '../src/tui/UpdateScreen.js';
import { terminalPalette } from '../src/tui/theme.js';
import type { Install, ReleaseNotes, UpdateResult } from '../src/updateCheck.js';
import { waitFor } from './helpers/waitFor.js';

const ENTER = '\r';
const offer = { installed: '0.2.0', latest: '0.3.0', packageManager: 'npm' as const };
const notes: ReleaseNotes[] = [
  { version: '0.3.0', date: '2026-10-20', body: '## Highlights\n\n- **Full-screen updates** with release notes' },
  { version: '0.2.1', body: '- Fixes a crash' },
];

function screen(opts: { notes?: Promise<ReleaseNotes[] | undefined>; install?: Install } = {}) {
  const onDone = vi.fn<(r: UpdateResult) => void>();
  const install = vi.fn<Install>(opts.install ?? (async () => ({ status: 0 })));
  const ui = render(<UpdateScreen offer={offer} initial={terminalPalette} notes={opts.notes ?? Promise.resolve(notes)} install={install} onDone={onDone} />);
  return { ui, onDone, install };
}

describe('update screen', () => {
  it("shows the version jump and what's new in every release since the installed one", async () => {
    const { ui } = screen();
    await waitFor(() => expect(ui.lastFrame()).toContain('Full-screen updates'));
    const frame = ui.lastFrame()!;
    expect(frame).toContain('Update available 0.2.0 → 0.3.0');
    expect(frame).toContain('npm install -g @haydenmeloche/guided-review@latest');
    expect(frame).toContain('0.3.0 · 2026-10-20');
    expect(frame).toContain('0.2.1');
    expect(frame).toContain('Fixes a crash');
    expect(frame).toContain('skip this version');
  });

  it('points at the releases page when GitHub cannot be reached', async () => {
    const { ui } = screen({ notes: Promise.resolve(undefined) });
    await waitFor(() => expect(ui.lastFrame()).toContain("Couldn't load the release notes"));
    expect(ui.lastFrame()).toContain('github.com/HaydenMeloche/guided-review/releases');
  });

  it('lets the update wait or skips this version', async () => {
    const later = screen();
    later.ui.stdin.write('n');
    await waitFor(() => expect(later.onDone).toHaveBeenCalledWith({ kind: 'later' }));
    const skip = screen();
    skip.ui.stdin.write('s');
    await waitFor(() => expect(skip.onDone).toHaveBeenCalledWith({ kind: 'skip' }));
    expect(skip.install).not.toHaveBeenCalled();
  });

  it('installs on Enter, showing the output as it runs, then says it updated before restarting', async () => {
    let finish!: (r: { status: number }) => void;
    const { ui, onDone, install } = screen({
      install: (_cmd, _args, onOutput) => {
        onOutput('npm http fetch GET 200 https://registry.npmjs.org/ink 31ms\nchanged 3 pack');
        onOutput('ages in 2s\n');
        return new Promise((resolve) => (finish = resolve));
      },
    });
    await waitFor(() => expect(ui.lastFrame()).toContain('Full-screen updates'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('Installing 0.3.0 with npm… 0s'));
    // npm logs each package it fetches, so the output moves while it works.
    expect(install.mock.calls[0].slice(0, 2)).toEqual(['npm', ['install', '-g', '@haydenmeloche/guided-review@latest', '--loglevel=http']]);
    expect(ui.lastFrame()).toContain('registry.npmjs.org/ink');
    expect(ui.lastFrame()).toContain('changed 3 packages in 2s');
    // Nothing stops it halfway, not even Ctrl+C: a half-done global install can leave gr missing.
    ui.stdin.write('n');
    ui.stdin.write('\u0003');
    finish({ status: 0 });
    await waitFor(() => expect(ui.lastFrame()).toContain('Updated to 0.3.0. Restarting gr'));
    expect(onDone).not.toHaveBeenCalled();
    // Only the summary is kept for the scrollback, not npm's progress lines.
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ kind: 'updated', output: ['changed 3 packages in 2s'] }), { timeout: DONE_MS + 1000 });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('quits gr on Ctrl+C before the install starts', async () => {
    const { ui, onDone, install } = screen();
    ui.stdin.write('\u0003');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ kind: 'quit' }));
    expect(install).not.toHaveBeenCalled();
  });

  it('shows coloured installer output as plain text', async () => {
    const { ui, onDone } = screen({
      install: async (_cmd, _args, onOutput) => {
        onOutput('\u001b[32m+\u001b[39m @haydenmeloche/guided-review@0.3.0\n');
        return { status: 0 };
      },
    });
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('+ @haydenmeloche/guided-review@0.3.0'));
    expect(ui.lastFrame()).not.toContain('[32m');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ kind: 'updated', output: ['+ @haydenmeloche/guided-review@0.3.0'] }), { timeout: DONE_MS + 1000 });
  });

  it('offers to try again when the install fails, or to carry on with the installed version', async () => {
    const results = [{ status: 1 }, { status: null, error: new Error('spawn npm ENOENT') }];
    const { ui, onDone, install } = screen({
      install: async (_cmd, _args, onOutput) => {
        onOutput('npm ERR! code EACCES\n');
        return results.shift()!;
      },
    });
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain("Couldn't install 0.3.0: npm exited with code 1"));
    expect(ui.lastFrame()).toContain('npm ERR! code EACCES');
    expect(ui.lastFrame()).toContain('continue with 0.2.0');
    ui.stdin.write('r');
    await waitFor(() => expect(ui.lastFrame()).toContain('spawn npm ENOENT'));
    expect(install).toHaveBeenCalledTimes(2);
    ui.stdin.write(ENTER);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ kind: 'failed', why: 'spawn npm ENOENT' }));
  });
});
