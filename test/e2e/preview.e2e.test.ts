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

function preview(args = ['--no-agent'], env?: NodeJS.ProcessEnv): Session {
  const session = startGr(box, ['preview', ...args], { cwd: repo, env });
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
    expect(screen).toContain('total: 1 unchanged caller — src/invoice.test.ts:2');
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
    const chapter = await gr.waitFor(/^1\/1 total/m);
    expect(chapter).toContain('1/1 total · hunk 1/1 · last chapter');
    expect(chapter).toContain('src/invoice.ts:1');
    expect(chapter).toContain('return sum - sum * discount;');
    expect(chapter).toContain('0/1 hunks');
    gr.press('n');
    const end = await gr.waitFor('End of the tour');
    expect(end).toContain('1/1 hunks');
    expect(end).toContain('✓ 1 read');
    expect(end).toContain('Suggested verdict: Approve');
    // Any key but s closes the card; q goes up to the briefing, and in a preview, which has no
    // PR list, q there quits.
    gr.press(KEY.escape);
    for (let i = 0; i < 200 && gr.screen().includes('End of the tour'); i++) await new Promise((r) => setTimeout(r, 25));
    await gr.idle();
    gr.press('q');
    await gr.waitFor('Chapters · Guided order');
    gr.press('q');
    expect(await gr.exited).toBe(0);
  });

  it('remembers read progress across runs', async () => {
    const first = preview();
    await first.waitFor('Chapters · Guided order');
    first.press('n');
    await first.waitFor(/^1\/1 total/m);
    first.press('n');
    await first.waitFor('End of the tour');
    first.press('Q');
    await first.exited;

    const second = preview();
    const briefing = await second.waitFor(/1\/1 hunks done/);
    // n says where it picks up.
    expect(briefing).toContain('n resume · chapter 1, hunk 1/1');
  });

  it('saves a draft comment on the selected line and keeps it across runs', async () => {
    // The headless terminal does not answer the kitty keyboard query, so the protocol is forced on.
    const first = preview(['--no-agent'], { GR_KITTY_KEYBOARD: 'enabled' });
    await first.waitFor('Chapters · Guided order');
    first.press('n');
    await first.waitFor('0 drafts');
    first.press('c');
    await first.waitFor('enter save');
    first.type('Should the discount be clamped');
    await first.waitFor('be clamped');
    // Shift+Enter as the kitty keyboard protocol sends it (CSI 13;2u) adds a line, not a save.
    first.press('\u001b[13;2u');
    await first.idle();
    first.type('to 0..1?');
    await first.waitFor('to 0..1?');
    expect(first.screen()).toContain('Should the discount be clamped');
    first.press(KEY.enter);
    await first.waitFor('question  Should the discount be clamped to 0..1?');
    // A preview's drafts have no PR to post to, so Q quits without asking about them.
    first.press('Q');
    expect(await first.exited).toBe(0);

    const second = preview();
    await second.waitFor('Chapters · Guided order');
    second.press('n');
    await second.waitFor('question  Should the discount be clamped to 0..1?');
  });
});

describe('local changes from the PR list', () => {
  it('tours the checked-out branch on l and comes back to the list on q', async () => {
    const gr = startGr(box, ['--no-agent'], { cwd: repo });
    sessions.push(gr);
    const list = await gr.waitFor(/Review requests \(0\)/);
    expect(list).toContain('local changes');
    gr.press('l');
    const briefing = await gr.waitFor('Chapters · Guided order');
    expect(briefing).toContain('feature/discount (preview)');
    expect(gr.title()).toMatch(/^gr · preview .+ · briefing$/);
    gr.press('q');
    await gr.waitFor(/Review requests \(0\)/);
    gr.press('q');
    expect(await gr.exited).toBe(0);
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
