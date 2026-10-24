import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useTheme } from './themed.js';
import { highlightFileLines, type SyntaxSpan } from './highlight.js';
import { readLines } from './references.js';
import { truncate } from './nav.js';
import { sanitizeTerminal } from '../util/sanitize.js';
import { G } from './glyphs.js';

// Read-only source around a location in the worktree: the preview beside
// the @ completion list. Reads are bounded (safeReadFile) and every line is sanitized.

const MAX_HIGHLIGHT_LINES = 3000;
const highlightCache = new Map<string, Promise<SyntaxSpan[][] | undefined>>();

function highlightsFor(path: string, lines: string[], theme: string): Promise<SyntaxSpan[][] | undefined> {
  const key = `${theme}\0${path}\0${lines.length}\0${lines[0] ?? ''}`;
  let p = highlightCache.get(key);
  if (!p) {
    p = highlightFileLines(path, lines.join('\n'), undefined, theme).catch(() => undefined);
    highlightCache.set(key, p);
    if (highlightCache.size > 24) highlightCache.delete(highlightCache.keys().next().value!);
  }
  return p;
}

const clean = (s: string) => sanitizeTerminal(s.replace(/\t/g, '  '));

export function SourcePreview(props: {
  root?: string;
  path: string;
  startLine?: number;
  endLine?: number;
  cursor?: number; // a line cursor (selecting lines); the view follows it
  sel?: [number, number] | null;
  title?: string;
  width: number;
  height: number;
}) {
  const { root, path, width, height } = props;
  const lines = useMemo(() => readLines(root, path), [root, path]);
  const [spans, setSpans] = useState<{ path: string; spans?: SyntaxSpan[][] }>({ path: '' });
  const { syntax } = useTheme();
  useEffect(() => {
    let live = true;
    if (lines && lines.length <= MAX_HIGHLIGHT_LINES) void highlightsFor(path, lines, syntax).then((s) => live && setSpans({ path, spans: s }));
    return () => {
      live = false;
    };
  }, [path, lines, syntax]);
  const rows = Math.max(1, height - 1);
  const header = <Text dimColor>{truncate(props.title ?? path, width)}</Text>;
  if (!lines)
    return (
      <Box flexDirection="column" width={width} height={height}>
        {header}
        <Text dimColor>{root ? 'Not readable here: too large, not a plain file, or not in this checkout.' : 'The checkout is not ready.'}</Text>
      </Box>
    );
  const focus = props.cursor ?? props.startLine ?? 1;
  const top = Math.max(0, Math.min(focus - 1 - Math.floor(rows / 3), lines.length - rows));
  const inRange = (n: number) => (props.sel ? n >= props.sel[0] && n <= props.sel[1] : props.startLine !== undefined && n >= props.startLine && n <= (props.endLine ?? props.startLine));
  const codeW = Math.max(1, width - 7);
  const hl = spans.path === path ? spans.spans : undefined;
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {header}
      {lines.slice(top, top + rows).map((raw, k) => {
        const n = top + k + 1;
        const code = clean(raw).slice(0, codeW);
        const mark = props.cursor === n ? G.cursor : inRange(n) ? G.range : ' ';
        return (
          <Text key={n} wrap="truncate">
            <Text color={props.cursor === n ? 'cyan' : 'blue'}>{mark}</Text>
            <Text dimColor>{String(n).padStart(5)} </Text>
            <Spans text={code} spans={hl?.[n - 1]} />
          </Text>
        );
      })}
    </Box>
  );
}

function Spans(props: { text: string; spans?: SyntaxSpan[] }) {
  const { text } = props;
  const spans = (props.spans ?? []).filter((s) => s.start < text.length);
  if (!spans.length) return <Text>{text}</Text>;
  const cuts = [...new Set([0, text.length, ...spans.flatMap((s) => [Math.min(s.start, text.length), Math.min(s.end, text.length)])])].sort((a, b) => a - b);
  return (
    <Text>
      {cuts.slice(0, -1).map((start, i) => (
        <Text key={start} color={spans.find((s) => s.start <= start && cuts[i + 1] <= s.end)?.color}>
          {text.slice(start, cuts[i + 1])}
        </Text>
      ))}
    </Text>
  );
}
