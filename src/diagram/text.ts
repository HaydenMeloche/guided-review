import type { Graph, GraphNode } from '../types.js';
import { sanitizeTerminal } from '../util/sanitize.js';

export interface TextDiagram {
  lines: string[];
  highlights: { row: number; start: number; end: number }[];
  boxes: { nodeId: string; row: number; col: number; width: number; height: number }[];
}

const GAP_X = 3;
const MAX_LABEL = 32; // box text width; longer labels wrap
const MAX_LABEL_LINES = 3;
const MAX_EDGE_LABEL = 28;

const UP = 1;
const DOWN = 2;
const LEFT = 4;
const RIGHT = 8;
const JOIN: Record<number, string> = {
  [UP]: '│',
  [DOWN]: '│',
  [UP | DOWN]: '│',
  [LEFT]: '─',
  [RIGHT]: '─',
  [LEFT | RIGHT]: '─',
  [DOWN | RIGHT]: '┌',
  [DOWN | LEFT]: '┐',
  [UP | RIGHT]: '└',
  [UP | LEFT]: '┘',
  [UP | DOWN | RIGHT]: '├',
  [UP | DOWN | LEFT]: '┤',
  [DOWN | LEFT | RIGHT]: '┬',
  [UP | LEFT | RIGHT]: '┴',
  [UP | DOWN | LEFT | RIGHT]: '┼',
};

interface Item {
  id: string;
  node?: GraphNode; // undefined for dummy pass-through items
  lines: string[];
  width: number;
  height: number;
  x: number;
  row: number;
}

function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

function len(s: string): number {
  return [...s].length;
}

// Longest-path layering over the graph with back edges reversed.
export function layerGraph(g: Graph): { level: Map<string, number>; edges: { from: string; to: string; label?: string; reversed: boolean }[] } {
  const ids = g.nodes.map((n) => n.id);
  const known = new Set(ids);
  const raw = g.edges.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to);
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of raw) adj.get(e.from)!.push(e.to);
  const state = new Map<string, number>(); // 1 visiting, 2 done
  const back = new Set<string>();
  const dfs = (u: string) => {
    state.set(u, 1);
    for (const v of adj.get(u)!) {
      if (state.get(v) === 1) back.add(`${u}->${v}`);
      else if (!state.get(v)) dfs(v);
    }
    state.set(u, 2);
  };
  for (const id of ids) if (!state.get(id)) dfs(id);
  const edges = raw.map((e) => {
    const reversed = back.has(`${e.from}->${e.to}`);
    return reversed ? { from: e.to, to: e.from, label: e.label, reversed } : { from: e.from, to: e.to, label: e.label, reversed };
  });
  const level = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let i = 0; i < ids.length; i++) {
    let changed = false;
    for (const e of edges) {
      const want = level.get(e.from)! + 1;
      if (level.get(e.to)! < want) {
        level.set(e.to, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { level, edges };
}

// Word-wraps each line of a label to the box width (up to 3 lines each), so long
// names stay readable instead of being cut. Entity labels keep one line per column.
function wrapLabel(label: string, inner: number): string[] {
  const out: string[] = [];
  for (const para of label.split('\n')) {
    const wrapped: string[] = [];
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      // Long identifiers (Type.field, src/dir/file) may also break after a dot or slash.
      word.split(/(?<=[./])(?=.)/).forEach((piece, i) => {
        const sep = i === 0 ? ' ' : '';
        if (line && len(line) + len(sep) + len(piece) > inner) {
          wrapped.push(line);
          line = piece;
        } else line = line ? `${line}${sep}${piece}` : piece;
      });
    }
    wrapped.push(line);
    if (wrapped.length > MAX_LABEL_LINES) {
      wrapped.splice(MAX_LABEL_LINES - 1, wrapped.length, wrapped.slice(MAX_LABEL_LINES - 1).join(' '));
    }
    out.push(...wrapped.map((l) => truncate(l, inner)));
  }
  return out;
}

function layout(g: Graph, maxWidth: number): TextDiagram {
  if (!g.nodes.length) return { lines: [], highlights: [], boxes: [] };
  const inner = Math.max(1, Math.min(MAX_LABEL, maxWidth - 4));
  const { level, edges } = layerGraph(g);

  const items = new Map<string, Item>();
  for (const n of g.nodes) {
    const lines = wrapLabel(n.label, inner);
    const width = Math.max(...lines.map(len)) + 4;
    items.set(n.id, { id: n.id, node: n, lines, width, height: lines.length + 2, x: 0, row: 0 });
  }

  // Group by layer, then order each layer by the barycenter of its parents.
  const maxLevel = Math.max(...level.values());
  const layers: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const n of g.nodes) layers[level.get(n.id)!].push(n.id);
  const parents = new Map<string, string[]>();
  for (const e of edges) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from]);
  const pos = new Map<string, number>();
  layers[0].forEach((id, i) => pos.set(id, i));
  for (let l = 1; l < layers.length; l++) {
    const bary = (id: string) => {
      const ps = (parents.get(id) ?? []).map((p) => pos.get(p)).filter((x): x is number => x !== undefined);
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Infinity;
    };
    layers[l].sort((a, b) => bary(a) - bary(b));
    layers[l].forEach((id, i) => pos.set(id, i));
  }

  // Wrap layers that overflow the width into several rows.
  const rows: string[][] = [];
  for (const ids of layers) {
    let cur: string[] = [];
    let w = 0;
    for (const id of ids) {
      const iw = items.get(id)!.width;
      if (cur.length && w + GAP_X + iw > maxWidth) {
        rows.push(cur);
        cur = [];
        w = 0;
      }
      w += (cur.length ? GAP_X : 0) + iw;
      cur.push(id);
    }
    if (cur.length) rows.push(cur);
  }
  rows.forEach((r, i) => r.forEach((id) => (items.get(id)!.row = i)));

  // Edges that skip rows pass through 1-wide dummy items in each row between.
  // Back edges and edges inside one wrapped row have no clean route; they are listed under the diagram.
  const segs: { from: string; to: string; target: string; label?: string; last: boolean; first: boolean }[] = [];
  const footer: string[] = [];
  const name = (id: string) => items.get(id)!.node?.label.replace(/\s*\n\s*/g, ' ') ?? id;
  let dummy = 0;
  const chains: string[][] = []; // the pass-through items of each long edge, top to bottom
  for (const e of edges) {
    const a = items.get(e.from)!;
    const b = items.get(e.to)!;
    if (e.reversed || b.row <= a.row) {
      const [from, to] = e.reversed ? [e.to, e.from] : [e.from, e.to];
      footer.push(`${e.reversed ? '↺' : '→'} ${name(from)} → ${name(to)}${e.label ? ` (${e.label})` : ''}`);
      continue;
    }
    let prev = e.from;
    const chain: string[] = [];
    chains.push(chain);
    for (let r = a.row + 1; r < b.row; r++) {
      const id = `__d${dummy++}`;
      items.set(id, { id, lines: [], width: 1, height: 0, x: 0, row: r });
      rows[r].push(id);
      chain.push(id);
      segs.push({ from: prev, to: id, target: e.to, label: prev === e.from ? e.label : undefined, first: prev === e.from, last: false });
      prev = id;
    }
    segs.push({ from: prev, to: e.to, target: e.to, label: prev === e.from ? e.label : undefined, first: prev === e.from, last: true });
  }

  // x: pull each item toward its parents' centers, keeping order and fitting the width.
  const center = (it: Item) => it.x + Math.floor(it.width / 2);
  const segParents = new Map<string, string[]>();
  for (const s of segs) segParents.set(s.to, [...(segParents.get(s.to) ?? []), s.from]);
  const parentCenter = (id: string) => {
    const it = items.get(id)!;
    const ps = (segParents.get(id) ?? []).map((p) => items.get(p)!).filter((p) => p.row < it.row);
    return ps.length ? ps.reduce((s, p) => s + center(p), 0) / ps.length : undefined;
  };
  // Returns how far left of column 0 a box wanted to go to sit centred under its parents.
  const place = (pinned: Map<string, number>, origin: number) => {
    let deficit = 0;
    for (const r of rows) {
      // Pass-through items were appended to their row; on the first pass, sort the row by where
      // each item's parents are so a long edge runs straight down instead of being pushed past
      // every box. An item with no parents keeps its place after its predecessor. Later passes
      // keep that order so lines cannot swap and drift.
      if (!pinned.size) {
        let prev = -Infinity;
        const keyed = r.map((id) => ({ id, key: (prev = parentCenter(id) ?? prev) }));
        keyed.sort((p, q) => p.key - q.key).forEach((k, i) => (r[i] = k.id));
      }
      let x = 0;
      for (const id of r) {
        const it = items.get(id)!;
        const c = parentCenter(id);
        const want = pinned.get(id) ?? (c === undefined ? Math.max(x, origin) : Math.round(c - it.width / 2));
        if (x === 0 && want < 0) deficit = Math.max(deficit, -want);
        it.x = Math.max(x, want);
        x = it.x + it.width + GAP_X;
      }
      let limit = maxWidth;
      for (let i = r.length - 1; i >= 0; i--) {
        const it = items.get(r[i])!;
        if (it.x + it.width > limit) it.x = Math.max(0, limit - it.width);
        limit = it.x - GAP_X;
      }
    }
    return deficit;
  };
  // A long edge's pass-through items get pushed by boxes of different widths row by row, which
  // makes the line jog. Place once, then pin every item of each chain to the rightmost column
  // any of them needed and place again, so the line runs straight.
  // Rows start at an origin column; if a box at the left edge could not be centred under its
  // parent (it would need a negative column), shift the start right by that much when it fits.
  const deficit = place(new Map(), 0);
  const right = Math.max(...[...items.values()].map((it) => it.x + it.width));
  const origin = deficit && right + deficit <= maxWidth ? deficit : 0;
  if (origin) place(new Map(), origin);
  // Pinning can move boxes, which can push a chain again; a few rounds settle it (each round only moves things right, so it ends).
  const pinned = new Map<string, number>();
  for (let round = 0; round < 10 && chains.length; round++) {
    let moved = false;
    for (const chain of chains) {
      const col = Math.max(...chain.map((id) => items.get(id)!.x));
      for (const id of chain) {
        if (pinned.get(id) !== col) moved = true;
        pinned.set(id, col);
      }
    }
    if (!moved) break;
    place(pinned, origin);
  }

  // Each source with a sideways run gets its own horizontal track in the gap below its row, so
  // lines from different parents never merge: a junction always belongs to one source. A gap is
  // a stub row, one row per track, and an arrow row.
  const track = new Map<string, number>();
  const tracksInGap = rows.map(() => 0);
  // Each edge into a box gets its own arrowhead, so arrows are never shared and every label can
  // sit beside its own. An arrowhead goes straight below its line where that falls on the box's
  // top, nudged apart (two columns minimum) to keep them in their sources' order.
  const port = new Map<(typeof segs)[number], number>();
  const incoming = new Map<string, (typeof segs)[number][]>();
  for (const s of segs) incoming.set(s.to, [...(incoming.get(s.to) ?? []), s]);
  for (const [id, list] of incoming) {
    const b = items.get(id)!;
    const lo = b.x + 1;
    const hi = b.x + b.width - 2;
    if (!b.node || list.length < 2 || hi - lo < (list.length - 1) * 2) {
      for (const s of list) port.set(s, center(b));
      continue;
    }
    list.sort((p, q) => center(items.get(p.from)!) - center(items.get(q.from)!));
    const cols = list.map((s) => Math.min(hi, Math.max(lo, center(items.get(s.from)!))));
    for (let i = 1; i < cols.length; i++) cols[i] = Math.max(cols[i], cols[i - 1] + 2);
    for (let i = cols.length - 1; i >= 0; i--) cols[i] = Math.min(cols[i], i === cols.length - 1 ? hi : cols[i + 1] - 2);
    list.forEach((s, i) => port.set(s, cols[i]));
  }
  const sideways = segs.filter((s) => center(items.get(s.from)!) !== port.get(s)).map((s) => s.from);
  for (const id of [...new Set(sideways)].sort((p, q) => center(items.get(p)!) - center(items.get(q)!))) {
    track.set(id, tracksInGap[items.get(id)!.row]++);
  }
  const rowHeight = rows.map((r) => Math.max(1, ...r.map((id) => items.get(id)!.height)));
  const rowY: number[] = [];
  let y = 0;
  for (let i = 0; i < rows.length; i++) {
    rowY.push(y);
    y += rowHeight[i] + (i < rows.length - 1 ? 2 + Math.max(1, tracksInGap[i]) : 0);
  }
  const totalHeight = y;

  const width = maxWidth;
  const chars: string[][] = Array.from({ length: totalHeight }, () => Array<string>(width).fill(' '));
  const mask: number[][] = Array.from({ length: totalHeight }, () => Array<number>(width).fill(0));
  const put = (r: number, c: number, ch: string) => {
    if (r >= 0 && r < totalHeight && c >= 0 && c < width) chars[r][c] = ch;
  };
  // Which source drew which bits in a cell, so a crossing of two sources' lines can be told
  // apart from a junction of one source's.
  const owners = new Map<number, Map<string, number>>();
  const link = (r: number, c: number, bits: number, owner: string) => {
    if (r < 0 || r >= totalHeight || c < 0 || c >= width) return;
    mask[r][c] |= bits;
    const cell = owners.get(r * width + c) ?? new Map<string, number>();
    cell.set(owner, (cell.get(owner) ?? 0) | bits);
    owners.set(r * width + c, cell);
  };

  const highlights: TextDiagram['highlights'] = [];
  const boxes: TextDiagram['boxes'] = [];
  for (const it of items.values()) {
    const top = rowY[it.row];
    if (!it.node) {
      for (let r = top; r < top + rowHeight[it.row]; r++) link(r, it.x, UP | DOWN, it.id);
      continue;
    }
    const heavy = !!it.node.changed;
    // Every box has rounded corners; a changed one stands out by its color and bold name (the
    // highlight below), not by double lines.
    const [tl, tr, bl, br, h, v] = ['╭', '╮', '╰', '╯', '─', '│'];
    const w = it.width;
    put(top, it.x, tl);
    put(top, it.x + w - 1, tr);
    put(top + it.height - 1, it.x, bl);
    put(top + it.height - 1, it.x + w - 1, br);
    for (let c = 1; c < w - 1; c++) {
      put(top, it.x + c, h);
      put(top + it.height - 1, it.x + c, h);
    }
    it.lines.forEach((line, i) => {
      put(top + 1 + i, it.x, v);
      put(top + 1 + i, it.x + w - 1, v);
      [...line.padEnd(w - 4)].forEach((ch, j) => put(top + 1 + i, it.x + 2 + j, ch));
    });
    boxes.push({ nodeId: it.id, row: top, col: it.x, width: w, height: it.height });
    if (heavy) for (let r = top; r < top + it.height; r++) highlights.push({ row: r, start: it.x, end: Math.min(width, it.x + w) });
  }

  const labels: { text: string; stub: { row: number; col: number }; branches: { row: number; col: number }[]; from: string; to: string }[] = [];
  let labeled: (typeof labels)[number] | undefined;
  const arrivals = new Map<string, number>(); // edges arriving at each arrow
  for (const s of segs) {
    const a = items.get(s.from)!;
    const b = items.get(s.to)!;
    const sx = center(a);
    const tx = port.get(s)!;
    const aBottom = rowY[a.row] + (a.node ? a.height - 1 : rowHeight[a.row] - 1);
    const gapTop = rowY[a.row] + rowHeight[a.row];
    const bTop = rowY[b.row];
    if (a.node) put(aBottom, sx, a.node.changed ? '╤' : '┬');
    const arrowRow = bTop - 1;
    const trackRow = gapTop + 1 + (track.get(s.from) ?? 0);
    const down = (from: number, to: number, c: number) => {
      for (let r = from; r < to; r++) link(r, c, UP | DOWN, s.from);
    };
    // Short boxes in a tall row: extend the stub to the gap.
    down(aBottom + 1, sx === tx ? arrowRow : trackRow, sx);
    if (sx !== tx) {
      link(trackRow, sx, UP | (tx > sx ? RIGHT : LEFT), s.from);
      for (let c = Math.min(sx, tx) + 1; c < Math.max(sx, tx); c++) link(trackRow, c, LEFT | RIGHT, s.from);
      link(trackRow, tx, DOWN | (tx > sx ? LEFT : RIGHT), s.from);
      down(trackRow + 1, arrowRow, tx);
    }
    if (b.node && s.last) put(arrowRow, tx, '▼');
    else link(arrowRow, tx, UP | DOWN, s.from);
    // An edge through dummy rows offers each of its arrows as a place for the label.
    if (s.first) {
      labeled = s.label ? { text: s.label, stub: { row: gapTop, col: sx + 2 }, branches: [], from: s.from, to: s.target } : undefined;
      if (labeled) labels.push(labeled);
    }
    labeled?.branches.push({ row: arrowRow, col: tx });
    arrivals.set(`${arrowRow}:${tx}`, (arrivals.get(`${arrowRow}:${tx}`) ?? 0) + 1);
  }

  // Labels go after every line is drawn so the free-space check sees all of them. A node with
  // one outgoing edge labels its stub; with several, the stub is shared, so each label goes on
  // its own branch beside the arrow (right of it, else left).
  const fanOut = new Map<string, number>();
  for (const s of segs) if (s.first) fanOut.set(s.from, (fanOut.get(s.from) ?? 0) + 1);
  const blank = (r: number, c: number) => c < 0 || c >= width || (chars[r][c] === ' ' && !mask[r][c]);
  // The text cells must be blank, with one blank cell towards the label's own line and two on
  // the far side, so a label always sits closer to its own line than to any other.
  const free = (r: number, c: number, n: number, side: 'left' | 'right') => {
    const [before, after] = side === 'right' ? [1, 2] : [2, 1];
    return c >= 0 && c + n <= width && Array.from({ length: n + before + after }, (_, j) => blank(r, c - before + j)).every(Boolean);
  };
  // Each label is tried in full first (up to MAX_EDGE_LABEL), then shortened, at each spot.
  const unplaced: string[] = [];
  for (const l of labels) {
    const texts = [...new Set([truncate(l.text, MAX_EDGE_LABEL), truncate(l.text, 16)])];
    // An arrow several edges arrive at cannot say whose label sits beside it.
    const fanned = (fanOut.get(l.from) ?? 0) > 1;
    const anchors = fanned ? l.branches.filter((b) => arrivals.get(`${b.row}:${b.col}`) === 1) : [];
    const fit = texts
      .flatMap((text) => {
        const n = len(text);
        const spots = anchors.length
          ? anchors.flatMap((b) => [
              { row: b.row, col: b.col + 2, side: 'right' as const },
              { row: b.row, col: b.col - 1 - n, side: 'left' as const },
            ])
          : fanned
            ? []
            : [{ ...l.stub, side: 'right' as const }];
        return spots.map((p) => ({ ...p, text }));
      })
      .find((p) => free(p.row, p.col, len(p.text), p.side));
    // No unambiguous spot: list the edge under the diagram rather than guess.
    if (fit) [...fit.text].forEach((ch, j) => put(fit.row, fit.col + j, ch));
    else unplaced.push(`· ${name(l.from)} → ${name(l.to)}: ${l.text}`);
  }

  for (let r = 0; r < totalHeight; r++) {
    for (let c = 0; c < width; c++) {
      if (chars[r][c] !== ' ' || !mask[r][c]) continue;
      // One source passing straight through another's track is a crossing, not a junction:
      // the vertical is drawn unbroken so it does not read as a branch.
      const bits = [...(owners.get(r * width + c)?.values() ?? [])];
      const crossing = bits.includes(UP | DOWN) && bits.includes(LEFT | RIGHT);
      chars[r][c] = crossing ? '│' : (JOIN[mask[r][c]] ?? '┼');
    }
  }
  const lines = chars.map((row) => row.join('').replace(/\s+$/, ''));
  if (footer.length || unplaced.length) lines.push('', ...[...footer, ...unplaced].map((f) => truncate(f, width)));
  return { lines, highlights, boxes };
}

// Node and edge labels are model output, so terminal controls are stripped before layout
// (which also keeps the measured widths honest).
function cleanGraph(g: Graph): Graph {
  return {
    ...g,
    title: sanitizeTerminal(g.title),
    nodes: g.nodes.map((n) => ({ ...n, label: sanitizeTerminal(n.label) })),
    edges: g.edges.map((e) => (e.label === undefined ? e : { ...e, label: sanitizeTerminal(e.label) })),
  };
}

export function renderGraph(graph: Graph, maxWidth: number): TextDiagram {
  const g = cleanGraph(graph);
  const width = Math.max(8, maxWidth);
  if (g.kind === 'before-after') {
    const half = Math.floor((width - 3) / 2);
    const pick = (group: string) => {
      const nodes = g.nodes.filter((n) => (n.group ?? 'after') === group);
      const ids = new Set(nodes.map((n) => n.id));
      return layout({ ...g, nodes, edges: g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) }, half);
    };
    const before = pick('before');
    const after = pick('after');
    const height = Math.max(before.lines.length, after.lines.length);
    const lines = [`${'Before'.padEnd(half)} │ After`, `${'─'.repeat(half)}─┼─${'─'.repeat(half)}`];
    for (let i = 0; i < height; i++) {
      lines.push(`${(before.lines[i] ?? '').padEnd(half)} │ ${after.lines[i] ?? ''}`.replace(/\s+$/, ''));
    }
    const off = half + 3;
    return {
      lines,
      highlights: [...before.highlights.map((h) => ({ ...h, row: h.row + 2 })), ...after.highlights.map((h) => ({ row: h.row + 2, start: h.start + off, end: h.end + off }))],
      boxes: [...before.boxes.map((b) => ({ ...b, row: b.row + 2 })), ...after.boxes.map((b) => ({ ...b, row: b.row + 2, col: b.col + off }))],
    };
  }
  return layout(g, width);
}
