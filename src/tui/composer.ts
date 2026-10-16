import type { RepoIndex } from '../analysis/repoIndex.js';
import type { SuggestionResult, SuggestOptions } from '../agent/suggest.js';
import type { AgentContext } from '../agent/types.js';
import { linesHash, referencedRefs } from '../review/refs.js';
import { originalLines } from '../review/suggestion.js';
import type { CodeRef, CommentLabel, Draft, DraftAnchor, SuggestionMeta, Tour } from '../types.js';
import type { RecentLocation } from './references.js';

// The comment composer's working state. It lives with whoever places the composer on screen,
// so the composer can move between the inline slot and a larger popup without losing the text,
// the cursor or the references.

export type ComposerMode = 'text' | 'ai';

// Ctrl+T's inline line: an instruction, a request in flight, a proposal, or why there is none.
export type AiPhase = 'prompt' | 'running' | 'result' | 'error';

export interface AiState {
  phase: AiPhase;
  instruction: string;
  streamed: number; // characters of model output so far
  result?: SuggestionResult;
  refining?: string; // the proposal the next request revises
  error?: string;
  tone?: 'warn' | 'fail';
  retry?: boolean; // the error came from a request: Enter retries, Esc returns to the instruction
}

export type SetComposer = (update: (s: ComposerState) => ComposerState) => void;

export interface ComposerState {
  anchor: DraftAnchor;
  label: CommentLabel;
  body: string;
  cursor: number;
  suggestion?: string;
  suggestionMeta?: SuggestionMeta;
  refs: CodeRef[]; // targets of the body's code references; may hold some whose span was deleted
  mode: ComposerMode;
  msg: string;
  index?: RepoIndex;
  ai?: AiState; // set while mode is 'ai'
  listOpen?: boolean; // the @ completion list is open: the inline slot grows for its preview
}

// What the composer reads from the session. All optional but the tour, so a bare editor works.
export interface ComposerEnv {
  tour: Tour;
  root?: string;
  host: string;
  agent?: AgentContext; // absent: AI suggestions are off (plain tour, --no-agent)
  generate?: (o: SuggestOptions) => Promise<SuggestionResult>;
  recent?: () => RecentLocation[];
  noteRecent?: (loc: Omit<RecentLocation, 'at'>) => void;
  // A RepoIndex for this composer. Called once when a composer opens: in preview mode it
  // returns a fresh one, since the working tree can change between comments.
  repoIndex?: () => RepoIndex | undefined;
}

export type LineAnchor = Extract<DraftAnchor, { type: 'line' | 'range' }>;
export const isLineAnchor = (a: DraftAnchor): a is LineAnchor => a.type === 'line' || a.type === 'range';

export function initComposer(draft: Draft, opts: { index?: RepoIndex } = {}): ComposerState {
  return {
    anchor: draft.anchor,
    label: draft.label,
    body: draft.body,
    cursor: draft.body.length,
    suggestion: draft.suggestion,
    suggestionMeta: draft.suggestionMeta,
    refs: draft.refs ?? [],
    mode: 'text',
    msg: '',
    index: opts.index,
  };
}

// The draft as it would be saved. Only refs a code span still names are kept, so deleting a span
// deletes its reference; a comment without references or suggestion metadata carries neither
// field, so it is stored exactly as before.
export function draftFrom(base: Draft, s: ComposerState): Draft {
  const rest = { ...base };
  const refs = referencedRefs(s.body, s.refs);
  delete rest.refs;
  delete rest.suggestionMeta;
  delete rest.suggestion;
  return {
    ...rest,
    anchor: s.anchor,
    label: s.label,
    body: s.body.trim(),
    ...(s.suggestion !== undefined ? { suggestion: s.suggestion } : {}),
    ...(s.suggestion !== undefined && s.suggestionMeta ? { suggestionMeta: s.suggestionMeta } : {}),
    ...(refs.length ? { refs } : {}),
  };
}

// The anchored lines a suggestion replaces, on the anchor's side, from the tour's hunk.
export function anchorText(tour: Tour, anchor: DraftAnchor): string | undefined {
  if (!isLineAnchor(anchor)) return undefined;
  const hunk = tour.hunks[anchor.hunkId];
  return hunk ? originalLines(hunk, anchor) : undefined;
}

// Metadata for a suggestion written now against `anchor`.
export function suggestionMetaFor(tour: Tour, anchor: DraftAnchor, extra: Omit<SuggestionMeta, 'headSha' | 'originalHash'>): SuggestionMeta | undefined {
  const text = anchorText(tour, anchor);
  return text === undefined ? undefined : { ...extra, headSha: tour.headSha, originalHash: linesHash(text) };
}

// Whether a draft's suggestion still replaces the lines it was written for: written at this
// head, or the anchored lines hash the same here (a silent re-pin).
export const suggestionStillApplies = (tour: Tour) => (d: Pick<Draft, 'anchor' | 'suggestionMeta'>) => {
  const m = d.suggestionMeta;
  if (!m) return true;
  if (m.headSha === tour.headSha) return true;
  const text = anchorText(tour, d.anchor);
  return text !== undefined && linesHash(text) === m.originalHash;
};

export function sameAnchor(a: DraftAnchor, b: DraftAnchor): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// What App hands the chapter screen for references: recent locations (App state, so they
// survive screen changes), the repository index, and the suggestion generator.
export interface ReferenceServices {
  host: string;
  repoIndex?: () => RepoIndex | undefined;
  recent?: () => RecentLocation[];
  noteRecent?: (loc: Omit<RecentLocation, 'at'>) => void;
  generate?: (o: SuggestOptions) => Promise<SuggestionResult>;
}

// "L42" / "L40-42" for messages about a suggestion's lines.
export function linesWord(a: DraftAnchor): string {
  if (a.type === 'line') return `L${a.line}`;
  if (a.type === 'range') return `L${a.startLine}-${a.line}`;
  return 'the flow';
}
