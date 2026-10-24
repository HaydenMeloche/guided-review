import React, { useMemo, useState } from 'react';
import { useInput } from 'ink';
import { Box, Text, useTheme } from './themed.js';
import { diagramColors, ROLES } from './theme.js';
import type { Graph } from '../types.js';
import { renderGraph, type TextDiagram } from '../diagram/text.js';
import { openGraphInBrowser } from '../diagram/svg.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';
import { Hints } from './KeyBar.js';

interface Span {
  start: number;
  end: number;
  kind: 'changed' | 'selected';
}

type DiagramBox = TextDiagram['boxes'][number];
type Role = 'border' | 'label' | 'line' | 'changedBorder' | 'changedLabel' | 'selected';

// How each kind of character is drawn. A changed box is bold, its frame in the theme's heading
// color and its text in the title color; unchanged boxes and arrows recede into the comment
// color. With the terminal's colors a changed box is bold yellow and the rest plain text.
const ROLE_STYLE: Record<Role, { color?: string; bold?: boolean; inverse?: boolean }> = {
  border: { color: ROLES.line },
  label: {},
  line: { color: ROLES.line },
  changedBorder: { color: ROLES.changedBox, bold: true },
  changedLabel: { color: ROLES.changedText, bold: true },
  selected: { color: 'cyan', inverse: true },
};

// A role per character: a box's frame or its text, an arrow or edge label outside the boxes,
// then the changed boxes and the selected one over them.
export function rowRoles(line: string, row: number, boxes: DiagramBox[], spans: Span[]): (Role | undefined)[] {
  // Indexed like the renderer's spans, by UTF-16 unit.
  const roles: (Role | undefined)[] = line.split('').map((ch) => (ch === ' ' ? undefined : 'line'));
  for (const b of boxes) {
    if (row < b.row || row >= b.row + b.height) continue;
    const edgeRow = row === b.row || row === b.row + b.height - 1;
    for (let c = b.col; c < b.col + b.width && c < roles.length; c++) {
      const edgeCol = c === b.col || c === b.col + b.width - 1;
      roles[c] = edgeRow || edgeCol ? 'border' : line[c] === ' ' ? undefined : 'label';
    }
  }
  for (const s of spans.filter((x) => x.kind === 'changed'))
    for (let c = s.start; c < s.end && c < roles.length; c++) {
      if (roles[c] === 'border') roles[c] = 'changedBorder';
      else if (roles[c]) roles[c] = 'changedLabel';
    }
  for (const s of spans.filter((x) => x.kind === 'selected')) for (let c = s.start; c < s.end && c < roles.length; c++) roles[c] = 'selected';
  return roles;
}

function renderRow(line: string, row: number, boxes: DiagramBox[], spans: Span[], key: number) {
  const chars = line.split('');
  const roles = rowRoles(line, row, boxes, spans);
  const parts: React.ReactNode[] = [];
  for (let i = 0; i < chars.length;) {
    let j = i + 1;
    while (j < chars.length && roles[j] === roles[i]) j++;
    const text = chars.slice(i, j).join('');
    const role = roles[i];
    parts.push(
      role ? (
        <Text key={i} {...ROLE_STYLE[role]}>
          {text}
        </Text>
      ) : (
        text
      ),
    );
    i = j;
  }
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
  const palette = useTheme();
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
        openGraphInBrowser(graph, diagramColors(palette)).then(
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
        if (box && row >= box.row && row < box.row + box.height) spans.push({ start: box.col, end: box.col + box.width, kind: 'selected' });
        return renderRow(line, row, rendered.boxes, spans, i);
      })}
      {interactive ? (
        msg ? (
          <Text dimColor>{safe(msg)}</Text>
        ) : (
          <Hints
            keys={[
              ['tab', `next node${selected ? ` (${safe(selected.label)})` : ''}`],
              ['enter', 'jump to its code'],
              ['c', 'comment on node'],
              ['b', 'open SVG in browser'],
              ['esc', 'close'],
            ]}
          />
        )
      ) : null}
    </Box>
  );
}
