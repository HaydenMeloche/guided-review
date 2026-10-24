import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureRepo, KEY, sandbox, startGr, type Sandbox, type Session } from './harness.js';

let box: Sandbox;
let repo: string;
const sessions: Session[] = [];

beforeEach(() => {
  box = sandbox();
  repo = fixtureRepo(box);
});
afterEach(() => {
  for (const s of sessions.splice(0)) s.kill();
  box.cleanup();
});

function preview(args = ['--no-agent']): Session {
  const session = startGr(box, ['preview', ...args], { cwd: repo });
  sessions.push(session);
  return session;
}

describe('gr preview --no-agent', () => {
  it('opens a briefing built from the local branch', async () => {
    const gr = preview();
    const screen = await gr.waitFor('Chapters · Guided order');
    expect(screen).toContain('feature/discount (preview)');
    expect(screen).toContain('plain mode');
    expect(screen).toContain('Apply a discount to invoice totals');
    expect(screen).toMatch(/0\/1 hunks done/);
    expect(screen).toContain('total: 1 unchanged caller(s) — src/invoice.test.ts:2');
    // Preview only asks gh for the repo name; it never touches a PR.
    expect(box.ghCalls()).toEqual(['repo view --json nameWithOwner']);
  });

  it('names the preview and the current screen in the window title', async () => {
    const gr = preview();
    await gr.waitFor('Chapters · Guided order');
    expect(gr.title()).toMatch(/^gr · preview .+ · briefing$/);
  });

  it('walks the tour to the end and quits cleanly', async () => {
    const gr = preview();
    await gr.waitFor('Chapters · Guided order');
    gr.press('n');
    const chapter = await gr.waitFor('Chapter 1/1');
    expect(chapter).toContain('Chapter 1/1: [total]');
    expect(chapter).toContain('src/invoice.ts:1');
    expect(chapter).toContain('return sum - sum * discount;');
    expect(chapter).toContain('0/1 hunks');
    gr.press('n');
    const end = await gr.waitFor('End of the tour');
    expect(end).toContain('1/1 hunks');
    // q goes up to the briefing; a preview has no PR list, so q there quits.
    gr.press('q');
    await gr.waitFor('Chapters · Guided order');
    gr.press('q');
    expect(await gr.exited).toBe(0);
  });

  it('remembers read progress across runs', async () => {
    const first = preview();
    await first.waitFor('Chapters · Guided order');
    first.press('n');
    await first.waitFor('Chapter 1/1');
    first.press('n');
    await first.waitFor('End of the tour');
    first.press('Q');
    await first.exited;

    const second = preview();
    await second.waitFor(/1\/1 hunks done/);
  });

  it('saves a draft comment on the selected line and keeps it across runs', async () => {
    const first = preview();
    await first.waitFor('Chapters · Guided order');
    first.press('n');
    await first.waitFor('0 draft comment(s)');
    first.press('c');
    await first.waitFor('enter: save draft');
    first.type('Should the discount be clamped to 0..1?');
    await first.waitFor('clamped to 0..1?');
    first.press(KEY.enter);
    await first.waitFor('✎ [question] Should the discount be clamped to 0..1?');
    // An unposted draft: Q asks first, and y quits.
    first.press('Q');
    await first.waitFor('Quit with 1 unposted draft?');
    first.press('y');
    await first.exited;

    const second = preview();
    await second.waitFor('Chapters · Guided order');
    second.press('n');
    await second.waitFor('✎ [question] Should the discount be clamped to 0..1?');
  });
});

describe('gr preview with no AI model configured', () => {
  it('builds a plain tour without --no-agent and hides the ask key', async () => {
    fs.mkdirSync(box.env.GR_HOME!, { recursive: true });
    fs.writeFileSync(path.join(box.env.GR_HOME!, 'config.json'), '{ "provider": "none" }\n');
    const gr = preview([]);
    const screen = await gr.waitFor('Chapters · Guided order');
    expect(screen).toContain('plain mode');
    expect(screen).not.toContain('ask about the PR');
    expect(screen).not.toContain('Agent disabled');
  });
});
