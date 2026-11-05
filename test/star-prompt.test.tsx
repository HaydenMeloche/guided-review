import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/db.js';
import { STAR_URL, StarPrompt } from '../src/tui/StarPrompt.js';

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('the star count', () => {
  let home: string;
  let previousHome: string | undefined;
  let store: Store;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-star-'));
    previousHome = process.env.GR_HOME;
    process.env.GR_HOME = home;
    store = new Store();
  });
  afterEach(() => {
    store.close();
    if (previousHome === undefined) delete process.env.GR_HOME;
    else process.env.GR_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('is due from the fifth posted review until asked, across runs', () => {
    const due = Array.from({ length: 5 }, () => store.countPostedReview(5));
    expect(due).toEqual([false, false, false, false, true]);
    store.close();
    store = new Store();
    expect(store.countPostedReview(5)).toBe(true); // not asked yet, such as when gr quit first
    store.setStarAsked();
    expect(store.countPostedReview(5)).toBe(false);
  });
});

describe('StarPrompt', () => {
  it('stars gr on y and thanks the reviewer', async () => {
    const star = vi.fn(() => Promise.resolve());
    const onDone = vi.fn();
    const ui = render(<StarPrompt star={star} onDone={onDone} onQuit={() => {}} />);
    await tick();
    expect(ui.lastFrame()).toContain('posted 5 reviews');
    ui.stdin.write('y');
    await tick();
    expect(star).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledWith(expect.stringContaining('Thank you'));
    ui.unmount();
  });

  it('gives the link when starring fails', async () => {
    const onDone = vi.fn();
    const ui = render(<StarPrompt star={() => Promise.reject(new Error('HTTP 403\nmore'))} onDone={onDone} onQuit={() => {}} />);
    await tick();
    ui.stdin.write('y');
    await tick();
    expect(onDone).toHaveBeenCalledWith(`Couldn't star it (HTTP 403). You can star it at ${STAR_URL}`);
    ui.unmount();
  });

  it('does not star on Enter, which may be meant for the PR list', async () => {
    const star = vi.fn(() => Promise.resolve());
    const onDone = vi.fn();
    const ui = render(<StarPrompt star={star} onDone={onDone} onQuit={() => {}} />);
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(star).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('does not star on Enter, which may be meant for the PR list', async () => {
    const star = vi.fn(() => Promise.resolve());
    const onDone = vi.fn();
    const ui = render(<StarPrompt star={star} onDone={onDone} onQuit={() => {}} />);
    await tick();
    ui.stdin.write('\r');
    await tick();
    expect(star).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    ui.unmount();
  });

  it('closes without starring on n or Esc', async () => {
    for (const k of ['n', '\u001b']) {
      const star = vi.fn(() => Promise.resolve());
      const onDone = vi.fn();
      const ui = render(<StarPrompt star={star} onDone={onDone} onQuit={() => {}} />);
      await tick();
      ui.stdin.write(k);
      await tick();
      expect(star).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledWith();
      ui.unmount();
    }
  });
});

describe('hasStarredGuidedReview', () => {
  afterEach(() => {
    vi.doUnmock('../src/util/exec.js');
    vi.doUnmock('../src/github/auth.js');
  });

  it('reads 204 as starred and 404 as not, and rethrows anything else', async () => {
    vi.resetModules();
    const run = vi.fn();
    vi.doMock('../src/util/exec.js', async (orig) => ({ ...(await orig<object>()), run }));
    vi.doMock('../src/github/auth.js', async (orig) => ({ ...(await orig<object>()), githubAuth: () => undefined, githubWebHost: () => 'github.com' }));
    const { hasStarredGuidedReview } = await import('../src/github/gh.js');
    run.mockResolvedValueOnce('');
    await expect(hasStarredGuidedReview()).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith('gh', ['api', '--hostname', 'github.com', '-X', 'GET', 'user/starred/HaydenMeloche/guided-review'], {});
    run.mockRejectedValueOnce(Object.assign(new Error('failed'), { stderr: 'gh: Not Found (HTTP 404)' }));
    await expect(hasStarredGuidedReview()).resolves.toBe(false);
    run.mockRejectedValueOnce(Object.assign(new Error('failed'), { stderr: 'gh: Server Error (HTTP 502)' }));
    await expect(hasStarredGuidedReview()).rejects.toThrow('failed');
  });
});
