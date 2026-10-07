import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Graph } from '../types.js';
import { renderGraph } from '../diagram/text.js';
import { openGraphInBrowser } from '../diagram/svg.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';

interface Span {
  start: number;
  end: number;
  kind: 'changed' | 'selected';
}

function renderRow(line: string, spans: Span[], key: number) {
  if (!spans.length) return <Text key={key}>{line}</Text>;
  const parts: React.ReactNode[] = [];
  let pos = 0;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  sorted.forEach((s, i) => {
    if (s.start < pos) return;
    if (s.start > pos) parts.push(line.slice(pos, s.start));
    const seg = line.slice(s.start, s.end);
    parts.push(
      s.kind === 'selected' ? (
        <Text key={i} inverse color="cyan">
          {seg}
        </Text>
      ) : (
        <Text key={i} color="yellow" bold>
          {seg}
        </Text>
      ),
    );
    pos = s.end;
  });
  parts.push(line.slice(pos));
  return <Text key={key}>{parts}</Text>;
}

// Box-drawing diagram. Tab/arrows pick a node; Enter jumps to its hunk,
// c comments on the node, b opens the SVG version in the browser.
export function DiagramView(props: {
  graph: Graph;
  width: number;
  height: number;
  interactive?: boolean;
  onJump?: (hunkId: string) => void;
  onComment?: (nodeId: string) => void;
  onClose?: () => void;
}) {
  const { graph, width, height, interactive = true } = props;
  const rendered = useMemo(() => renderGraph(graph, Math.max(20, width - 2)), [graph, width]);
  const selectable = graph.nodes;
  const [sel, setSel] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [msg, setMsg] = useState('');
  const selected = selectable[sel];

  useInput(
    (input, key) => {
      if (key.escape || input === 'q' || input === 'd') return props.onClose?.();
      if ((key.tab && !key.shift) || key.rightArrow || key.downArrow || input === 'l') setSel((s) => (s + 1) % Math.max(1, selectable.length));
      if ((key.tab && key.shift) || key.leftArrow || key.upArrow || input === 'h') setSel((s) => (s - 1 + selectable.length) % Math.max(1, selectable.length));
      if (input === 'j') setScroll((s) => Math.min(Math.max(0, rendered.lines.length - height + 2), s + 1));
      if (input === 'k') setScroll((s) => Math.max(0, s - 1));
      if (key.return && selected?.hunkId) props.onJump?.(selected.hunkId);
      if (key.return && selected && !selected.hunkId) setMsg('This node has no hunk of its own.');
      if (input === 'c' && selected) props.onComment?.(selected.id);
      if (input === 'b')
        openGraphInBrowser(graph).then(
          (p) => setMsg(`Opened ${p}`),
          (e: unknown) => setMsg(`Could not open: ${(e as Error).message}`),
        );
    },
    { isActive: interactive },
  );

  const box = interactive && selected ? rendered.boxes.find((b) => b.nodeId === selected.id) : undefined;
  // Keep the selected box in view.
  let top = scroll;
  if (box && (box.row < top || box.row + box.height > top + height - 2)) top = Math.max(0, box.row - 1);
  const visible = rendered.lines.slice(top, top + Math.max(1, height - (interactive ? 2 : 0)));

  return (
    <Box flexDirection="column">
      {interactive ? (
        <Text bold>
          {safe(graph.title)} <Text dimColor>({graph.kind} diagram · changed parts in bold)</Text>
        </Text>
      ) : null}
      {visible.map((line, i) => {
        const row = top + i;
        const spans: Span[] = rendered.highlights.filter((h) => h.row === row).map((h) => ({ start: h.start, end: h.end, kind: 'changed' as const }));
        if (box && row >= box.row && row < box.row + box.height) {
          spans.push({ start: box.col, end: box.col + box.width, kind: 'selected' });
          return renderRow(
            line,
            spans.filter((s) => s.kind === 'selected' || s.end <= box.col || s.start >= box.col + box.width),
            i,
          );
        }
        return renderRow(line, spans, i);
      })}
      {interactive ? (
        <Text dimColor>{safe(msg) || `tab: next node${selected ? ` (${safe(selected.label)})` : ''} · enter: jump to its code · c: comment on node · b: open SVG in browser · esc: close`}</Text>
      ) : null}
    </Box>
  );
}
