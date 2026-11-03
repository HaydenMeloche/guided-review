import { createContext, use } from 'react';
import type { PaletteItem } from '../CommandPalette.js';
import type { Action } from '../chapter/keys.js';

// How the screens and the tutor talk. The screens only report: the actions they run, and the
// state of theirs a lesson waits on (an overlay open, the tests focused). The tutor never acts on
// a screen, except to ask it to put the reader at a lesson's start (`request`).

// What a step can wait for besides a state: a chapter action, or an answer to a question.
export type TutorEvent = Action | 'answered';

export interface ScreenState {
  overlay: string; // the chapter screen's open overlay ('none' when there is none)
  testFocus: boolean;
}

export interface TutorRequest {
  seq: number; // a new number: close what is open and go to the lesson's place
  hunkId?: string;
  line?: number; // a line of the new file in that hunk, for the cursor
}

export interface TutorBridge {
  event: (e: TutorEvent) => void;
  screen: (s: ScreenState) => void;
  request: TutorRequest;
  palette: PaletteItem[]; // the tutor's commands, added to a screen's palette
}

export const TutorContext = createContext<TutorBridge | undefined>(undefined);

export const useTutorBridge = () => use(TutorContext);
