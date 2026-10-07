import React, { useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { wrap } from './nav.js';
import { sanitizeTerminal } from '../util/sanitize.js';

// Minimal editable text field: typing, paste, backspace, ←/→, Ctrl+A/E/U/W.
// Shift+Enter or Ctrl+J inserts a newline. Enter calls onSubmit.
export function TextInput(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: (v: string) => void;
  placeholder?: string;
  width: number;
  active?: boolean;
  maxRows?: number;
  mentions?: string[];
  onTab?: (reverse: boolean) => void;
}) {
  const { value, onChange, active = true } = props;
  const [cursor, setCursor] = useState(value.length);
  const c = Math.min(cursor, value.length);
  const mention = /(^|[\s(])@([\w-]*)$/.exec(value.slice(0, c));
  const suggestions = mention ? [...new Set(props.mentions ?? [])].filter((name) => name.toLowerCase().startsWith(mention[2].toLowerCase())).slice(0, 5) : [];

  const insert = (s: string) => {
    onChange(value.slice(0, c) + s + value.slice(c));
    setCursor(c + s.length);
  };

  usePaste((text) => insert(text.replace(/\r\n?/g, '\n')), { isActive: active });

  useInput(
    (input, key) => {
      if (key.return && !key.shift) return props.onSubmit?.(value);
      if (key.tab && mention && suggestions.length) {
        const chosen = suggestions[0];
        const start = c - mention[2].length;
        onChange(value.slice(0, start) + chosen + ' ' + value.slice(c));
        setCursor(start + chosen.length + 1);
        return;
      }
      if (key.tab) return props.onTab?.(key.shift);
      if ((key.return && key.shift) || (key.ctrl && input === 'j')) return insert('\n');
      if (key.leftArrow) return setCursor(Math.max(0, c - 1));
      if (key.rightArrow) return setCursor(Math.min(value.length, c + 1));
      if (key.backspace || key.delete) {
        if (c === 0) return;
        onChange(value.slice(0, c - 1) + value.slice(c));
        return setCursor(c - 1);
      }
      if (key.ctrl && input === 'a') return setCursor(0);
      if (key.ctrl && input === 'e') return setCursor(value.length);
      if (key.ctrl && input === 'u') {
        onChange(value.slice(c));
        return setCursor(0);
      }
      if (key.ctrl && input === 'w') {
        const before = value.slice(0, c).replace(/\S+\s*$/, '');
        onChange(before + value.slice(c));
        return setCursor(before.length);
      }
      if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow) return;
      if (input) insert(input);
    },
    { isActive: active },
  );

  if (!value && props.placeholder) {
    return (
      <Text>
        {active ? <Text inverse> </Text> : null}
        <Text dimColor>{props.placeholder}</Text>
      </Text>
    );
  }
  // The value can be pasted or prefilled from untrusted text, so strip terminal controls
  // before inserting the \u0000 cursor marker (which sanitizeTerminal would also remove).
  const shown = active ? sanitizeTerminal(value.slice(0, c)) + '\u0000' + sanitizeTerminal(value.slice(c)) : sanitizeTerminal(value);
  let rows = wrap(shown, Math.max(10, props.width));
  if (props.maxRows && rows.length > props.maxRows) rows = rows.slice(rows.length - props.maxRows);
  const field = (
    <Text>
      {rows.map((r, i) => {
        const at = r.indexOf('\u0000');
        const line =
          at < 0 ? (
            r
          ) : (
            <>
              {r.slice(0, at)}
              <Text inverse>{r[at + 1] ?? ' '}</Text>
              {r.slice(at + 2)}
            </>
          );
        return (
          <React.Fragment key={i}>
            {line}
            {i < rows.length - 1 ? '\n' : ''}
          </React.Fragment>
        );
      })}
    </Text>
  );
  return suggestions.length ? (
    <Box flexDirection="column">
      {field}
      <Text dimColor>{sanitizeTerminal(suggestions.map((name) => `@${name}`).join('  '))} · Tab to complete</Text>
    </Box>
  ) : (
    field
  );
}
