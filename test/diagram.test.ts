import { describe, expect, it } from 'vitest';
import { renderGraph } from '../src/diagram/text.js';
import { graphToSvg } from '../src/diagram/svg.js';
import { diagramColors, loadPalette, resolveColor, ROLES, terminalPalette } from '../src/tui/theme.js';
import { rowRoles } from '../src/tui/DiagramView.js';
import type { Graph } from '../src/types.js';

const g: Graph = {
  kind: 'call',
  title: 'POST /invoices',
  nodes: [
    { id: 'a', label: 'handleCreate', changed: true, hunkId: 'h1' },
    { id: 'b', label: 'createInvoice', changed: true },
    { id: 'c', label: 'computeTotal' },
    { id: 'd', label: 'saveInvoice', changed: true },
  ],
  edges: [
    { from: 'a', to: 'b', label: 'calls' },
    { from: 'b', to: 'c' },
    { from: 'b', to: 'd' },
    { from: 'a', to: 'd' },
  ],
};
const width = (s: string) => [...s].length;

describe('renderGraph', () => {
  it('draws boxes, arrows and highlights within the width', () => {
    const out = renderGraph(g, 60);
    const text = out.lines.join('\n');
    expect(text).toContain('handleCreate');
    expect(text).toContain('╔');
    expect(text).toContain('┌');
    expect(text).toContain('▼');
    expect(out.lines.every((l) => width(l) <= 60)).toBe(true);
    expect(out.boxes).toHaveLength(4);
    expect(out.highlights.length).toBeGreaterThan(0);
    const a = out.boxes.find((b) => b.nodeId === 'a')!;
    const b = out.boxes.find((x) => x.nodeId === 'b')!;
    expect(b.row).toBeGreaterThan(a.row);
  });

  it('never exceeds a narrow width and wraps wide layers', () => {
    const wide: Graph = {
      kind: 'deps',
      title: 'deps',
      nodes: [{ id: 'r', label: 'root' }, ...Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, label: `module-${i}-with-a-long-name` }))],
      edges: Array.from({ length: 8 }, (_, i) => ({ from: 'r', to: `n${i}` })),
    };
    for (const w of [20, 40, 80]) {
      const out = renderGraph(wide, w);
      expect(out.lines.every((l) => width(l) <= w)).toBe(true);
      expect(out.boxes).toHaveLength(9);
    }
  });

  it('survives cycles and multi-line labels', () => {
    const cyc: Graph = {
      kind: 'state',
      title: 's',
      nodes: [
        { id: 'x', label: 'draft' },
        { id: 'y', label: 'sent\n+retry' },
        { id: 'z', label: 'paid', changed: true },
      ],
      edges: [
        { from: 'x', to: 'y' },
        { from: 'y', to: 'z' },
        { from: 'z', to: 'x' },
      ],
    };
    const out = renderGraph(cyc, 50);
    expect(out.lines.join('\n')).toContain('+retry');
    expect(out.lines.join('\n')).toContain('↺ paid → draft');
  });

  it('renders before and after side by side', () => {
    const ba: Graph = {
      kind: 'before-after',
      title: 'ba',
      nodes: [
        { id: 'b1', label: 'retry()', group: 'before' },
        { id: 'a1', label: 'retry()', group: 'after' },
        { id: 'a2', label: 'backoff()', group: 'after', changed: true },
      ],
      edges: [{ from: 'a1', to: 'a2' }],
    };
    const out = renderGraph(ba, 60);
    expect(out.lines[0]).toMatch(/^Before\s+│ After/);
    expect(out.lines.every((l) => width(l) <= 60)).toBe(true);
    expect(out.boxes.find((b) => b.nodeId === 'a2')!.col).toBeGreaterThan(28);
  });

  it('labels each branch of a fan-out beside its own arrow', () => {
    const fan: Graph = {
      kind: 'call',
      title: 'fan',
      nodes: [
        { id: 'p', label: 'Page' },
        { id: 'a', label: 'Parse params' },
        { id: 'b', label: 'Table' },
      ],
      edges: [
        { from: 'p', to: 'a', label: 'parses' },
        { from: 'p', to: 'b', label: 'renders' },
      ],
    };
    const out = renderGraph(fan, 80);
    const row = out.lines.find((l) => l.includes('parses'))!;
    expect(row).toMatch(/▼ parses\s+▼ renders/);
  });

  it('keeps a single edge label on the stub below its source', () => {
    const out = renderGraph(
      {
        kind: 'call',
        title: 't',
        nodes: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        edges: [{ from: 'a', to: 'b', label: 'calls' }],
      },
      40,
    );
    expect(out.lines.find((l) => l.includes('calls'))).toMatch(/│ calls/);
  });

  it('gives each source its own run and draws crossings as an unbroken vertical', () => {
    // The page's long edge to the URL crosses the query's run into the table.
    const flow: Graph = {
      kind: 'call',
      title: 't',
      nodes: [
        { id: 'page', label: 'Page' },
        { id: 'query', label: 'Query cache' },
        { id: 'api', label: 'Payments API' },
        { id: 'table', label: 'Table' },
        { id: 'url', label: 'URL params' },
      ],
      edges: [
        { from: 'page', to: 'query' },
        { from: 'page', to: 'url' },
        { from: 'page', to: 'table' },
        { from: 'query', to: 'api' },
        { from: 'api', to: 'table' },
        { from: 'table', to: 'url' },
      ],
    };
    const lines = renderGraph(flow, 60).lines;
    expect(lines.some((l) => /─│─/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toContain('┼');
  });

  it('names nodes in full in the list of back edges', () => {
    const loop: Graph = {
      kind: 'call',
      title: 't',
      nodes: [
        { id: 'a', label: 'URL date params: startDate, endDate' },
        { id: 'b', label: 'Payment Events route' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a', label: 'parses' },
      ],
    };
    const lines = renderGraph(loop, 80).lines;
    expect(lines.some((l) => l.includes('startDate, endDate'))).toBe(true);
    expect(lines.at(-1)).toMatch(/^↺ /);
  });

  it('runs a long edge straight down past boxes of different widths', () => {
    // a reaches e four rows down; the boxes it passes have different widths.
    const deep: Graph = {
      kind: 'call',
      title: 't',
      nodes: [
        { id: 'a', label: 'Top' },
        { id: 'b', label: 'A fairly wide box here' },
        { id: 'c', label: 'Narrow' },
        { id: 'd', label: 'An even wider box than the first one' },
        { id: 'e', label: 'End' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'd' },
        { from: 'd', to: 'e' },
        { from: 'a', to: 'e' },
      ],
    };
    const lines = renderGraph(deep, 80).lines;
    // The long edge is the last vertical on each row it passes beside a box.
    const lane = (text: string) => {
      const l = lines.find((x) => x.includes(text))!;
      return l.lastIndexOf('│');
    };
    const cols = new Set(['A fairly wide', 'Narrow', 'An even wider'].map(lane));
    expect(cols.size).toBe(1);
  });

  it('gives each edge into a box its own arrowhead', () => {
    const fanIn: Graph = {
      kind: 'call',
      title: 't',
      nodes: [
        { id: 'a', label: 'Page' },
        { id: 'b', label: 'Table' },
        { id: 'u', label: 'URL date params' },
      ],
      edges: [
        { from: 'a', to: 'b', label: 'renders' },
        { from: 'a', to: 'u', label: 'parses' },
        { from: 'b', to: 'u', label: 'writes' },
      ],
    };
    const lines = renderGraph(fanIn, 60).lines;
    const above = lines[lines.findIndex((l) => l.includes('URL date params')) - 2];
    expect([...above.matchAll(/▼/g)]).toHaveLength(2);
  });

  it('lists a label it cannot place beside its own line under the diagram', () => {
    // Two edges from one source arrive in boxes packed too tightly for either label.
    const tight: Graph = {
      kind: 'call',
      title: 't',
      nodes: [
        { id: 's', label: 'Source' },
        { id: 'x', label: 'X' },
        { id: 'y', label: 'Y' },
      ],
      edges: [
        { from: 's', to: 'x', label: 'a rather long label' },
        { from: 's', to: 'y', label: 'another long label' },
      ],
    };
    const lines = renderGraph(tight, 30).lines;
    // Listed (cut to the width) and not also drawn beside an arrow.
    expect(lines.filter((l) => l.startsWith('· Source → X: a rather'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('a rather'))).toHaveLength(1);
  });

  it('breaks long dotted identifiers instead of cutting them off', () => {
    const out = renderGraph({ kind: 'call', title: 't', nodes: [{ id: 'a', label: 'FacilityDetailedOffer.latestAgreementId: string' }], edges: [] }, 60);
    const text = out.lines.join('\n');
    expect(text).toContain('FacilityDetailedOffer.');
    expect(text).toContain('latestAgreementId: string');
    expect(text).not.toContain('…');
  });
});

describe('graphToSvg', () => {
  it('produces an svg with highlighted nodes and escaped labels', () => {
    const svg = graphToSvg({ ...g, nodes: [...g.nodes, { id: 'e', label: 'List<T> & co' }] });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('class="node changed"');
    expect(svg).toContain('List&lt;T&gt; &amp; co');
    expect(svg).toContain('data-hunk="h1"');
  });
});

describe('themed diagrams', () => {
  it('gives each character a role: box frame, box text, or arrow, under changed and selected spans', () => {
    const d = renderGraph(g, 80);
    const box = d.boxes[0];
    const roles = rowRoles(d.lines[box.row + 1], box.row + 1, d.boxes, []);
    expect(roles[box.col]).toBe('border');
    expect(roles.slice(box.col + 1, box.col + box.width - 1)).toContain('label');
    const arrowRow = d.lines.findIndex((l, row) => !d.boxes.some((b) => row >= b.row && row < b.row + b.height) && l.trim());
    expect(
      rowRoles(d.lines[arrowRow], arrowRow, d.boxes, [])
        .filter(Boolean)
        .every((r) => r === 'line'),
    ).toBe(true);
    const changed = rowRoles(d.lines[box.row + 1], box.row + 1, d.boxes, [{ start: box.col, end: box.col + box.width, kind: 'changed' }]);
    expect(changed[box.col]).toBe('changedBorder'); // the frame of a changed box takes the theme's color, not yellow
    expect(changed.slice(box.col + 1, box.col + box.width - 1)).toContain('changedLabel');
    const selected = rowRoles(d.lines[box.row], box.row, d.boxes, [{ start: box.col, end: box.col + box.width, kind: 'selected' }]);
    expect(selected.slice(box.col, box.col + box.width).every((r) => r === 'selected')).toBe(true);
  });

  it('draws changed boxes in the theme heading and title colors, and yellow with the terminal colors', async () => {
    const palette = await loadPalette('github-light');
    expect(resolveColor(palette, ROLES.changedBox)).toBe(palette.heading);
    expect(resolveColor(palette, ROLES.changedText)).toBe(palette.title);
    expect(resolveColor(terminalPalette, ROLES.changedBox)).toBe('yellow');
    expect(resolveColor(terminalPalette, ROLES.changedText)).toBe('yellow');
    expect(resolveColor(terminalPalette, ROLES.line)).toBeUndefined();
  });

  it('colors the SVG with the theme, or follows the browser with the terminal colors', async () => {
    expect(diagramColors(terminalPalette)).toBeUndefined();
    expect(graphToSvg(g)).toContain('prefers-color-scheme: dark');
    const palette = await loadPalette('github-light');
    const svg = graphToSvg(g, diagramColors(palette));
    expect(svg).not.toContain('prefers-color-scheme');
    expect(svg).toContain(`--fg: ${palette.fg};`);
    expect(svg).toContain(`--hl-line: ${palette.heading};`);
  });
});
