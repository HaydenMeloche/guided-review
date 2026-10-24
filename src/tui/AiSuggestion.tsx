import { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import { Box, Text } from './themed.js';
import { SuggestionError } from '../agent/suggest.js';
import { linesHash, referencedRefs } from '../review/refs.js';
import { suggestionApplicability, type Applicability } from '../review/suggestion.js';
import type { Tour } from '../types.js';
import { anchorText, isLineAnchor, type AiState, type ComposerEnv, type ComposerState, type SetComposer } from './composer.js';
import { readLines } from './references.js';
import { TextInput } from './TextInput.js';
import { truncate, wrap } from './nav.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';

// Ctrl+T in the composer: ask the Q&A model for replacement code, on one line under the body
// so the code it replaces stays in view. The result is a proposal: checked for shape only,
// never compiled or run, and saved only when the reviewer accepts it.

const MAX_TESTS = 2;
const MAX_CALLERS = 5;
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export const INLINE_ROWS = 11; // the inline composer's usual slot under the code
export const AI_BODY_ROWS = 3; // body rows kept while the AI line is open
const PLACEHOLDER = 'Describe the change (optional) · enter generate · esc cancel';

export function useAiSuggestion(o: { st: ComposerState; set: SetComposer; env?: ComposerEnv; editCode: (code: string) => Promise<string | undefined> }) {
  const { st, set, env } = o;
  const ai = st.mode === 'ai' ? st.ai : undefined;
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), []);

  const setAi = (p: Partial<AiState>) => set((s) => (s.ai ? { ...s, ai: { ...s.ai, ...p } } : s));
  const close = (msg = '') => set((s) => ({ ...s, mode: 'text', ai: undefined, msg }));
  const refuse = (error: string) => set((s) => ({ ...s, mode: 'ai', msg: '', ai: { phase: 'error', instruction: '', streamed: 0, error, tone: 'warn' } }));

  const open = () => {
    const tour = env?.tour;
    if (!env || !tour) return;
    if (!env.agent || !env.generate || tour.mode !== 'agent') return refuse('AI is off for this tour; ctrl+g to write a suggestion by hand.');
    const applies = suggestionApplicability(tour, st.anchor);
    if (!applies.ok) return refuse(`No AI suggestion here: ${applies.reason}`);
    if (!isLineAnchor(st.anchor) || !tour.hunks[st.anchor.hunkId]) return refuse('The anchored hunk is no longer in the tour.');
    set((s) => ({ ...s, mode: 'ai', msg: '', ai: { phase: 'prompt', instruction: '', streamed: 0 } }));
  };

  const generate = async () => {
    const tour = env?.tour;
    const a = st.anchor;
    const hunk = tour && isLineAnchor(a) ? tour.hunks[a.hunkId] : undefined;
    if (!ai || !env?.agent || !env.generate || !tour || !isLineAnchor(a) || !hunk) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const instruction = ai.instruction.trim();
    set((s) => (s.ai ? { ...s, msg: '', ai: { ...s.ai, phase: 'running', streamed: 0, error: undefined, retry: undefined } } : s));
    const cancelled = () => set((s) => (s.ai ? { ...s, msg: 'Cancelled. Nothing was changed.', ai: { ...s.ai, phase: 'prompt' } } : s));
    try {
      // The declaration around the selection, from the worktree.
      const decl = await st.index?.enclosingDecl(a.file, a.line).catch(() => undefined);
      const lines = decl ? readLines(env.root, a.file) : undefined;
      if (controller.signal.aborted) return cancelled();
      const r = await env.generate({
        ...env.agent,
        tour,
        hunk,
        anchor: a,
        instruction: instruction || undefined,
        previous: ai.refining !== undefined ? { code: ai.refining, feedback: instruction } : undefined,
        enclosing: decl && lines ? { name: decl.name, startLine: decl.startLine, endLine: decl.endLine, text: lines.slice(decl.startLine - 1, decl.endLine).join('\n') } : undefined,
        tests: [...hunk.tests].sort((x, y) => Number(x.source === 'naming') - Number(y.source === 'naming')).slice(0, MAX_TESTS),
        callers: tour.blastRadius
          .filter((b) => b.hunkId === hunk.id)
          .flatMap((b) => b.callers)
          .slice(0, MAX_CALLERS),
        refs: referencedRefs(st.body, st.refs),
        signal: controller.signal,
        onText: (t) => setAi({ streamed: t.length }),
      });
      if (controller.signal.aborted) return cancelled();
      setAi({ phase: 'result', result: r, refining: undefined });
    } catch (e) {
      if (controller.signal.aborted || (e instanceof SuggestionError && e.kind === 'aborted')) return cancelled();
      const warn = e instanceof SuggestionError && (e.kind === 'not-applicable' || e.kind === 'unavailable');
      setAi({ phase: 'error', error: safe((e as Error).message), tone: warn ? 'warn' : 'fail', retry: true });
    }
  };

  const accept = (code: string) => {
    const r = ai?.result;
    const tour = env?.tour;
    const original = tour && anchorText(tour, st.anchor);
    if (!r || !tour || original === undefined) return;
    const meta = {
      source: 'ai' as const,
      headSha: tour.headSha,
      originalHash: linesHash(original),
      model: r.model,
      ...(r.explanation ? { explanation: r.explanation } : {}),
      ...(r.assumptions.length ? { assumptions: r.assumptions } : {}),
    };
    // Back to the body, its cursor where it was.
    set((s) => ({ ...s, suggestion: code, suggestionMeta: meta, mode: 'text', ai: undefined, msg: 'AI suggestion accepted. Review it before you submit.' }));
  };

  useInput(
    (input, key) => {
      if (!ai) return;
      if (ai.phase === 'prompt') {
        if (!key.escape) return;
        // Esc while refining goes back to the proposal; otherwise it closes the line.
        return ai.result ? setAi({ phase: 'result', refining: undefined }) : close();
      }
      if (ai.phase === 'running') {
        if (key.escape) abort.current?.abort();
        return;
      }
      if (ai.phase === 'error') {
        if (key.escape) return ai.retry ? setAi({ phase: 'prompt', error: undefined }) : close();
        if (key.return && ai.retry) return void generate();
        return;
      }
      const r = ai.result;
      if (!r) return;
      if (key.escape) return close('Proposal discarded.');
      if (key.return || input === 'a') return accept(r.code);
      if (input === 'r') return setAi({ phase: 'prompt', refining: r.code });
      if (input === 'e')
        return void o.editCode(r.code).then((edited) => {
          if (edited !== undefined) accept(edited);
        });
    },
    { isActive: !!ai },
  );

  return { ai, open, generate, setInstruction: (instruction: string) => setAi({ instruction }) };
}

// What the footer says the keys do in each phase.
export function aiKeys(ai: AiState): string {
  if (ai.phase === 'prompt') return ai.result ? 'enter regenerate · esc back to the proposal' : 'enter generate · esc cancel';
  if (ai.phase === 'running') return 'esc stop';
  if (ai.phase === 'error') return ai.retry ? 'enter retry · esc back · nothing was changed' : 'esc close';
  return 'enter accept · r refine · e edit · esc discard';
}

type Row = { kind: 'input' } | { kind: 'text'; text: string; color?: string; dim?: boolean; bold?: boolean; tail?: string; tailColor?: string };

// The AI section's rows, the -/+ preview cut to fit `budget` rows. Counting them sizes the
// inline slot, so this is the one place that decides what is shown.
export function aiRows(ai: AiState, original: string, applies: Applicability, width: number, budget = Infinity, frame = 0): Row[] {
  if (ai.phase === 'prompt') return Array.from({ length: Math.min(2, wrap(ai.instruction, Math.max(10, width - 2)).length) || 1 }, () => ({ kind: 'input' }));
  if (ai.phase === 'running') return [{ kind: 'text', text: `✦ ${SPIN[frame % SPIN.length]} generating…${ai.streamed ? ` ${ai.streamed} chars` : ''}`, dim: true }];
  if (ai.phase === 'error')
    return wrap(`✦ ${ai.error ?? ''}`, Math.max(10, width))
      .slice(0, 3)
      .map((text) => ({ kind: 'text', text, color: ai.tone === 'warn' ? 'yellow' : 'red' }));
  const r = ai.result!;
  const marker: Row = {
    kind: 'text',
    text: '✦ proposal',
    color: 'yellow',
    bold: true,
    tail: ` · not verified · ${applies.ok ? `applies on L${applies.startLine === applies.line ? applies.line : `${applies.startLine}-${applies.line}`}` : `⚠ ${applies.reason}`}`,
    tailColor: applies.ok ? undefined : 'yellow',
  };
  const preview: Row[] = [
    ...original.split('\n').map((l): Row => ({ kind: 'text', text: `- ${l}`, color: 'red' })),
    ...(r.code ? r.code.split('\n').map((l): Row => ({ kind: 'text', text: `+ ${l}`, color: 'green' })) : [{ kind: 'text', text: '  (deletes the selected lines)', dim: true } as Row]),
  ];
  const rest: Row[] = [];
  if (r.explanation) rest.push({ kind: 'text', text: `why ${r.explanation.replace(/\s+/g, ' ')}`, dim: true });
  const count = (n: number, word: string) => (n ? `${n} ${word}${n === 1 ? '' : 's'}` : '');
  const extras = [count(r.assumptions.length, 'assumption'), r.citations.length ? `${count(r.citations.length, 'citation')} ✓` : '', count(r.notes.length, 'note')].filter(Boolean).join(' · ');
  if (extras) rest.push({ kind: 'text', text: extras, dim: true });
  const room = Math.max(2, budget - 1 - rest.length);
  const shown = preview.length > room ? [...preview.slice(0, room - 1), { kind: 'text', text: `  … ${preview.length - room + 1} more lines`, dim: true } as Row] : preview;
  return [marker, ...shown, ...rest];
}

// Rows the composer needs around the AI section: border, header, labels, gap, body, footer.
export const aiChromeRows = (st: ComposerState, width: number) => 6 + Math.min(AI_BODY_ROWS, Math.max(1, wrap(st.body, Math.max(10, width - 4)).length));

const LIST_MIN_ROWS = 7; // the list's usual rows plus its hint line

// The compact composer's rows other than an open list: border, header, labels, the body's
// rows, a suggestion if any, and the footer line.
function listChromeRows(st: ComposerState, width: number): number {
  const body = Math.min(8, wrap(st.body + ' ', Math.max(10, width - 4)).length);
  const suggestion = st.suggestion !== undefined ? 1 + Math.min(8, st.suggestion.split('\n').length) : 0;
  return 6 + body + suggestion + 1;
}

// The inline composer's slot under the code: its usual rows, or room for the AI line and its
// proposal, up to 70% of the pane so the commented lines stay in view above it.
export function inlineComposerSlot(st: ComposerState | undefined, tour: Tour, pane: number, width: number): { height: number; aiRows?: number; listRows?: number } {
  if (st?.mode === 'text' && st.listOpen) {
    // An open @ list takes most of the pane, so its preview shows more of the code.
    const height = Math.max(INLINE_ROWS, Math.floor(pane * 0.75));
    return { height, listRows: Math.max(LIST_MIN_ROWS, height - listChromeRows(st, width)) };
  }
  if (!st || st.mode !== 'ai' || !st.ai) return { height: INLINE_ROWS };
  const chrome = aiChromeRows(st, width);
  const want = chrome + aiRows(st.ai, anchorText(tour, st.anchor) ?? '', suggestionApplicability(tour, st.anchor), width - 4).length;
  const height = Math.max(INLINE_ROWS, Math.min(want, Math.floor(pane * 0.7)));
  return { height, aiRows: height - chrome };
}

export function AiSuggestionView(props: { ai: AiState; tour: Tour; state: ComposerState; width: number; budget: number; onInstruction: (v: string) => void; onSubmit: () => void }) {
  const { ai, tour, width } = props;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (ai.phase !== 'running') return;
    const t = setInterval(() => setFrame((f) => f + 1), 90);
    return () => clearInterval(t);
  }, [ai.phase]);
  const rows = aiRows(ai, anchorText(tour, props.state.anchor) ?? '', suggestionApplicability(tour, props.state.anchor), width, props.budget, frame);
  if (ai.phase === 'prompt')
    return (
      <Box>
        <Text color="cyan">{'✦ '}</Text>
        <TextInput value={ai.instruction} onChange={props.onInstruction} onSubmit={props.onSubmit} width={width - 2} maxRows={rows.length} placeholder={truncate(PLACEHOLDER, width - 3)} />
      </Box>
    );
  return (
    <Box flexDirection="column">
      {rows.map((row, i) =>
        row.kind === 'text' ? (
          <Text key={i} wrap="truncate">
            <Text color={row.color} dimColor={row.dim} bold={row.bold}>
              {truncate(safe(row.text), width) || ' '}
            </Text>
            {row.tail ? (
              <Text color={row.tailColor} dimColor={!row.tailColor}>
                {truncate(row.tail, Math.max(0, width - row.text.length))}
              </Text>
            ) : null}
          </Text>
        ) : null,
      )}
    </Box>
  );
}
