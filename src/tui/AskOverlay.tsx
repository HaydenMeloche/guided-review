import { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import { Box, Text } from './themed.js';
import type { Hunk } from '../types.js';
import { TextInput } from './TextInput.js';
import { ask, type AskTurn } from '../agent/agent.js';
import type { AgentContext } from '../agent/types.js';
import { line, MdLineView, renderMarkdown, wrapSpans, type MdLine } from './markdown.js';
import { wrap } from './nav.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';

// Streamed text is applied at most this often (about 30 fps): each update re-renders Ink,
// which costs far more than parsing the token.
export const ASK_FLUSH_MS = 33;

// Ask the agent beside the current review context. Answers stream in place, and each
// question joins a thread so follow-ups keep the earlier questions and answers in view.
// Without an agent it says why (aiOff) and takes no question.
export function AskOverlay(props: {
  hunk?: Hunk;
  lineIdx?: number;
  endIdx?: number;
  context?: string;
  placeholder?: string;
  target: string;
  agent?: AgentContext;
  aiOff?: string;
  width: number;
  height: number;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [scroll, setScroll] = useState(0); // rows up from the bottom of the thread
  const abort = useRef<AbortController | null>(null);
  // The newest streamed text not yet on screen, and the timer that will flush it.
  const pending = useRef<string | undefined>(undefined);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Rendered lines per finished turn: those turn objects never change, so they render once.
  const rendered = useRef(new WeakMap<AskTurn, { width: number; lines: MdLine[] }>());

  useEffect(
    () => () => {
      abort.current?.abort();
      clearTimeout(flushTimer.current);
    },
    [],
  );

  const setAnswer = (update: (a: string) => string) => setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { ...t, answer: update(t.answer) } : t)));
  const flush = () => {
    clearTimeout(flushTimer.current);
    flushTimer.current = undefined;
    const text = pending.current;
    pending.current = undefined;
    if (text !== undefined) setAnswer(() => text);
  };
  const onText = (text: string) => {
    pending.current = text;
    flushTimer.current ??= setTimeout(flush, ASK_FLUSH_MS);
  };

  const submit = async (question: string) => {
    if (!question.trim() || busy) return;
    const history = turns;
    setTurns([...history, { question, answer: '' }]);
    setQ('');
    setScroll(0);
    if (!props.agent) return;
    setBusy(true);
    abort.current = new AbortController();
    try {
      const r = await ask({ ...props.agent, question, history, hunk: props.hunk, lineIdx: props.lineIdx, endIdx: props.endIdx, context: props.context, onText, signal: abort.current.signal });
      // The final flush always lands, so the complete answer is shown.
      flush();
      if (r.value) setAnswer(() => r.value);
    } catch (e) {
      flush();
      setAnswer((a) => `${a}\n\n[error: ${(e as Error).message}]`);
    }
    setBusy(false);
  };

  const inner = props.width - 4;
  const lines: MdLine[] = [];
  const turnLines = (t: AskTurn): MdLine[] => {
    const hit = rendered.current.get(t);
    if (hit && hit.width === inner) return hit.lines;
    // wrapSpans and renderMarkdown strip terminal controls from the question and the model's answer.
    const out = [...wrapSpans([{ text: t.question, color: 'magenta' }], inner, [{ text: '› ', color: 'magenta' }], [{ text: '  ' }]), ...renderMarkdown(t.answer, inner)];
    rendered.current.set(t, { width: inner, lines: out });
    return out;
  };
  turns.forEach((t, i) => {
    if (i > 0) lines.push(line(''));
    lines.push(...turnLines(t));
  });
  const inputRows = busy ? 0 : Math.min(2, Math.max(1, wrap(q, Math.max(10, inner)).length));
  const room = Math.max(0, props.height - 4 - inputRows); // border, title, input, and footer
  const maxScroll = Math.max(0, lines.length - room);
  const offset = Math.min(scroll, maxScroll);
  const top = maxScroll - offset;

  useInput((_input, key) => {
    if (key.escape) {
      abort.current?.abort();
      return props.onClose();
    }
    if (key.upArrow) setScroll((s) => Math.min(maxScroll, s + 1));
    if (key.downArrow) setScroll((s) => Math.max(0, s - 1));
    if (key.pageUp) setScroll((s) => Math.min(maxScroll, s + room));
    if (key.pageDown) setScroll((s) => Math.max(0, s - room));
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} width={props.width} height={props.height} overflow="hidden" flexShrink={0}>
      <Text>
        <Text bold>Ask</Text> <Text dimColor>about {safe(props.target)}</Text>
        {turns.length > 1 ? <Text dimColor> · {turns.length} questions</Text> : null}
      </Text>
      {lines.slice(top, top + room).map((l, i) => (
        <MdLineView key={i} line={l} />
      ))}
      {!props.agent ? (
        <Text wrap="wrap">{props.aiOff ?? 'AI is unavailable for this tour, so questions are off.'}</Text>
      ) : busy ? null : (
        <TextInput
          value={q}
          onChange={setQ}
          onSubmit={(question) => void submit(question)}
          width={inner}
          maxRows={2}
          placeholder={turns.length ? 'ask a follow-up…' : (props.placeholder ?? 'e.g. "why is this nullable?" or "what calls this?"')}
        />
      )}
      <Text dimColor>{!props.agent ? 'esc: close' : busy ? 'thinking… (esc to stop)' : turns.length ? 'enter: follow up · ↑/↓: scroll · esc: close' : 'enter: ask · esc: close'}</Text>
    </Box>
  );
}
