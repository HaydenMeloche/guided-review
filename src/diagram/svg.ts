import fs from 'node:fs';
import path from 'node:path';
import { grHome } from '../paths.js';
import type { Graph, GraphNode } from '../types.js';
import { layerGraph } from './text.js';
import { sanitizeTerminal } from '../util/sanitize.js';
import { openExternal } from '../util/openExternal.js';

const CHAR_W = 7.4;
const LINE_H = 16;
const PAD_X = 14;
const PAD_Y = 10;
const GAP_X = 36;
const GAP_Y = 56;
const MARGIN = 24;

function esc(s: string): string {
  return sanitizeTerminal(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface Box {
  node: GraphNode;
  lines: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

function layoutColumn(g: Graph, offsetX: number): { boxes: Box[]; width: number; height: number } {
  const { level } = layerGraph(g);
  const layers: GraphNode[][] = [];
  for (const n of g.nodes) (layers[level.get(n.id)!] ??= []).push(n);
  const boxes: Box[] = [];
  const rowWidths: number[] = []; // parallel to boxes
  let y = MARGIN;
  let width = 0;
  for (const nodes of layers.filter(Boolean)) {
    const sized = nodes.map((node) => {
      const lines = node.label.split('\n');
      return { node, lines, w: Math.max(...lines.map((l) => l.length)) * CHAR_W + PAD_X * 2, h: lines.length * LINE_H + PAD_Y * 2 };
    });
    const rowW = sized.reduce((s, b) => s + b.w, 0) + GAP_X * (sized.length - 1);
    width = Math.max(width, rowW);
    const rowH = Math.max(...sized.map((b) => b.h));
    let x = 0;
    for (const b of sized) {
      boxes.push({ ...b, x, y: y + (rowH - b.h) / 2 });
      rowWidths.push(rowW);
      x += b.w + GAP_X;
    }
    y += rowH + GAP_Y;
  }
  // Center each row in the column.
  boxes.forEach((b, i) => (b.x += offsetX + MARGIN + (width - rowWidths[i]) / 2));
  return { boxes, width: width + MARGIN * 2, height: y - GAP_Y + MARGIN };
}

// Fixed colors for a diagram, such as the interface theme's; without them it follows the
// browser's light or dark setting.
export interface SvgColors {
  scheme: 'light' | 'dark';
  bg: string;
  fg: string;
  muted: string;
  line: string;
  box: string;
  hl: string;
  hlLine: string;
}

const svgVars = (c: SvgColors) => `--fg: ${c.fg}; --muted: ${c.muted}; --line: ${c.line}; --box: ${c.box}; --hl: ${c.hl}; --hl-line: ${c.hlLine};`;

export function graphToSvg(g: Graph, colors?: SvgColors): string {
  const groups = g.kind === 'before-after' ? ['before', 'after'] : [undefined];
  const boxes: Box[] = [];
  let width = 0;
  let height = 0;
  const headers: string[] = [];
  for (const group of groups) {
    const nodes = group ? g.nodes.filter((n) => (n.group ?? 'after') === group) : g.nodes;
    const ids = new Set(nodes.map((n) => n.id));
    const sub = { ...g, nodes, edges: g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
    const col = layoutColumn(sub, width);
    if (group) headers.push(`<text class="hdr" x="${width + MARGIN}" y="16">${group === 'before' ? 'Before' : 'After'}</text>`);
    boxes.push(...col.boxes);
    width += col.width;
    height = Math.max(height, col.height);
  }
  const byId = new Map(boxes.map((b) => [b.node.id, b]));
  const edges = g.edges
    .map((e) => {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) return '';
      const x1 = a.x + a.w / 2;
      const x2 = b.x + b.w / 2;
      const down = b.y > a.y;
      const y1 = down ? a.y + a.h : a.y;
      const y2 = down ? b.y : b.y + b.h;
      const my = (y1 + y2) / 2;
      const dash = e.confidence === 'naming' || e.confidence === 'name-match' || e.confidence === 'model' ? ' stroke-dasharray="5 4"' : '';
      const label = e.label ? `<text class="elabel" x="${(x1 + x2) / 2 + 6}" y="${my - 4}">${esc(e.label)}</text>` : '';
      return `<path class="edge" d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}"${dash} marker-end="url(#arrow)"/>${label}`;
    })
    .join('\n');
  const nodes = boxes
    .map((b) => {
      const cls = b.node.changed ? 'node changed' : 'node';
      const text = b.lines.map((l, i) => `<text x="${b.x + PAD_X}" y="${b.y + PAD_Y + LINE_H * (i + 0.8)}"${i ? ' class="sub"' : ''}>${esc(l)}</text>`).join('');
      const title = b.node.hunkId ? `<title>${esc(b.node.label)} (hunk ${esc(b.node.hunkId)})</title>` : '';
      return `<g class="${cls}" data-hunk="${esc(b.node.hunkId ?? '')}">${title}<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="6"/>${text}</g>`;
    })
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(width)} ${Math.ceil(height)}" width="${Math.ceil(width)}" height="${Math.ceil(height)}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">
<style>
${
  colors
    ? `  :root { ${svgVars(colors)} }`
    : `  :root { --fg: #1f2328; --muted: #59636e; --line: #8c959f; --box: #ffffff; --hl: #fff8c5; --hl-line: #bf8700; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --line: #6e7681; --box: #161b22; --hl: #3b2e00; --hl-line: #d29922; } }`
}
  .node rect { fill: var(--box); stroke: var(--line); stroke-width: 1; }
  .node.changed rect { fill: var(--hl); stroke: var(--hl-line); stroke-width: 2; }
  .node text { fill: var(--fg); }
  .node text.sub, .elabel { fill: var(--muted); font-size: 11px; }
  .hdr { fill: var(--muted); font-weight: 600; }
  .edge { fill: none; stroke: var(--line); stroke-width: 1.4; }
  #arrow path { fill: var(--line); }
</style>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>
${headers.join('\n')}
${edges}
${nodes}
</svg>`;
}

export async function openGraphInBrowser(g: Graph, colors?: SvgColors): Promise<string> {
  const dir = path.join(grHome(), 'diagrams');
  fs.mkdirSync(dir, { recursive: true });
  const slug =
    g.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'diagram';
  const file = path.join(dir, `${slug}-${Date.now()}.html`);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(g.title)}</title>
<style>
${
  colors
    ? `  :root { color-scheme: ${colors.scheme}; --bg: ${colors.bg}; --fg: ${colors.fg}; }`
    : `  :root { color-scheme: light dark; --bg: #f6f8fa; --fg: #1f2328; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; } }`
}
  body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font-family: system-ui, sans-serif; }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 16px; }
  .wrap { overflow-x: auto; }
  svg { max-width: none; }
</style></head>
<body><h1>${esc(g.title)}</h1><div class="wrap">${graphToSvg(g, colors)}</div></body></html>`;
  fs.writeFileSync(file, html);
  await openExternal(file);
  return file;
}
