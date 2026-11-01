import { useEffect, useRef, useState } from 'react';
import { useInput } from './input.js';
import { Box, Text } from './themed.js';
import type { Tour } from '../types.js';
import { summarize } from '../agent/agent.js';
import type { AgentContext } from '../agent/types.js';
import { MdLineView, renderMarkdown } from './markdown.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';
import { Working } from './Spinner.js';
import { Hints } from './KeyBar.js';
import { ASK_FLUSH_MS } from './AskOverlay.js';

// The AI description of the PR (i on the briefing). It is written the first time it is opened,
// streaming into the page, and kept for the rest of the run; the briefing itself never asks for it.
const written = new Map<string, string>();
const keyOf = (tour: Tour) => `${tour.repo}#${tour.pr}@${tour.headSha}`;
export const hasSummary = (tour: Tour) => written.has(keyOf(tour));

export function SummaryPanel(props: { tour: Tour; agent: AgentContext; width: number; height: number; onClose: () => void }) {
  const key = keyOf(props.tour);
  const [text, setText] = useState(written.get(key) ?? '');
  const [busy, setBusy] = useState(!written.has(key));
  const [error, setError] = useState<string>();
  const [top, setTop] = useState(0);
  const abort = useRef<AbortController | null>(null);
  const pending = useRef<string | undefined>(undefined);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flush = () => {
    clearTimeout(flushTimer.current);
    flushTimer.current = undefined;
    if (pending.current !== undefined) setText(pending.current);
    pending.current = undefined;
  };
  useEffect(() => {
    if (written.has(key)) return;
    abort.current = new AbortController();
    const onText = (t: string) => {
      pending.current = t;
      flushTimer.current ??= setTimeout(flush, ASK_FLUSH_MS);
    };
    summarize({ ...props.agent, tour: props.tour, onText, signal: abort.current.signal }).then(
      (r) => {
        flush();
        if (r.value) {
          written.set(key, r.value);
          setText(r.value);
        }
        setBusy(false);
      },
      (e: unknown) => {
        if (abort.current?.signal.aborted) return;
        flush();
        setError(safe((e as Error).message));
        setBusy(false);
      },
    );
    return () => {
      abort.current?.abort();
      clearTimeout(flushTimer.current);
    };
    // Written once per tour head.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const lines = renderMarkdown(text, props.width - 4);
  const room = Math.max(3, props.height - 4);
  const maxTop = Math.max(0, lines.length - room);
  useInput((input, k) => {
    if (k.escape || input === 'q' || input === 'i') return props.onClose();
    if (input === 'j' || k.downArrow) setTop((t) => Math.min(maxTop, t + 1));
    if (input === 'k' || k.upArrow) setTop((t) => Math.max(0, t - 1));
    if (input === ' ' || k.pageDown) setTop((t) => Math.min(maxTop, t + room));
    if (k.pageUp) setTop((t) => Math.max(0, t - room));
  });
  return (
    <Box flexDirection="column" paddingX={1} height={props.height}>
      <Text>
        <Text bold>{safe(`#${props.tour.pr} — AI description`)}</Text>
        {busy ? (
          <Text dimColor>
            {' · '}
            <Working label="writing" />
          </Text>
        ) : null}
      </Text>
      <Box flexDirection="column" height={room} marginTop={1}>
        {lines.slice(Math.min(top, maxTop), Math.min(top, maxTop) + room).map((l, i) => (
          <MdLineView key={i} line={l} />
        ))}
        {error ? <Text color="red">{`The description failed: ${error}`}</Text> : null}
      </Box>
      <Hints
        keys={[
          ['j/k', 'scroll'],
          ['esc', 'close'],
        ]}
      />
    </Box>
  );
}
