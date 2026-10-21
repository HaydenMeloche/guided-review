import React from 'react';
import { Text } from '../themed.js';
import { SURFACES } from '../theme.js';
import type { SyntaxSpan } from '../highlight.js';
import type { CharRange } from '../../diff/lines.js';

// Syntax colors, plus a background on the `emphasis` ranges (the words a changed line changed).
// Span and range offsets are into the whole line; `column` is where this chunk of it starts.
export function SyntaxText(props: { text: string; spans?: SyntaxSpan[]; column?: number; emphasis?: CharRange[]; emphasisColor?: string }) {
  const { text } = props;
  const column = props.column ?? 0;
  const clip = (x: number) => Math.max(0, Math.min(text.length, x - column));
  const spans = (props.spans ?? []).map((s) => ({ start: clip(s.start), end: clip(s.end), color: s.color })).filter((s) => s.end > s.start);
  const emphasis = (props.emphasis ?? []).map(([s, e]) => [clip(s), clip(e)]).filter(([s, e]) => e > s);
  const cuts = [...new Set([0, text.length, ...spans.flatMap((s) => [s.start, s.end]), ...emphasis.flat()])].sort((a, b) => a - b);
  const parts: React.ReactNode[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const [start, end] = [cuts[k], cuts[k + 1]];
    const color = spans.find((s) => s.start <= start && end <= s.end)?.color;
    const backgroundColor = emphasis.some(([s, e]) => s <= start && end <= e) ? props.emphasisColor : undefined;
    parts.push(
      <Text key={start} color={color} backgroundColor={backgroundColor}>
        {text.slice(start, end)}
      </Text>,
    );
  }
  return <Text>{parts}</Text>;
}

export const DIFF_BACKGROUND = { add: SURFACES.lineAdd, del: SURFACES.lineDel, ctx: undefined } as const;
export const WORD_BACKGROUND = { add: SURFACES.wordAdd, del: SURFACES.wordDel, ctx: undefined } as const;
