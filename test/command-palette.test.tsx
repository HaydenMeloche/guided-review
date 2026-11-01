import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { CommandPalette, filterPalette, type PaletteItem } from '../src/tui/CommandPalette.js';
import { paletteCommands, type KeyCtx } from '../src/tui/chapter/keys.js';
import { waitFor } from './helpers/waitFor.js';

const item = (label: string, key?: string, detail?: string): PaletteItem => ({ label, key, detail, run: vi.fn() });

describe('the command palette', () => {
  it('keeps the items every word matches, those starting with the query first', () => {
    const items = [item('Hide or show whitespace-only changes', 'w'), item('Toggle between split and inline view', 'S'), item('Go to src/split.ts', undefined, 'chapter 2 · hunk 1')];
    expect(filterPalette(items, 'spl').map((i) => i.label)).toEqual(['Toggle between split and inline view', 'Go to src/split.ts']);
    expect(filterPalette(items, 'go split').map((i) => i.label)).toEqual(['Go to src/split.ts']);
    expect(filterPalette(items, '')).toHaveLength(3);
  });

  it('filters as you type and runs the chosen command on Enter', async () => {
    const items = [item('Next chapter', 'N'), item('Toggle between split and inline view', 'S')];
    const onClose = vi.fn();
    const ui = render(<CommandPalette items={items} width={70} height={10} onClose={onClose} />);
    await waitFor(() => expect(ui.lastFrame()).toContain('Next chapter'));
    ui.stdin.write('split');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('Next chapter'));
    ui.stdin.write('\r');
    await waitFor(() => expect(items[1].run).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    ui.unmount();
  });

  it('lists the chapter screen’s commands that apply now, settings included', () => {
    const ctx = {
      hunk: true,
      chapter: true,
      agent: true,
      selecting: false,
      threads: false,
      reply: true,
      draft: false,
      tests: true,
      diagram: true,
      done: false,
      split: false,
      rereview: false,
      deltaOnly: false,
      rebase: false,
    } satisfies KeyCtx;
    const labels = paletteCommands('code', ctx).map((c) => `${c.key} ${c.label}`);
    expect(labels).toContain('S Toggle between split and inline view');
    expect(labels).toContain('N Next chapter');
    expect(labels.some((l) => l.includes('Rebuild'))).toBe(false); // no new head to rebuild on
  });
});
