import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { UpdateScreen } from '../src/tui/UpdateScreen.js';
import { terminalPalette } from '../src/tui/theme.js';
import type { Install, Installer, ReleaseNotes, UpdateResult } from '../src/updateCheck.js';
import { waitFor } from './helpers/waitFor.js';

const ENTER = '\r';
const installer = (current: Installer['current'] = async () => ({ version: '0.3.0', where: '/usr/local/bin/guided-review' })) => ({
  name: 'npm',
  command: ['npm', ['install', '-g', '@haydenmeloche/guided-review@latest']] as [string, string[]],
  current,
});
const notes: ReleaseNotes[] = [
  { version: '0.3.0', date: '2026-10-20', body: '## Highlights\n\n- **Full-screen updates** with release notes' },
  { version: '0.2.1', body: '- Fixes a crash' },
];

function screen(opts: { notes?: Promise<ReleaseNotes[] | undefined>; install?: Install; current?: Installer['current']; then?: 'restart' | 'exit'; deprecated?: string } = {}) {
  const onDone = vi.fn<(r: UpdateResult) => void>();
  const install = vi.fn<Install>(opts.install ?? (async () => ({ status: 0 })));
  const offer = { installed: '0.2.0', latest: '0.3.0', installer: installer(opts.current), deprecated: opts.deprecated };
  const ui = render(<UpdateScreen offer={offer} then={opts.then ?? 'restart'} initial={terminalPalette} notes={opts.notes ?? Promise.resolve(notes)} install={install} onDone={onDone} />);
  return { ui, onDone, install };
}

describe('update screen', () => {
  it("offers the version jump with what's new in every release since the installed one", async () => {
    const { ui } = screen();
    await waitFor(() => expect(ui.lastFrame()).toContain('Full-screen updates'));
    const frame = ui.lastFrame()!;
    expect(frame).toContain('Update available 0.2.0 → 0.3.0');
    expect(frame).toContain('Runs npm install -g @haydenmeloche/guided-review@latest, then restarts gr.');
    expect(frame).toContain('0.3.0 · 2026-10-20');
    expect(frame).toContain('Fixes a crash');
    expect(frame).toContain('skip this version');
  });

  it("says why a deprecated version should update, and doesn't let it be skipped", async () => {
    const { ui, onDone } = screen({ deprecated: 'Fixes a token leak; please update' });
    await waitFor(() => expect(ui.lastFrame()).toContain('0.2.0 is deprecated: Fixes a token leak; please update'));
    expect(ui.lastFrame()).not.toContain('skip this version');
    ui.stdin.write('s');
    ui.stdin.write('n');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ kind: 'later' }));
    expect(onDone).toHaveBeenCalledTimes(1);
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

  it('installs on Enter, showing the output as it runs, then says it updated', async () => {
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
    await waitFor(() => expect(ui.lastFrame()).toContain('Updated to 0.3.0'));
    expect(ui.lastFrame()).toContain('Enter restarts gr on 0.3.0');
    expect(ui.lastFrame()).toContain('changed 3 packages in 2s');
    expect(onDone).not.toHaveBeenCalled();
    ui.stdin.write(ENTER);
    // Only the summary is kept for the scrollback, not npm's progress lines.
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ kind: 'updated', output: ['changed 3 packages in 2s'] }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('ends after gr update, and Ctrl+C on the last screen quits instead of restarting', async () => {
    const { ui, onDone } = screen({ then: 'exit' });
    expect(ui.lastFrame()).toContain('Runs npm install -g @haydenmeloche/guided-review@latest.');
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('The next gr you run is 0.3.0'));
    ui.stdin.write('\u0003');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ kind: 'updated', output: [], quit: true }));
  });

  it('points at the releases page when GitHub cannot be reached', async () => {
    const { ui } = screen({ notes: Promise.resolve(undefined) });
    await waitFor(() => expect(ui.lastFrame()).toContain("Couldn't load the release notes"));
    expect(ui.lastFrame()).toContain('github.com/HaydenMeloche/guided-review/releases');
  });

  it('says so when the install leaves another copy of gr first on PATH', async () => {
    const { ui, onDone } = screen({ current: async () => ({ version: '0.2.0', where: '/opt/node18/bin/guided-review' }) });
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain('npm installed 0.3.0, but the gr on your PATH is still 0.2.0'));
    expect(ui.lastFrame()).toContain('Your PATH runs /opt/node18/bin/guided-review');
    expect(ui.lastFrame()).not.toContain('Updated to');
    ui.stdin.write(ENTER);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ kind: 'failed', why: 'installed, but the gr on your PATH (/opt/node18/bin/guided-review) is still 0.2.0' }));
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
    await waitFor(() => expect(ui.lastFrame()).toContain('Updated to 0.3.0'));
    ui.stdin.write(ENTER);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ kind: 'updated', output: ['+ @haydenmeloche/guided-review@0.3.0'] }));
  });

  it('offers to try again when the install fails, or to carry on with the installed version', async () => {
    const results = [{ status: 1 }, { status: null, error: new Error('spawn npm ENOENT') }];
    const { ui, onDone, install } = screen({
      install: async (_cmd, _args, onOutput) => {
        onOutput('npm ERR! code E404\n');
        return results.shift()!;
      },
    });
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain("Couldn't install 0.3.0: npm exited with code 1"));
    expect(ui.lastFrame()).toContain('npm ERR! code E404');
    expect(ui.lastFrame()).toContain('continue with 0.2.0');
    ui.stdin.write('r');
    await waitFor(() => expect(ui.lastFrame()).toContain('spawn npm ENOENT'));
    expect(install).toHaveBeenCalledTimes(2);
    ui.stdin.write(ENTER);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ kind: 'failed', why: 'spawn npm ENOENT' }));
  });

  it('explains a permissions failure', async () => {
    const { ui } = screen({
      install: async (_cmd, _args, onOutput) => {
        onOutput('npm ERR! code EACCES\nnpm ERR! Error: EACCES: permission denied, rename\n');
        return { status: 243 };
      },
    });
    ui.stdin.write(ENTER);
    await waitFor(() => expect(ui.lastFrame()).toContain("npm can't write to its global folder"));
    expect(ui.lastFrame()).toContain('resolving-eacces-permissions-errors');
  });
});
