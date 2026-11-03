import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_ANSWERS, demoNarration, NO_PREPARED_ANSWER, preparedAnswer, writeDemoRepo } from '../src/demo.js';
import { localPreview } from '../src/preview.js';
import { runPipeline } from '../src/pipeline.js';
import { Store } from '../src/store/db.js';
import { KEYS } from '../src/tui/chapter/keys.js';
import { ANCHORS } from '../src/tui/tutor/anchors.js';
import { LESSONS, pressOf, textSpans, tokenKey, tokensIn, type Place, type TutorView } from '../src/tui/tutor/lessons.js';
import { backward, forward, offPath, placeOf, satisfied, START, stepAt, travels } from '../src/tui/tutor/engine.js';
import { body } from '../src/tui/tutor/Tutor.js';
import type { Tour } from '../src/types.js';

const actions = new Set(KEYS.flatMap((r) => r.bind ?? []).map((b) => b.do));
const view = (v: Partial<TutorView> = {}): TutorView => ({ phase: 'chapter', ci: 0, hi: 0, drafts: 0, overlay: 'none', testFocus: false, ...v });

let dir: string;
let tour: Tour;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-tutor-'));
  const root = path.join(dir, 'demo');
  await writeDemoRepo(root);
  const p = await localPreview(root, 'demo/shop');
  const store = new Store(path.join(dir, 'gr.db'));
  tour = await runPipeline({ pr: p.pr, worktree: p.worktree, store, noAgent: true, diffOverride: p.diff, narrate: demoNarration, onProgress: () => {}, onTour: () => {} });
  store.close();
}, 30_000);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const head = (file: string) => fs.readFileSync(path.join(dir, 'demo', file), 'utf8').split('\n');

describe('the lessons', () => {
  const steps = LESSONS.flatMap((l) => l.steps.map((s) => ({ lesson: l, step: s })));

  it('name only keys that are bound', () => {
    for (const { step } of steps) {
      for (const t of tokensIn(step.text)) expect(tokenKey(t), `{${t}} in "${step.text}"`).toBeTruthy();
      const press = pressOf(step);
      if (press) expect(tokenKey(press), `press ${press}`).toBeTruthy();
    }
  });

  it('wait only for actions the chapter screen has', () => {
    for (const { step } of steps) if ('event' in step.until) for (const e of step.until.event) expect(e === 'answered' || actions.has(e), e).toBe(true);
  });

  it('point only at known anchors', () => {
    for (const { step } of steps) if (step.point) expect(ANCHORS).toContain(step.point);
  });

  it('start at files the demo tour has, on lines its head has', () => {
    const places: Place[] = LESSONS.flatMap((l) => [l.start, ...l.steps.flatMap((s) => (s.go ? [s.go] : []))]);
    for (const p of places) {
      if (p.phase !== 'chapter') continue;
      expect(
        tour.chapters.some((c) => c.hunkIds.some((id) => tour.hunks[id]?.file === p.file)),
        p.file,
      ).toBe(true);
      if (p.line === undefined) continue;
      const h = Object.values(tour.hunks).find((x) => x.file === p.file && x.lines.some((l) => l.newLine === p.line));
      expect(h, `${p.file}:${p.line}`).toBeDefined();
    }
    // The comment and ask lessons are about the STAFF50 line.
    for (const id of ['comment', 'ask']) {
      const start = LESSONS.find((l) => l.id === id)!.start;
      expect(start.phase === 'chapter' && start.file === 'src/pricing.ts' && start.line ? head(start.file)[start.line - 1] : '').toContain('STAFF50');
    }
  });

  it('describe the demo as it is', () => {
    // Move through the tour: n on the first chapter's only hunk goes on to chapter 2.
    expect(tour.chapters[0].hunkIds).toHaveLength(1);
    expect(tour.hunks[tour.chapters[0].hunkIds[0]].file).toBe('src/routes.ts');
    // Read the code: the pricing hunk has tests to move into.
    expect(Object.values(tour.hunks).find((h) => h.file === 'src/pricing.ts')?.tests.length).toBeGreaterThan(0);
    // Already done for you: the generated chapter opens on its summary, so enter expands it.
    expect(tour.chapters.find((c) => c.hunkIds.some((id) => tour.hunks[id]?.file === 'src/generated/api-types.ts'))?.collapsed).toBe(true);
  });
});

describe('the tutor script', () => {
  it('steps forward and back across lessons', () => {
    expect(forward(START)).toEqual({ lesson: 0, step: 1 });
    const lastOfFirst = { lesson: 0, step: LESSONS[0].steps.length - 1 };
    expect(forward(lastOfFirst)).toEqual({ lesson: 1, step: 0 });
    expect(backward({ lesson: 1, step: 0 })).toEqual(lastOfFirst);
    expect(backward(START)).toBeUndefined();
    const end = { lesson: LESSONS.length - 1, step: LESSONS.at(-1)!.steps.length - 1 };
    expect(forward(end)).toBeUndefined();
  });

  it('takes the reader to a new lesson, a step with its own place, and back', () => {
    const done = LESSONS.findIndex((l) => l.id === 'done-for-you');
    expect(travels(undefined, START)).toBe(true);
    expect(travels({ lesson: 1, step: 0 }, { lesson: 1, step: 1 })).toBe(false);
    expect(travels({ lesson: 1, step: 2 }, { lesson: 2, step: 0 })).toBe(true);
    expect(travels({ lesson: 1, step: 2 }, { lesson: 1, step: 1 })).toBe(true);
    expect(travels({ lesson: done, step: 0 }, { lesson: done, step: 1 })).toBe(true);
    // A step's place is the last go before it, else its lesson's start.
    expect(placeOf({ lesson: done, step: 0 })).toEqual(LESSONS[done].start);
    expect(placeOf({ lesson: done, step: 1 })).toEqual(LESSONS[done].steps[1].go);
  });

  it('is done by the event or the state a step waits for', () => {
    const next = stepAt({ lesson: 2, step: 0 })!;
    expect(satisfied(next, view(), 'next')).toBe(true);
    expect(satisfied(next, view(), 'prev')).toBe(false);
    const open = stepAt({ lesson: 0, step: 2 })!;
    expect(satisfied(open, view({ phase: 'briefing' }))).toBe(false);
    expect(satisfied(open, view({ phase: 'chapter' }))).toBe(true);
    expect(satisfied(stepAt(START)!, view(), 'next')).toBe(false); // read steps wait for enter
  });

  it('knows when the reader has left the lesson', () => {
    const home = { phase: 'chapter' as const, ci: 1, hi: 0 };
    expect(offPath(home, view({ ci: 1, hi: 2 }))).toBe(false);
    expect(offPath(home, view({ ci: 2 }))).toBe(true);
    expect(offPath(home, view({ phase: 'briefing', ci: 1 }))).toBe(true);
    expect(offPath({ phase: 'submit', ci: 0, hi: 0 }, view({ phase: 'edit' }))).toBe(false);
  });

  it('writes keys from the key table and wraps at spaces', () => {
    expect(textSpans('Press {next} now.')).toEqual([{ text: 'Press ' }, { text: 'n', key: true }, { text: ' now.' }]);
    expect(tokenKey('nextChapter')).toBe(']');
    expect(tokenKey('leaveTests')).toBe('t'); // as it opened them, not esc
    expect(tokenKey('expand')).toBe('enter');
    expect(tokenKey('start')).toBe('n');
    expect(tokenKey('nothing')).toBeUndefined();
    // A key keeps the punctuation after it on its line.
    const lines = body('skip it with {skip}.', 13).map((l) => l.map((s) => s.text).join(''));
    expect(lines).toEqual(['skip it with', 'x.']);
  });
});

describe('prepared answers', () => {
  it('cite lines that say what the answer says they do', () => {
    for (const answers of Object.values(DEMO_ANSWERS))
      for (const a of answers) {
        const cited = [...a.answer.matchAll(/([\w/.-]+\.ts):(\d+)/g)].map((m) => `${m[1]}:${m[2]}`);
        expect(cited.sort(), a.question).toEqual(a.cites.map((c) => `${c.file}:${c.line}`).sort());
        for (const c of a.cites) expect(head(c.file)[c.line - 1], `${c.file}:${c.line}`).toContain(c.name);
      }
  });

  it('match a typed question by its words, and say so when none does', () => {
    expect(preparedAnswer('src/pricing.ts', 'Who can use STAFF50?')?.question).toBe('Who can use STAFF50?');
    expect(preparedAnswer('src/pricing.ts', 'can anyone type staff50')?.question).toBe('Who can use STAFF50?');
    expect(preparedAnswer('src/pricing.ts', 'what happens if the code is a number')?.question).toBe('What if discountCode is not a string?');
    expect(preparedAnswer('src/pricing.ts', 'why is the sky blue')).toBeUndefined();
    expect(preparedAnswer(undefined, 'staff50')).toBeUndefined();
    expect(NO_PREPARED_ANSWER).toContain('gr config');
  });
});

describe('tutor progress', () => {
  it('is kept in the store apart from the demo tour', () => {
    const store = new Store(path.join(dir, 'progress.db'));
    expect(store.getTutor()).toBeUndefined();
    store.setTutor({ lesson: 'comment', state: 'started' });
    store.forgetPR('demo/shop', 0);
    expect(store.getTutor()).toEqual({ lesson: 'comment', state: 'started' });
    store.setTutor({ state: 'dismissed' });
    expect(store.getTutor()).toEqual({ state: 'dismissed' });
    store.close();
  });
});
