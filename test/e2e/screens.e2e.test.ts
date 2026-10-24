import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { KEY, richFixtureRepo, sandbox, startGr, type Sandbox, type Session } from './harness.js';

// Golden screens: each screen at three terminal sizes, with its colors and styles, checked in
// under __screens__. A layout or color change shows up as a diff of these files; accept it with
// `pnpm test:e2e -u` only when the new look is intended.

const SIZES = [
  [80, 24],
  [120, 36],
  [200, 50],
] as const;

let box: Sandbox;
const sessions: Session[] = [];

beforeEach(() => {
  box = sandbox();
});
afterEach(() => {
  for (const s of sessions.splice(0)) s.kill();
  box.cleanup();
});

// What changes from run to run: spinner frames, clocks, and ages.
const stable = (screen: string) =>
  screen
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '⠿')
    .replace(/\b\d+:\d\d\b/g, '0:00')
    .replace(/\b\d+(s|m|h|d|mo|y) ago\b/g, 'N ago');

const file = (name: string, cols: number, rows: number) => path.join(import.meta.dirname, '__screens__', `${name}-${cols}x${rows}.txt`);

// Waits for an overlay to close: what was under it is on screen the whole time, so waiting for
// that would race the next key into the closing overlay.
async function gone(gr: Session, text: string) {
  for (let i = 0; i < 200 && gr.screen().includes(text); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  return gr.idle();
}

// Keys sent one at a time: written close together they arrive as one input, which gr reads as
// typed text, so each waits for the frame it causes.
async function keys(gr: Session, ...ks: string[]) {
  for (const k of ks) {
    gr.press(k);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await gr.idle();
  }
}

async function snap(gr: Session, name: string, cols: number, rows: number) {
  await expect(stable(gr.screenWithAttrs()) + '\n').toMatchFileSnapshot(file(name, cols, rows));
}

describe.each(SIZES)('screens at %ix%i', (cols, rows) => {
  it('walks the preview tour', async () => {
    const repo = richFixtureRepo(box);
    const gr = startGr(box, ['preview', '--no-agent'], { cwd: repo, cols, rows });
    sessions.push(gr);
    await gr.waitFor('Chapters');
    await snap(gr, 'briefing', cols, rows);

    gr.press('L');
    await gr.waitFor('Terminal colors');
    await snap(gr, 'theme-picker', cols, rows);
    gr.press(KEY.escape);
    await gone(gr, 'Terminal colors');

    gr.press('n');
    await gr.waitFor(/hunk 1\//);
    await snap(gr, 'chapter', cols, rows);

    await keys(gr, 'j');
    await snap(gr, 'chapter-cursor', cols, rows);

    await keys(gr, 'v', 'j', 'j');
    await snap(gr, 'chapter-range', cols, rows);
    gr.press(KEY.escape);
    await gr.idle();

    gr.press('?');
    await gr.waitFor('Keys · chapter');
    await snap(gr, 'help', cols, rows);
    gr.press(KEY.tab);
    await gr.waitFor('Marks · chapter');
    await snap(gr, 'help-marks', cols, rows);
    gr.press(KEY.escape);
    await gone(gr, 'Marks · chapter');

    gr.press('c');
    await gr.waitFor('Comment');
    gr.type('Before tax?');
    await gr.waitFor('Before tax?');
    gr.press(KEY.enter);
    await gr.waitFor('✎ [question]');
    await snap(gr, 'chapter-draft', cols, rows);

    gr.press('s');
    await gr.waitFor('Author preview');
    await snap(gr, 'submit', cols, rows);
  });

  it('paints the cursor and a range with a theme', async () => {
    fs.mkdirSync(box.env.GR_HOME!, { recursive: true });
    fs.writeFileSync(path.join(box.env.GR_HOME!, 'config.json'), JSON.stringify({ provider: 'none', theme: 'github-dark' }));
    const repo = richFixtureRepo(box);
    const gr = startGr(box, ['preview'], { cwd: repo, cols, rows });
    sessions.push(gr);
    await gr.waitFor('Chapters');
    gr.press('n');
    await gr.waitFor(/hunk 1\//);
    await keys(gr, 'v', 'j', 'j');
    await snap(gr, 'chapter-range-themed', cols, rows);
  });

  it('shows the PR list when gh cannot list PRs', async () => {
    const gr = startGr(box, ['--no-agent'], { cwd: box.root, cols, rows });
    sessions.push(gr);
    await gr.waitFor('failed:');
    await gr.waitFor(/Review requests \(0\)/);
    await snap(gr, 'picker-error', cols, rows);
  });
});
