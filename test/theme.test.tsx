import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { contrast, loadPalette, resolveColor, ROLES, SURFACES, TERMINAL_THEME, terminalPalette, themeList } from '../src/tui/theme.js';
import { Box, Text, ThemeContext, useSelected } from '../src/tui/themed.js';
import { matchesTheme, ThemePicker } from '../src/tui/ThemePicker.js';
import { waitFor } from './helpers/waitFor.js';

// Test frames carry no color codes, so the colors handed to ink are recorded instead.
const seen = vi.hoisted(() => ({
  text: [] as { color?: string; backgroundColor?: string; dimColor?: boolean; children?: unknown }[],
  box: [] as { borderStyle?: unknown; borderBackgroundColor?: string }[],
}));
vi.mock('ink', async (importOriginal) => {
  const real = await importOriginal<typeof import('ink')>();
  const Text = (props: React.ComponentProps<typeof real.Text>) => {
    seen.text.push(props);
    return real.Text(props);
  };
  const Box = (props: React.ComponentProps<typeof real.Box>) => {
    seen.box.push(props);
    return <real.Box {...props} />;
  };
  return { ...real, Text, Box };
});

describe('themes', () => {
  it('lists the terminal colors first, then every shiki theme, dark before light', async () => {
    const themes = await themeList();
    expect(themes[0].id).toBe(TERMINAL_THEME);
    expect(themes).toHaveLength(66);
    const firstLight = themes.findIndex((t) => t.type === 'light');
    expect(themes.slice(firstLight).every((t) => t.type === 'light')).toBe(true);
  });

  it('keeps the terminal palette on the ANSI names, so the default look is unchanged', () => {
    expect(terminalPalette.fg).toBeUndefined();
    expect(terminalPalette.bg).toBeUndefined();
    expect(resolveColor(terminalPalette, 'cyan')).toBe('cyan');
    expect(resolveColor(terminalPalette, SURFACES.lineAdd)).toBe('#173B2A');
    expect(resolveColor(terminalPalette, '#123456')).toBe('#123456');
    expect(resolveColor(terminalPalette, ROLES.heading)).toBe('blue');
    expect(resolveColor(terminalPalette, ROLES.title)).toBeUndefined();
  });

  it('derives readable text and accents from every shiki theme', async () => {
    for (const { id } of (await themeList()).slice(1)) {
      const p = await loadPalette(id);
      expect(p.syntax).toBe(id);
      expect(contrast(p.fg!, p.bg!), `${id} text`).toBeGreaterThanOrEqual(4.5);
      for (const name of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const) {
        expect(contrast(p.ansi[name], p.bg!), `${id} ${name}`).toBeGreaterThanOrEqual(3);
      }
      expect(p.popup).not.toBe(p.bg);
      expect(contrast(p.heading!, p.bg!), `${id} heading`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.title!, p.bg!), `${id} title`).toBeGreaterThanOrEqual(4.5);
      if (p.selection) expect(contrast(p.fg!, p.selection), `${id} selection`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('rejects an unknown theme name', async () => {
    await expect(loadPalette('no-such-theme')).rejects.toThrow(/unknown theme/);
  });
});

describe('themed components', () => {
  it('maps color names through the palette and gives top-level text the theme foreground', async () => {
    const palette = await loadPalette('github-light');
    seen.text.length = 0;
    const ui = render(
      <ThemeContext value={palette}>
        <Box flexDirection="column" backgroundColor={palette.bg}>
          <Text>
            plain <Text color="red">red</Text> <Text>inherits</Text>
          </Text>
          <Text backgroundColor={SURFACES.lineAdd}>added</Text>
        </Box>
      </ThemeContext>,
    );
    expect(ui.lastFrame()).toContain('plain red inherits');
    const colorOf = (text: string) => seen.text.find((p) => [p.children].flat().includes(text));
    expect(colorOf('red')?.color).toBe(palette.ansi.red);
    expect(colorOf('inherits')?.color).toBeUndefined(); // nested: keeps its parent's color
    expect(seen.text.find((p) => [p.children].flat().includes('plain '))?.color).toBe(palette.fg);
    expect(colorOf('added')?.backgroundColor).toBe(palette.diffLine.add);
    ui.unmount();
  });
});

describe('themed boxes and dim text', () => {
  it('gives a border the background behind it and dimmed text the theme muted color', async () => {
    const palette = await loadPalette('github-light');
    seen.text.length = 0;
    seen.box.length = 0;
    const ui = render(
      <ThemeContext value={palette}>
        <Box flexDirection="column" backgroundColor={palette.bg}>
          <Box borderStyle="round">
            <Text dimColor>quiet</Text>
          </Box>
          <Box backgroundColor={SURFACES.popup}>
            <Box borderStyle="single">
              <Text>in a popup</Text>
            </Box>
          </Box>
        </Box>
      </ThemeContext>,
    );
    const bordered = seen.box.filter((p) => p.borderStyle);
    expect(bordered[0].borderBackgroundColor).toBe(palette.bg);
    expect(bordered[1].borderBackgroundColor).toBe(palette.popup);
    const quiet = seen.text.find((p) => [p.children].flat().includes('quiet'));
    expect(quiet?.color).toBe(palette.muted);
    expect(quiet?.dimColor).toBe(false);
    ui.unmount();
  });

  it('keeps colored text inside dimmed text dimmed, as Ink would', async () => {
    // An expanded context line: a dimmed row holding syntax-colored spans.
    const palette = await loadPalette('nord');
    seen.text.length = 0;
    const ui = render(
      <ThemeContext value={palette}>
        <Text dimColor>
          <Text color="#ff0000">token</Text> <Text>plain</Text>
        </Text>
      </ThemeContext>,
    );
    const props = (text: string) => seen.text.find((p) => [p.children].flat().includes(text));
    expect(props('token')?.dimColor).toBe(true);
    expect(props('plain')?.dimColor).toBeFalsy(); // takes the muted color from its parent
    ui.unmount();
  });

  it('leaves borders and dim text alone with the terminal colors', () => {
    seen.box.length = 0;
    seen.text.length = 0;
    const ui = render(
      <Box borderStyle="round">
        <Text dimColor>quiet</Text>
      </Box>,
    );
    expect(seen.box.find((p) => p.borderStyle)?.borderBackgroundColor).toBeUndefined();
    expect(seen.text.find((p) => [p.children].flat().includes('quiet'))?.dimColor).toBe(true);
    ui.unmount();
  });

  it('marks a selected row with the theme selection color, or inverts it with the terminal colors', async () => {
    const palette = await loadPalette('github-light');
    let themed: ReturnType<ReturnType<typeof useSelected>> = {};
    let plain: ReturnType<ReturnType<typeof useSelected>> = {};
    function Probe(props: { out: (v: typeof themed) => void }) {
      props.out(useSelected()(true));
      return null;
    }
    render(
      <ThemeContext value={palette}>
        <Probe out={(v) => (themed = v)} />
      </ThemeContext>,
    ).unmount();
    render(<Probe out={(v) => (plain = v)} />).unmount();
    expect(themed).toEqual({ backgroundColor: palette.selection });
    expect(plain).toEqual({ inverse: true });
  });

  it('takes headings and titles from the theme heading and function colors', async () => {
    const palette = await loadPalette('github-light');
    expect(palette.heading).toBe('#005cc5');
    expect(palette.title).toBe('#6f42c1');
  });

  it('takes accents from the theme code colors when one is near the hue', async () => {
    // GitHub Light's code red and purple, rather than its terminal red and magenta.
    const palette = await loadPalette('github-light');
    expect(palette.ansi.red).toBe('#d73a49');
    expect(palette.muted).toBe('#6a737d'); // its comment color
  });
});

describe('theme picker', () => {
  const themes = [
    { id: 'terminal', displayName: 'Terminal colors', type: 'dark' as const },
    { id: 'nord', displayName: 'Nord', type: 'dark' as const },
    { id: 'github-light', displayName: 'GitHub Light', type: 'light' as const },
  ];

  it('previews each theme as the cursor moves and reports the choice', async () => {
    const onPreview = vi.fn();
    const onDone = vi.fn();
    const ui = render(<ThemePicker themes={themes} current="nord" width={100} height={24} onPreview={onPreview} onDone={onDone} />);
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith('nord'));
    expect(ui.lastFrame()).toContain('Color theme');
    expect(ui.lastFrame()).toContain('acme/api'); // the sample screen
    ui.stdin.write('j');
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith('github-light'));
    ui.stdin.write('\r');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('github-light'));
    ui.unmount();
  });

  it('previews only the theme the cursor rests on', async () => {
    const onPreview = vi.fn();
    const ui = render(<ThemePicker themes={themes} current="terminal" width={60} height={12} onPreview={onPreview} onDone={() => undefined} />);
    ui.stdin.write('j');
    ui.stdin.write('\u001B[B'); // arrows move too
    await waitFor(() => expect(onPreview).toHaveBeenCalledWith('github-light'));
    expect(onPreview).toHaveBeenCalledTimes(1);
    ui.unmount();
  });

  it('searches by name after /, and Esc stops searching before it cancels', async () => {
    const onPreview = vi.fn();
    const onDone = vi.fn();
    const ui = render(<ThemePicker themes={themes} current="terminal" width={60} height={12} onPreview={onPreview} onDone={onDone} />);
    ui.stdin.write('/');
    await waitFor(() => expect(ui.lastFrame()).toContain('stop searching'));
    ui.stdin.write('git');
    await waitFor(() => expect(ui.lastFrame()).toContain('/ git'));
    expect(ui.lastFrame()).toContain('GitHub Light');
    expect(ui.lastFrame()).not.toContain('Nord');
    await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith('github-light')); // the first match takes the cursor
    ui.stdin.write('zzz');
    await waitFor(() => expect(ui.lastFrame()).toContain('No theme matches.'));
    ui.stdin.write('\u007f');
    ui.stdin.write('\u007f');
    ui.stdin.write('\u007f');
    await waitFor(() => expect(ui.lastFrame()).toContain('GitHub Light'));
    ui.stdin.write('\u001b');
    await waitFor(() => expect(ui.lastFrame()).toContain('Nord'));
    expect(ui.lastFrame()).toContain('/ to search');
    expect(onDone).not.toHaveBeenCalled();
    ui.stdin.write('\r'); // the cursor stayed on the match it moved to
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('github-light'));
    ui.unmount();
  });

  it('matches every word of the query against the name, id, and type', () => {
    const light = { id: 'github-light', displayName: 'GitHub Light', type: 'light' as const };
    expect(matchesTheme(light, 'GIT light')).toBe(true);
    expect(matchesTheme(light, 'light')).toBe(true);
    expect(matchesTheme(light, 'git dark')).toBe(false);
    expect(matchesTheme(light, '')).toBe(true);
  });

  it('reports a cancel on escape', async () => {
    const onDone = vi.fn();
    const ui = render(<ThemePicker themes={themes} current="terminal" width={60} height={12} onPreview={() => undefined} onDone={onDone} />);
    await new Promise((r) => setTimeout(r, 20));
    ui.stdin.write('\u001b');
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(undefined));
    ui.unmount();
  });
});
