import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { KEY, sandbox, startGr, type Sandbox, type Session } from './harness.js';

let box: Sandbox;
const sessions: Session[] = [];

beforeEach(() => {
  box = sandbox();
});
afterEach(() => {
  for (const s of sessions.splice(0)) s.kill();
  box.cleanup();
});

// The tutor's demo tour, explored on its own: esc on the welcome leaves the lessons
// (test/e2e/tutor.e2e.test.ts walks them).
async function demo(): Promise<Session> {
  const session = startGr(box, ['tutor'], { cwd: box.root, cols: 160, rows: 50 });
  sessions.push(session);
  await session.waitFor('explore on my own');
  await session.idle();
  session.press(KEY.escape);
  for (let i = 0; i < 200 && session.screen().includes('Tutor ·'); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  await session.idle();
  return session;
}

describe('the demo tour', () => {
  it('opens a narrated sample tour with no config, no gh and no model', async () => {
    const gr = await demo();
    const screen = await gr.waitFor('Chapters · Guided order');
    // No setup first: the demo needs no model.
    expect(fs.existsSync(path.join(box.env.GR_HOME!, 'config.json'))).toBe(false);
    expect(fs.existsSync(path.join(box.env.GR_HOME!, 'demo', 'src', 'pricing.ts'))).toBe(true);
    expect(screen).toContain('Add discount codes to quotes and orders (demo)');
    // The written-out briefing: chapter titles in its order; i reads its intent (no model to write more).
    expect(screen).toMatch(/1 · Taking a code at POST \/orders[\s\S]*2 · Pricing an order with a discount[\s\S]*3 · formatReceipt moves to receipt\.ts/);
    expect(screen).toContain('Generated code');
    expect(screen).toContain('Import-only changes');
    gr.press('i');
    expect(await gr.waitFor('— summary')).toContain('Lets customers enter a discount code at checkout.');
    gr.press(KEY.escape);
    await gr.waitFor('Chapters · ');
    gr.press('n');
    expect(await gr.waitFor('hunk 1/')).toContain('Nothing here checks that it is a');
    // No model: a answers prepared questions about the code.
    gr.press('a');
    await gr.waitFor('prepared answers, demo');
    expect(box.ghCalls()).toEqual([]);
  });

  it('shows the submit screen but posts nothing', async () => {
    const gr = await demo();
    await gr.waitFor('Chapters · Guided order');
    gr.press('s');
    expect(await gr.waitFor('This is the demo: nothing is posted.')).toContain('Suggested:');
    gr.press('P');
    await gr.idle();
    expect(gr.screen()).not.toContain('Post a');
    expect(box.ghCalls()).toEqual([]);
    gr.press(KEY.escape);
    await gr.waitFor('Chapters · Guided order');
  });

  it('starts over on each run', async () => {
    const gr = await demo();
    await gr.waitFor('Chapters · Guided order');
    gr.press('n');
    await gr.waitFor('hunk 1/');
    gr.press('n');
    await gr.idle();
    gr.press('Q');
    expect(await gr.exited).toBe(0);

    // Read before, unread again: the demo forgets the last run.
    const again = await demo();
    expect(await again.waitFor('Chapters · Guided order')).toContain('0/9 hunks done');
  });
});
