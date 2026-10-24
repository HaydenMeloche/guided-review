import { safeReadFile } from '../analysis/safeRead.js';
import { normalizeReplacement, originalLines, suggestionApplicability } from '../review/suggestion.js';
import type { CallerRef, CodeRef, DraftAnchor, Hunk, TestLink, Tour } from '../types.js';
import { AgentUnavailableError, runRole, selectionContext, withoutTools } from './agent.js';
import { configForRole, type AgentContext, type ModelStamp } from './types.js';

// AI-drafted replacement code for a line or range anchor. It runs on the Q&A routing without
// touching the Q&A session, and its output is checked for structure only: it is a proposal,
// never compiled, run, or written to the repository.

export type SuggestionErrorKind = 'not-applicable' | 'invalid-output' | 'unavailable' | 'aborted' | 'failed';

export class SuggestionError extends Error {
  constructor(
    readonly kind: SuggestionErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface Citation {
  path: string;
  startLine: number;
  endLine?: number;
}

export interface SuggestionResult {
  code: string;
  explanation: string;
  assumptions: string[];
  citations: Citation[];
  notes: string[];
  model: ModelStamp;
}

export interface SuggestOptions extends AgentContext {
  tour: Tour;
  hunk: Hunk;
  anchor: Extract<DraftAnchor, { type: 'line' | 'range' }>;
  instruction?: string;
  previous?: { code: string; feedback: string };
  enclosing?: { name: string; startLine: number; endLine: number; text: string };
  tests?: TestLink[];
  callers?: CallerRef[];
  refs?: CodeRef[];
  signal?: AbortSignal;
  onText?: (text: string) => void;
}

interface RawSuggestion {
  replacement: string;
  explanation: string;
  assumptions: string[];
  citations: Citation[];
}

const suggestionSchema = {
  type: 'object',
  properties: {
    replacement: { type: 'string', description: 'only the new code for the >> lines, original indentation, no fences or diff markers' },
    explanation: { type: 'string', description: '1-3 sentences: why this change' },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'what the proposal assumes but you did not verify' },
    citations: {
      type: 'array',
      description: 'repository locations that support the proposal',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } },
        required: ['path', 'startLine'],
      },
    },
  },
  required: ['replacement', 'explanation', 'assumptions', 'citations'],
};

const MAX_TESTS = 2;
const MAX_CALLERS = 5;
const MAX_SNIPPET_LINES = 80;

const snippet = (lines: string[], first: number) => {
  const shown = lines.slice(0, MAX_SNIPPET_LINES).map((l, i) => `${String(first + i).padStart(5)} ${l}`);
  if (lines.length > MAX_SNIPPET_LINES) shown.push(`      ... ${lines.length - MAX_SNIPPET_LINES} more lines`);
  return shown.join('\n');
};

const lineRange = (start?: number, end?: number) => (start === undefined ? '' : end !== undefined && end !== start ? `:${start}-${end}` : `:${start}`);

// The head lines just outside the selection, from the hunk or else the worktree, to catch output
// that repeats them.
function neighbours(o: SuggestOptions, startLine: number, line: number): { before?: string; after?: string } {
  const inHunk = (n: number) => o.hunk.lines.find((l) => l.kind !== 'del' && l.newLine === n)?.text;
  let before = inHunk(startLine - 1);
  let after = inHunk(line + 1);
  if (before === undefined || after === undefined) {
    const file = safeReadFile(o.cwd, o.anchor.file)?.split('\n');
    before ??= startLine > 1 ? file?.[startLine - 2] : undefined;
    after ??= file?.[line];
  }
  return { before, after };
}

export function suggestionPrompt(o: SuggestOptions, startLine: number, line: number): string {
  const selected = selectionContext(o.hunk, undefined, undefined, (l) => l.kind !== 'del' && l.newLine !== undefined && l.newLine >= startLine && l.newLine <= line);
  const parts = [`Propose replacement code for ${startLine === line ? `line ${line}` : `lines ${startLine}-${line}`} of ${o.anchor.file} (>> marks them):\n\n${selected}`];
  if (o.enclosing) parts.push(`Enclosing declaration ${o.enclosing.name} (lines ${o.enclosing.startLine}-${o.enclosing.endLine}):\n\n${snippet(o.enclosing.text.split('\n'), o.enclosing.startLine)}`);
  const tests = (o.tests ?? []).slice(0, MAX_TESTS);
  if (tests.length) parts.push(`Tests that exercise this code:\n\n${tests.map((t) => `${t.testFile}:${t.startLine} "${t.testName}"\n${snippet(t.lines, t.startLine)}`).join('\n\n')}`);
  const callers = (o.callers ?? []).slice(0, MAX_CALLERS);
  if (callers.length) parts.push(`Possible callers (found by name, may be wrong):\n${callers.map((c) => `- ${c.file}:${c.line}: ${c.text.trim()}`).join('\n')}`);
  const refs = o.refs ?? [];
  if (refs.length) parts.push(`Code the reviewer's comment references:\n${refs.map((r) => `- ${r.label}: ${r.path}${lineRange(r.startLine, r.endLine)}`).join('\n')}`);
  if (o.previous) parts.push(`Your previous proposal:\n\n${o.previous.code}\n\nThe reviewer's feedback on it: ${o.previous.feedback}`);
  parts.push(o.instruction?.trim() ? `The reviewer's instruction: ${o.instruction.trim()}` : 'No instruction was given: propose the change a careful reviewer would ask for here.');
  const access = withoutTools(configForRole(o, 'qa'))
    ? 'Answer from the context above only; you cannot read the repository. If it is insufficient, say so in the explanation and list what you assumed.'
    : 'Read the repository with the available read-only tools when you need more context.';
  parts.push(
    [
      'Rules:',
      '- `replacement` is ONLY the code that replaces the >> lines, with their original indentation. No code fences, no diff +/- markers, no line numbers, and none of the lines before or after the selection.',
      '- It may have more or fewer lines than the selection. Leave it empty only when the instruction is to delete the lines.',
      '- The code is a proposal for the reviewer to accept or edit; nothing is run or applied.',
      '- `assumptions` lists what the code relies on that you did not verify; `citations` gives repository paths (relative) and lines that support it.',
      `- ${access}`,
    ].join('\n'),
  );
  return parts.join('\n\n');
}

function lineCount(text: string): number {
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

// Citations are kept only when the path is a file inside the worktree and the lines exist.
function checkCitations(cwd: string, citations: Citation[]): { kept: Citation[]; dropped: number } {
  const lengths = new Map<string, number | undefined>();
  const kept: Citation[] = [];
  for (const c of citations) {
    const path = c.path.replace(/^\.\//, '');
    if (!lengths.has(path)) {
      const text = safeReadFile(cwd, path);
      lengths.set(path, text === undefined ? undefined : lineCount(text));
    }
    const n = lengths.get(path);
    const end = c.endLine ?? c.startLine;
    if (n !== undefined && c.startLine >= 1 && end >= c.startLine && end <= n) kept.push({ path, startLine: c.startLine, ...(c.endLine !== undefined ? { endLine: c.endLine } : {}) });
  }
  return { kept, dropped: citations.length - kept.length };
}

const INVALID = /invalid JSON|does not match the requested schema|no structured output|empty answer/;

export async function generateSuggestion(o: SuggestOptions): Promise<SuggestionResult> {
  const applies = suggestionApplicability(o.tour, o.anchor);
  if (!applies.ok) throw new SuggestionError('not-applicable', applies.reason);
  const { startLine, line } = applies;
  const original = originalLines(o.hunk, o.anchor);

  // Only the routing goes to runRole: the rest would ride along into every provider's config.
  const { cwd, sessions, rememberSession, provider, model, baseUrl, apiKey, apiKeyEnv, toolCalling, maxOutputTokens, effort, fastMode, roles } = o;
  const context: AgentContext = { cwd, sessions, rememberSession, provider, model, baseUrl, apiKey, apiKeyEnv, toolCalling, maxOutputTokens, effort, fastMode, roles };
  let result;
  try {
    result = await runRole<RawSuggestion>('qa', suggestionPrompt(o, startLine, line), context, { schema: suggestionSchema, signal: o.signal, onText: o.onText, maxTurns: 8, session: false });
  } catch (e) {
    if (o.signal?.aborted) throw new SuggestionError('aborted', 'Suggestion cancelled.');
    const message = (e as Error).message;
    if (e instanceof AgentUnavailableError) throw new SuggestionError('unavailable', `The model is unavailable: ${message}`);
    if (INVALID.test(message)) throw new SuggestionError('invalid-output', "The model's answer wasn't a usable suggestion. Try again.");
    throw new SuggestionError('failed', `The suggestion failed: ${message}`);
  }

  const raw = result.value;
  const allowEmpty = /\b(delete|remove|drop)\b/i.test(o.instruction ?? '');
  const normalized = normalizeReplacement(original, raw.replacement, { allowEmpty, ...neighbours(o, startLine, line) });
  if (!normalized.ok) throw new SuggestionError('invalid-output', normalized.reason);
  const { kept, dropped } = checkCitations(o.cwd, raw.citations);
  const notes = [...normalized.notes];
  if (dropped) notes.push(`${dropped} ${dropped === 1 ? "citation didn't" : "citations didn't"} match the repository and ${dropped === 1 ? 'was' : 'were'} removed.`);
  return {
    code: normalized.code,
    explanation: raw.explanation.trim(),
    assumptions: raw.assumptions.map((a) => a.trim()).filter(Boolean),
    citations: kept,
    notes,
    model: result.modelUsed!,
  };
}
