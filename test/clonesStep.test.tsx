import React from 'react';
import { render } from 'ink-testing-library';
import { expect, it, vi } from 'vitest';
import { ClonesStep, countLine, scannedLine } from '../src/tui/ClonesStep.js';
import type { ScanResult } from '../src/git/clones.js';
import { waitFor } from './helpers/waitFor.js';

const ENTER = '\r';
const CTRL_R = '\u0012';
const HOME = '/home/me';

const FOUND: Record<string, ScanResult['clones']> = {
  [`${HOME}/code`]: { 'org/app': `${HOME}/code/app` },
  [`${HOME}/work/pine`]: { 'pine/evergreen': `${HOME}/work/pine/evergreen` },
};

function step(known: ScanResult['clones'] = {}) {
  const scan = vi.fn(async (folder: string): Promise<ScanResult> => ({ folder, clones: FOUND[folder] ?? {} }));
  const targets = vi.fn(async () => ['code', 'work', 'work/pine', 'work/pine/evergreen', 'notes']);
  const onDone = vi.fn();
  const onBack = vi.fn();
  const ui = render(<ClonesStep width={100} height={20} start={`${HOME}/code`} home={HOME} known={known} scan={scan} targets={targets} onBack={onBack} onDone={onDone} />);
  return { ui, scan, targets, onDone, onBack };
}

it('scans the folder setup runs in and lists what it found next to what was known', async () => {
  const { ui, scan, onDone } = step({ 'org/lib': `${HOME}/code/lib` });
  await waitFor(() => expect(ui.lastFrame()).toContain('2 clones, 1 new'));
  expect(ui.lastFrame()).toContain('Scanned ~/code');
  expect(ui.lastFrame()).toContain('ctrl+r  Search for another folder to scan');
  expect(scan).toHaveBeenCalledWith(`${HOME}/code`);
  expect(ui.lastFrame()).toMatch(/org\/app\s+~\/code\/app new/);
  expect(ui.lastFrame()).toMatch(/org\/lib\s+~\/code\/lib\n/);
  ui.stdin.write(ENTER);
  await waitFor(() => expect(onDone).toHaveBeenCalledWith({ 'org/app': `${HOME}/code/app` }));
  ui.unmount();
});

it('searches the folders under home with Ctrl+R and scans the one chosen', async () => {
  const { ui, scan, onDone } = step();
  await waitFor(() => expect(ui.lastFrame()).toContain('1 clone found'));
  // Typed straight after Ctrl+R, as a paste would arrive.
  ui.stdin.write(CTRL_R);
  ui.stdin.write('pine');
  await waitFor(() => expect(ui.lastFrame()).toContain('> pine'));
  expect(ui.lastFrame()).not.toContain('~/notes');
  ui.stdin.write(ENTER);
  await waitFor(() => expect(scan).toHaveBeenCalledWith(`${HOME}/work/pine`));
  await waitFor(() => expect(ui.lastFrame()).toContain('2 clones found'));
  expect(ui.lastFrame()).toContain('Scanned ~/work/pine and ~/code');
  ui.stdin.write(ENTER);
  await waitFor(() => expect(onDone).toHaveBeenCalledWith({ 'org/app': `${HOME}/code/app`, 'pine/evergreen': `${HOME}/work/pine/evergreen` }));
  ui.unmount();
});

it('scans a typed path that no folder under home matches, and Esc leaves the search', async () => {
  const { ui, scan, onBack } = step();
  await waitFor(() => expect(ui.lastFrame()).toContain('Scanned ~/code'));
  ui.stdin.write('/');
  await waitFor(() => expect(ui.lastFrame()).toContain('Scan another folder'));
  ui.stdin.write('/srv/repos');
  await waitFor(() => expect(ui.lastFrame()).toContain('Enter scans /srv/repos'));
  ui.stdin.write(ENTER);
  await waitFor(() => expect(scan).toHaveBeenCalledWith('/srv/repos'));
  ui.stdin.write('/');
  await waitFor(() => expect(ui.lastFrame()).toContain('Scan another folder'));
  ui.stdin.write('\u001B');
  await waitFor(() => expect(ui.lastFrame()).toContain('Local clones'));
  expect(onBack).not.toHaveBeenCalled();
  ui.unmount();
});

it('says how many clones there are and which folders were scanned, newest first', () => {
  expect(countLine(0, 0)).toBe('No clones found yet');
  expect(countLine(25, 25)).toBe('25 clones found');
  expect(countLine(25, 3)).toBe('25 clones, 3 new');
  expect(countLine(1, 0)).toBe('1 clone, none new');
  expect(scannedLine(['~/a'])).toBe('Scanned ~/a');
  expect(scannedLine(['~/a', '~/b', '~/c', '~/d'])).toBe('Scanned ~/d, ~/c and 2 more folders');
});
