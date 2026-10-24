import { useState } from 'react';
import { useInput } from 'ink';
import { Box, Text } from './themed.js';
import type { ChecklistItem } from '../types.js';
import { MdLineView, renderMarkdown } from './markdown.js';
import { truncate } from './nav.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';
import { Hints } from './KeyBar.js';

// ---------- Team checklist ----------

const CHECK_MARK = { pass: { m: '✓', c: 'green' }, fail: { m: '✗', c: 'red' }, unknown: { m: '?', c: 'yellow' } } as const;

export function ChecklistPanel(props: { items: ChecklistItem[]; confirms: Record<string, boolean>; width: number; onToggle: (id: string, v: boolean) => void; onClose: () => void }) {
  const [sel, setSel] = useState(0);
  useInput((input, key) => {
    if (key.escape || input === 'i') return props.onClose();
    if (input === 'j' || key.downArrow) setSel((s) => Math.min(props.items.length - 1, s + 1));
    if (input === 'k' || key.upArrow) setSel((s) => Math.max(0, s - 1));
    const it = props.items[sel];
    if ((input === ' ' || key.return) && it) props.onToggle(it.id, !props.confirms[it.id]);
  });
  return (
    <Box flexDirection="column" paddingX={1} width={props.width}>
      <Text bold>
        Team checklist <Text dimColor>· agent pre-check, your confirmation</Text>
      </Text>
      {props.items.map((it, i) => {
        const m = CHECK_MARK[it.status];
        return (
          <Box key={it.id} flexDirection="column">
            <Text inverse={i === sel}>
              {props.confirms[it.id] ? '[x]' : '[ ]'} <Text color={m.c}>{m.m}</Text> {truncate(it.item, props.width - 14)}
              <Text dimColor> ({safe(it.pattern)})</Text>
            </Text>
            {it.reason ? (
              <Text dimColor>
                {'      '}
                {truncate(it.reason, props.width - 10)}
              </Text>
            ) : null}
          </Box>
        );
      })}
      <Hints
        keys={[
          ['space', 'confirm / unconfirm'],
          ['esc', 'close'],
        ]}
      />
    </Box>
  );
}

// ---------- Small prompts ----------

// Full-screen scrollable text, e.g. the PR description.
export function Reader(props: { title: string; markdown: string; width: number; height: number; onClose: () => void }) {
  const lines = renderMarkdown(props.markdown, props.width - 4);
  const room = Math.max(3, props.height - 4);
  const [top, setTop] = useState(0);
  const maxTop = Math.max(0, lines.length - room);
  useInput((input, key) => {
    if (key.escape || input === 'q' || input === 'r') return props.onClose();
    if (input === 'j' || key.downArrow) setTop((t) => Math.min(maxTop, t + 1));
    if (input === 'k' || key.upArrow) setTop((t) => Math.max(0, t - 1));
    if (input === ' ' || key.pageDown) setTop((t) => Math.min(maxTop, t + room));
    if (key.pageUp) setTop((t) => Math.max(0, t - room));
  });
  return (
    <Box flexDirection="column" paddingX={1} height={props.height}>
      <Text bold>{safe(props.title)}</Text>
      <Box flexDirection="column" height={room} marginTop={1}>
        {lines.slice(top, top + room).map((l, i) => (
          <MdLineView key={top + i} line={l} />
        ))}
      </Box>
      <Hints
        keys={[
          ['j/k', 'scroll'],
          ['space', 'page'],
          ['esc', 'back'],
        ]}
        note={lines.length > room ? `${Math.round(((top + room) / lines.length) * 100)}%` : undefined}
      />
    </Box>
  );
}
