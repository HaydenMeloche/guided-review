import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { baseRange, lineHistory, parseHistory, type HistoryEntry } from '../src/review/history.js';
import { HistoryPanel } from '../src/tui/chapter/HistoryPanel.js';
import { diffLines, hunk } from './fixtures/tour.js';
import { waitFor } from './helpers/waitFor.js';

let root: string;
let base: string;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Mira', '-c', 'user.email=m@e', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
const write = (text: string) => fs.writeFileSync(path.join(root, 'worker.ts'), text);

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-history-'));
  git('init', '-q', '-b', 'main');
  write('export function run(job) {\n  return job();\n}\n');
  git('add', '-A');
  git('commit', '-qm', 'Add job queue');
  write('export function run(job) {\n  if (job.retries > 3) return;\n  return job();\n}\n');
  git('commit', '-qam', 'Cap retries (#771)');
  write('export function other() {}\nexport function run(job) {\n  if (job.retries > 3) return;\n  return job();\n}\n');
  git('commit', '-qam', 'Add other');
  base = git('rev-parse', 'HEAD');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('line history', () => {
  it('lists the commits that changed the lines at the base, newest first, with their PR', async () => {
    const h = await lineHistory(root, base, 'worker.ts', 3, 3);
    expect(h.map((e) => [e.subject, e.pr, e.author])).toEqual([['Cap retries (#771)', 771, 'Mira']]);
    expect(h[0].patch).toContain('+  if (job.retries > 3) return;');
    // The whole function: both commits that shaped it, not the one that only added lines above it.
    expect((await lineHistory(root, base, 'worker.ts', 2, 5)).map((e) => e.subject)).toEqual(['Cap retries (#771)', 'Add job queue']);
  });

  it('reads PR numbers from a squash or a merge subject', () => {
    expect(parseHistory('\0a\x1fx\x1f1\x1fMerge pull request #12 from x/y\n')[0].pr).toBe(12);
    expect(parseHistory('\0a\x1fx\x1f1\x1fFix #12 in the parser\n')[0].pr).toBeUndefined();
  });

  it('looks up the lines that were there, or the ones the hunk replaced, and none in a new file', () => {
    const h = hunk('h', 'a.ts', diffLines([' a', '-b', '+c', '+d'], 10), { oldStart: 10, oldLines: 2 });
    expect(baseRange(h, [0, 1])).toEqual({ start: 10, end: 11 });
    expect(baseRange(h, [2, 3])).toEqual({ start: 10, end: 11 });
    expect(baseRange(hunk('n', 'new.ts', diffLines(['+x']), { oldStart: 0, oldLines: 0 }), [0, 0])).toBeUndefined();
  });
});

describe('HistoryPanel', () => {
  it('shows a commit’s change on enter and opens its PR on o', async () => {
    const entries: HistoryEntry[] = [
      { sha: 'a', author: 'mira', at: Math.floor(Date.now() / 1000) - 3 * 7 * 86400, subject: 'Cap retries', pr: 771, patch: '@@ -1 +1 @@\n-old\n+new line' },
      { sha: 'b', author: 'tom', at: Math.floor(Date.now() / 1000) - 400 * 86400, subject: 'Add job queue', patch: '' },
    ];
    const onOpenPR = vi.fn();
    const ui = render(<HistoryPanel title="History of worker.ts:3 before the PR" load={async () => entries} width={90} height={14} onOpenPR={onOpenPR} onClose={() => {}} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Cap retries'));
    expect(ui.lastFrame()).toMatch(/21d\s+@mira\s+Cap retries\s+#771/);
    expect(ui.lastFrame()).toContain('1y  @tom');
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('+new line'));
    ui.stdin.write('o');
    await waitFor(() => expect(onOpenPR).toHaveBeenCalledWith(771));
    ui.unmount();
  });
});
