import { LESSONS, type Lesson, type Place, type Step, type TutorView } from './lessons.js';
import type { TutorEvent } from './bridge.js';

// The tutor's script, as pure functions of where it is: which step comes next or before, whether
// a step is done, and where it should find the reader. The hook in Tutor.tsx holds the state.

export interface TutorPos {
  lesson: number;
  step: number;
}

export const START: TutorPos = { lesson: 0, step: 0 };

export const stepAt = (pos: TutorPos, lessons: Lesson[] = LESSONS): Step | undefined => lessons[pos.lesson]?.steps[pos.step];

export function forward(pos: TutorPos, lessons: Lesson[] = LESSONS): TutorPos | undefined {
  if (pos.step + 1 < (lessons[pos.lesson]?.steps.length ?? 0)) return { lesson: pos.lesson, step: pos.step + 1 };
  return pos.lesson + 1 < lessons.length ? { lesson: pos.lesson + 1, step: 0 } : undefined;
}

export function backward(pos: TutorPos, lessons: Lesson[] = LESSONS): TutorPos | undefined {
  if (pos.step > 0) return { lesson: pos.lesson, step: pos.step - 1 };
  return pos.lesson > 0 ? { lesson: pos.lesson - 1, step: lessons[pos.lesson - 1].steps.length - 1 } : undefined;
}

// Where a step expects the reader: the last `go` at or before it in its lesson, else the lesson's start.
export function placeOf(pos: TutorPos, lessons: Lesson[] = LESSONS): Place {
  const lesson = lessons[pos.lesson];
  for (let i = pos.step; i >= 0; i--) {
    const go = lesson.steps[i]?.go;
    if (go) return go;
  }
  return lesson.start;
}

// Whether moving from one step to another takes the reader somewhere: into a new lesson (each
// starts from its own place, so none depends on the one before), to a step with its own place,
// or back, where the screen may have moved on since.
export function travels(from: TutorPos | undefined, to: TutorPos, lessons: Lesson[] = LESSONS): boolean {
  if (!from || from.lesson !== to.lesson) return true;
  if (to.step < from.step) return true;
  return !!stepAt(to, lessons)?.go;
}

// Whether a step is done, by an event the screen reported or the state it is in.
export function satisfied(step: Step, view: TutorView, event?: TutorEvent): boolean {
  const u = step.until;
  if ('read' in u) return false;
  if ('event' in u) return !!event && u.event.includes(event);
  return u.when(view);
}

// Where a do step began. Off it (another chapter, or another screen), the tutor offers to go back.
export interface Home {
  phase: TutorView['phase'];
  ci: number;
  hi: number;
}

export const homeOf = (view: TutorView): Home => ({ phase: view.phase, ci: view.ci, hi: view.hi });

// The submit screen's comment editor is part of the submit screen.
const samePhase = (a: TutorView['phase'], b: TutorView['phase']) => a === b || (a === 'submit' && b === 'edit') || (a === 'edit' && b === 'submit');

export function offPath(home: Home, view: TutorView): boolean {
  if (!samePhase(home.phase, view.phase)) return true;
  return home.phase === 'chapter' && home.ci !== view.ci;
}

// "chapter 2" or "the briefing": where the reader should be, for the way back.
export const homeName = (home: Home) => (home.phase === 'chapter' ? `chapter ${home.ci + 1}` : home.phase === 'briefing' ? 'the briefing' : `the ${home.phase} screen`);

// The step's number in its lesson and the lesson's in the tutor, for the callout's title.
export function progressOf(pos: TutorPos, lessons: Lesson[] = LESSONS): { lesson: number; lessons: number; step: number; steps: number } {
  return { lesson: pos.lesson + 1, lessons: lessons.length, step: pos.step + 1, steps: lessons[pos.lesson]?.steps.length ?? 0 };
}

export const isLast = (pos: TutorPos, lessons: Lesson[] = LESSONS) => !forward(pos, lessons);

export const lessonIndex = (id: string | undefined, lessons: Lesson[] = LESSONS) => (id ? lessons.findIndex((l) => l.id === id) : -1);
