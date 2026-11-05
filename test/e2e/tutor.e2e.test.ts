import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KEY, richFixtureRepo, sandbox, startGr, type Sandbox, type Session } from './harness.js';

// gr tutor, driven through the pty by pressing the keys it asks for. GR_DEMO_INSTANT makes
// prepared answers and the pause after a done step instant.

let box: Sandbox;
const sessions: Session[] = [];

beforeEach(() => {
  box = sandbox();
});
afterEach(() => {
  for (const s of sessions.splice(0)) s.kill();
  box.cleanup();
});

function tutor(): Session {
  const session = startGr(box, ['tutor'], { cwd: box.root, cols: 120, rows: 36, env: { GR_DEMO_INSTANT: '1' } });
  sessions.push(session);
  return session;
}

// Presses a key, then waits for what it brings: a step, named by its lesson and number in the
// callout's title (its text may wrap anywhere), or a text.
async function step(gr: Session, key: string, after: string | RegExp) {
  await gr.idle();
  gr.press(key);
  return gr.waitFor(after);
}
const at = (lesson: string, n: number) => new RegExp(`${lesson} · ${n}/\\d`);

// Waits for a text to leave the screen. Esc reaches gr after a pause (it may start a sequence), so
// the screen can be quiet before it lands.
async function gone(gr: Session, text: string) {
  for (let i = 0; i < 200 && gr.screen().includes(text); i++) await new Promise((resolve) => setTimeout(resolve, 25));
  await gr.idle();
  return gr.screen();
}

const BACKSPACE = '\x7f';

describe('gr tutor', () => {
  it('walks every lesson with the keys it asks for', async () => {
    const gr = tutor();
    expect(await gr.waitFor('Tutor · lesson 1 of 9 · Welcome · 1/3')).toContain('Every key you learn here is the real key.');
    await step(gr, KEY.enter, at('Welcome', 2));
    // Backspace goes back a step.
    await step(gr, BACKSPACE, at('Welcome', 1));
    await step(gr, KEY.enter, at('Welcome', 2));
    await step(gr, KEY.enter, at('Welcome', 3));
    await step(gr, 'n', at('Where you are', 1));
    await step(gr, KEY.enter, at('Where you are', 2));
    await step(gr, KEY.enter, at('Where you are', 3));
    await step(gr, KEY.enter, at('Move through the tour', 1));
    await step(gr, 'n', at('Move through the tour', 2));
    await gr.waitFor('chapter 2/7');
    await step(gr, KEY.enter, at('Move through the tour', 3));
    await step(gr, ']', at('Move through the tour', 4));
    await gr.waitFor('chapter 3/7');
    // Read the code: on the pricing hunk, which has tests.
    await step(gr, KEY.enter, at('Read the code', 1));
    await gr.waitFor('src/pricing.ts');
    await step(gr, 'j', at('Read the code', 2));
    await step(gr, KEY.enter, at('Read the code', 3));
    await step(gr, 't', at('Read the code', 4));
    await step(gr, 't', at('Already done for you', 1));
    await step(gr, KEY.enter, at('Already done for you', 2));
    await gr.waitFor('package change in the lockfile');
    await step(gr, KEY.enter, at('Already done for you', 3));
    await step(gr, KEY.enter, at('Leave a comment', 1));
    await gr.waitFor(/▶ +18 │/);
    await step(gr, KEY.enter, at('Leave a comment', 2));
    await step(gr, 'c', at('Leave a comment', 3));
    gr.type('Anyone can type STAFF50.');
    await gr.waitFor('Anyone can type STAFF50.');
    await step(gr, KEY.enter, at('Leave a comment', 4));
    await step(gr, KEY.enter, at('Ask about the code', 1));
    await step(gr, 'a', at('Ask about the code', 2));
    await gr.waitFor('prepared answers, demo');
    // 1 asks the first prepared question; its answer cites the lines it relies on.
    expect(await step(gr, '1', at('Ask about the code', 3))).toContain('src/pricing.ts:30');
    await step(gr, KEY.escape, at('Find anything', 1));
    await step(gr, '/', at('Find anything', 2));
    gr.type('STAFF50');
    await gr.idle();
    await step(gr, KEY.enter, at('Find anything', 3));
    await step(gr, ':', at('Find anything', 4));
    await step(gr, KEY.enter, at('Submit', 1));
    await step(gr, 's', at('Submit', 2));
    await gr.waitFor('This is the demo: nothing is posted.');
    await step(gr, KEY.enter, at('Submit', 3));
    gr.press(KEY.enter);
    // Finished: the demo is left to look around in.
    expect(await gone(gr, 'Tutor ·')).toContain('Drafts (1)');
    expect(box.ghCalls()).toEqual([]);
  }, 90_000);

  it('offers the way back from off the lesson’s path', async () => {
    const gr = tutor();
    await gr.waitFor(at('Welcome', 1));
    await step(gr, KEY.enter, at('Welcome', 2));
    await step(gr, KEY.enter, at('Welcome', 3));
    await step(gr, 'n', at('Where you are', 1));
    await step(gr, KEY.enter, at('Where you are', 2));
    await step(gr, KEY.enter, at('Where you are', 3));
    await step(gr, KEY.enter, at('Move through the tour', 1));
    // b is not what the step asks for, and still works: the tutor offers to go back.
    await step(gr, 'b', 'This lesson is on chapter 1.');
    expect(gr.screen()).toContain('Chapters · Guided order');
    gr.press(KEY.enter);
    expect(await gone(gr, 'This lesson is on')).toContain('chapter 1/7');
    expect(gr.screen()).toMatch(at('Move through the tour', 1));
    // esc there leaves you to look around, and the palette has the way back.
    await step(gr, 'b', 'This lesson is on chapter 1.');
    gr.press(KEY.escape);
    expect(await gone(gr, 'This lesson is on')).not.toContain('Tutor ·');
    await step(gr, ':', 'Tutor: back to the lesson (chapter 1)');
    gr.type('back to the lesson');
    await gr.idle();
    await step(gr, KEY.enter, at('Move through the tour', 1));
    expect(gr.screen()).toContain('chapter 1/7');
  });

  it('asks before Q leaves it, and picks up there next time', async () => {
    const gr = tutor();
    await gr.waitFor(at('Welcome', 1));
    await step(gr, KEY.enter, at('Welcome', 2));
    await step(gr, KEY.enter, at('Welcome', 3));
    await step(gr, 'n', at('Where you are', 1));
    await step(gr, 'Q', 'Leave the tutor? You can pick up at lesson 2 next time.');
    gr.press('y');
    expect(await gr.exited).toBe(0);

    const again = tutor();
    expect(await again.waitFor('Welcome back.')).toContain('continue at lesson 2');
    await step(again, KEY.enter, at('Where you are', 1));
    expect(again.screen()).toContain('chapter 1/7');
  });

  it('leaves the demo to explore on esc', async () => {
    const gr = tutor();
    await gr.waitFor(at('Welcome', 1));
    gr.press(KEY.escape);
    expect(await gone(gr, 'Tutor ·')).toContain('Chapters · Guided order');
    await step(gr, 'n', 'hunk 1/1');
    expect(gr.screen()).not.toContain('Tutor ·');
  });

  it('ends with a choice: keep exploring, set gr up, or quit', async () => {
    const gr = tutor();
    await gr.waitFor(at('Welcome', 1));
    await step(gr, KEY.enter, at('Welcome', 2));
    await step(gr, KEY.enter, at('Welcome', 3));
    await step(gr, 'n', at('Where you are', 1));
    await step(gr, KEY.enter, at('Where you are', 2));
    await step(gr, KEY.enter, at('Where you are', 3));
    await step(gr, KEY.enter, at('Move through the tour', 1));
    // The palette's skip, typed so it is the first match.
    const skip = async (n: number, to: string) => {
      await step(gr, ':', 'a command, a file, or a chapter');
      gr.type(`skip to lesson ${n}`);
      await gr.waitFor(`Tutor: skip to lesson ${n}`);
      await step(gr, KEY.enter, at(to, 1));
    };
    // The palette is the screen's, so the skips are from steps that ask for a key.
    await skip(4, 'Read the code');
    await skip(5, 'Already done for you');
    await step(gr, KEY.enter, at('Already done for you', 2));
    await step(gr, KEY.enter, at('Already done for you', 3));
    await skip(6, 'Leave a comment');
    await step(gr, KEY.enter, at('Leave a comment', 2));
    await skip(7, 'Ask about the code');
    await skip(8, 'Find anything');
    await skip(9, 'Submit');
    await step(gr, 's', at('Submit', 2));
    expect(await step(gr, KEY.enter, at('Submit', 3))).toMatch(/enter keep exploring +c set up Guided Review +q quit/);
    // c closes the demo for guided-review config, which offers to walk through setup.
    gr.press('c');
    await gr.waitFor('walk through setup');
  });

  it('opens from a tour with : Tutor and goes back to the same hunk', async () => {
    const repo = richFixtureRepo(box);
    const gr = startGr(box, ['preview', '--no-agent'], { cwd: repo, cols: 120, rows: 36, env: { GR_DEMO_INSTANT: '1' } });
    sessions.push(gr);
    await gr.waitFor('Chapters');
    await step(gr, 'n', 'hunk 1/');
    await step(gr, 'n', 'hunk 2/');
    const where = gr.screen().match(/chapter \d+\/\d+ · hunk \d+\/\d+/)![0];
    await step(gr, ':', 'a command, a file, or a chapter');
    gr.type('tutor');
    await gr.waitFor('Tutor: learn Guided Review in a sample tour');
    await step(gr, KEY.enter, at('Welcome', 1));
    expect(gr.screen()).toContain('(demo)');
    // Q leaves the tutor for the tour it was opened from, where it was.
    await step(gr, 'Q', 'Leave the tutor?');
    gr.press('y');
    await gone(gr, 'Tutor ·');
    // The tour it came from loads again (its loading card first), then opens where it was.
    expect(await gr.waitFor(where)).not.toContain('(demo)');
  });
});
