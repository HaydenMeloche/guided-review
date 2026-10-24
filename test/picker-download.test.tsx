import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { PickerScreen, progressBar, type DownloadJob, type Target } from '../src/tui/PickerScreen.js';
import type { Store } from '../src/store/db.js';
import { waitFor } from './helpers/waitFor.js';

vi.mock('../src/github/gh.js', () => ({
  listReviewRequests: vi.fn(async () => [
    { repo: 'acme/app', number: 1, title: 'First', author: 'dev', url: 'https://github.com/acme/app/pull/1', updatedAt: '2026-10-08T00:00:00Z', isDraft: false, labels: [] },
    { repo: 'acme/app', number: 2, title: 'Second', author: 'dev', url: 'https://github.com/acme/app/pull/2', updatedAt: '2026-10-08T00:00:00Z', isDraft: false, labels: [] },
  ]),
  fetchPRPreview: vi.fn(async () => ({
    headRefName: 'feature',
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
  })),
}));

const store = { listTours: () => [], listDrafts: () => [] } as unknown as Store;
const noClipboard = async () => undefined;

// Stands in for the app: holds the download jobs and lets the test drive them.
function harness(opts: { onPick?: (t: Target) => void; onQuit?: () => void } = {}) {
  const requests: Target[][] = [];
  let set: (key: string, job: DownloadJob) => void = () => {};
  function Host() {
    const [downloads, setDownloads] = useState<Record<string, DownloadJob>>({});
    set = (key, job) => setDownloads((d) => ({ ...d, [key]: job }));
    return (
      <PickerScreen
        store={store}
        width={120}
        height={25}
        onPick={opts.onPick ?? (() => {})}
        onQuit={opts.onQuit ?? (() => {})}
        readClipboard={noClipboard}
        downloads={downloads}
        onDownload={(targets) => {
          requests.push(targets);
          for (const t of targets) set(`${t.repo}#${t.number}`, { state: 'queued' });
        }}
      />
    );
  }
  const ui = render(<Host />);
  return { ui, requests, set: (key: string, job: DownloadJob) => set(key, job) };
}

// Keys pressed before the list loads are dropped.
const loaded = (ui: ReturnType<typeof render>) => waitFor(() => expect(ui.lastFrame()).toContain('Second'));

describe('picker tour downloads', () => {
  it('downloads the highlighted PR when none are marked', async () => {
    const { ui, requests } = harness();
    await loaded(ui);
    ui.stdin.write('j');
    await waitFor(() => expect(ui.lastFrame()).toMatch(/│ acme\/app#2/));
    ui.stdin.write('d');
    await waitFor(() => expect(requests).toEqual([[{ repo: 'acme/app', number: 2 }]]));
    ui.unmount();
  });

  it('downloads all marked PRs, animates them per row, then summarizes', async () => {
    const onPick = vi.fn();
    const { ui, requests, set } = harness({ onPick });
    await loaded(ui);
    ui.stdin.write('a');
    await waitFor(() => {
      expect(ui.lastFrame()).toContain('☑ #1');
      expect(ui.lastFrame()).toContain('☑ #2');
    });
    ui.stdin.write('d');
    await waitFor(() =>
      expect(requests).toEqual([
        [
          { repo: 'acme/app', number: 1 },
          { repo: 'acme/app', number: 2 },
        ],
      ]),
    );
    set('acme/app#1', { state: 'running', step: 'Tracing flows' });
    await waitFor(() => {
      expect(ui.lastFrame()).toContain('Tracing flows…');
      expect(ui.lastFrame()).toContain('queued for download');
      expect(ui.lastFrame()).toContain('   0/2 · 1 downloading · 1 queued');
    });
    set('acme/app#1', { state: 'done' });
    set('acme/app#2', { state: 'running', step: 'Writing chapters' });
    await waitFor(() => {
      expect(ui.lastFrame()).toContain('✓ #1');
      expect(ui.lastFrame()).toContain('1/2 · 1 downloading');
    });
    set('acme/app#2', { state: 'done' });
    await waitFor(() => expect(ui.lastFrame()).toContain('Downloaded 2 tours. Ready to open.'));
    expect(onPick).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('queues more PRs while a download runs and keeps the list usable', async () => {
    const onPick = vi.fn();
    const onQuit = vi.fn();
    const { ui, requests, set } = harness({ onPick, onQuit });
    await loaded(ui);
    ui.stdin.write('d');
    await waitFor(() => expect(requests).toHaveLength(1));
    set('acme/app#1', { state: 'running', step: 'Fetching the PR' });
    await waitFor(() => expect(ui.lastFrame()).toContain('Fetching the PR'));
    // Pressing d again on the same PR does nothing; enter on it explains why it waits.
    ui.stdin.write('d');
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('acme/app#1 is still downloading'));
    expect(requests).toHaveLength(1);
    expect(onPick).not.toHaveBeenCalled();
    ui.stdin.write('j');
    await waitFor(() => expect(ui.lastFrame()).toMatch(/│ acme\/app#2/));
    ui.stdin.write('d');
    await waitFor(() => expect(requests).toEqual([[{ repo: 'acme/app', number: 1 }], [{ repo: 'acme/app', number: 2 }]]));
    set('acme/app#1', { state: 'failed', error: 'gh exploded' });
    set('acme/app#2', { state: 'done' });
    await waitFor(() => {
      expect(ui.lastFrame()).toContain('Downloaded 1/2 tours. Failed: acme/app#1 (gh exploded)');
      expect(ui.lastFrame()).toContain('✗ #1');
    });
    // A PR that isn't downloading opens normally.
    ui.stdin.write('\r');
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({ repo: 'acme/app', number: 2 }));
    ui.stdin.write('q');
    await waitFor(() => expect(onQuit).toHaveBeenCalled());
    ui.unmount();
  });
});

describe('progressBar', () => {
  it('fills by finished tours and sweeps a comet through the rest', () => {
    expect(progressBar(1, 2, 0, 10)).toEqual({ filled: '█████', rest: '▓░░░░' });
    expect(progressBar(1, 2, 2, 10).rest).toBe('░▒▓░░');
    expect(progressBar(2, 2, 5, 10)).toEqual({ filled: '██████████', rest: '' });
  });
});
