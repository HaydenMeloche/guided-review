import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ChecksScreen } from '../src/tui/ChecksScreen.js';
import type { CheckItem } from '../src/github/gh.js';
import { waitFor } from './helpers/waitFor.js';

const LOG = [
  '##[group]Run pnpm install',
  ...Array.from({ length: 60 }, (_, i) => `install line ${i}`),
  '##[group]Run pnpm test',
  ...Array.from({ length: 40 }, (_, i) => `test output ${i}`),
  '##[error]AssertionError: expected 1 to be 2',
  'after the error',
  '##[error]Process completed with exit code 1.',
]
  .map((l) => `2026-10-15T13:33:26.6289736Z ${l}`)
  .join('\n');

const fetchJobLog = vi.fn(async () => LOG);
vi.mock('../src/github/gh.js', () => ({ fetchJobLog: (...a: unknown[]) => fetchJobLog(...(a as [])), fetchMergeStatus: vi.fn() }));

const checks: CheckItem[] = [
  { name: 'build', state: 'passed', outcome: 'SUCCESS', required: false, workflow: 'CI', jobId: 7, url: 'https://github.com/o/r/actions/runs/1/job/7' },
  { name: 'test', state: 'failed', outcome: 'FAILURE', required: true, workflow: 'CI', jobId: 8, url: 'https://github.com/o/r/actions/runs/1/job/8' },
  { name: 'deploy/preview', state: 'pending', outcome: 'PENDING', required: false, url: 'https://example.com/deploy', description: 'Deploying the preview' },
];

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('the checks popup', () => {
  it('lists failures first and opens a job log at its first error', async () => {
    const ui = render(<ChecksScreen repo="o/r" headSha="abcdef123456" checks={checks} width={100} height={24} onRefresh={() => {}} onClose={() => {}} />);
    const frame = ui.lastFrame()!;
    expect(frame).toContain('Checks on abcdef12 · 1 failed · 1 running · 1 passed');
    const rows = frame.split('\n');
    const at = (s: string) => rows.findIndex((l) => l.includes(s));
    expect(at('✗ CI / test')).toBeLessThan(at('● deploy/preview'));
    expect(at('● deploy/preview')).toBeLessThan(at('✓ CI / build'));
    expect(rows[at('✗ CI / test')]).toContain('failed · required');
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('AssertionError: expected 1 to be 2'));
    expect(fetchJobLog).toHaveBeenCalledWith('o/r', 8);
    const log = ui.lastFrame()!;
    expect(log.split('\n')[1]).toContain('▸ Run pnpm test · lines');
    expect(log).toContain('2 errors');
    expect(log).not.toContain('install line 0');
    expect(log).not.toContain('2026-10-15T');
    ui.stdin.write('n');
    await waitFor(() => expect(ui.lastFrame()).toContain('Process completed with exit code 1.'));
    ui.stdin.write('g');
    await waitFor(() => expect(ui.lastFrame()).toContain('install line 0'));
    ui.stdin.write('\u001b');
    await waitFor(() => expect(ui.lastFrame()).toContain('Checks on abcdef12'));
    ui.unmount();
  });

  it('opens a check without a job log in the browser', async () => {
    const open = vi.fn(async () => {});
    const ui = render(<ChecksScreen repo="o/r" headSha="abcdef123456" checks={checks} width={100} height={24} onRefresh={() => {}} onClose={() => {}} open={open} />);
    ui.stdin.write('j');
    await tick();
    expect(ui.lastFrame()).toContain('Deploying the preview');
    ui.stdin.write('\r');
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://example.com/deploy'));
    await waitFor(() => expect(ui.lastFrame()).toContain('Opened in your browser.'));
    ui.unmount();
  });

  it('closes on esc and refreshes on R', async () => {
    const onClose = vi.fn();
    const onRefresh = vi.fn();
    const ui = render(<ChecksScreen repo="o/r" headSha="abc" checks={[]} width={80} height={12} onRefresh={onRefresh} onClose={onClose} />);
    expect(ui.lastFrame()).toContain('No checks have reported on this commit.');
    ui.stdin.write('R');
    await tick();
    expect(onRefresh).toHaveBeenCalled();
    ui.stdin.write('\u001b');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    ui.unmount();
  });
});
