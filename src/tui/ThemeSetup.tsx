import { render, useApp, useInput, useWindowSize } from 'ink';
import { Box, ThemeContext, useThemePreview } from './themed.js';
import { loadPalette, terminalPalette, themeList, TERMINAL_THEME, type Palette, type ThemeInfo } from './theme.js';
import { ThemePicker } from './ThemePicker.js';

function ThemeSetup(props: { themes: ThemeInfo[]; current: string; initial: Palette; onDone: (name: string | undefined) => void }) {
  const { columns, rows } = useWindowSize();
  const { palette, preview } = useThemePreview(props.initial);
  const { exit } = useApp();
  // Ctrl+C leaves gr config, as it does at the other questions.
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      process.exitCode = 130;
      setImmediate(() => process.exit(130));
    }
  });
  return (
    <ThemeContext value={palette}>
      <Box flexDirection="column" width={columns} height={rows} backgroundColor={palette.bg} paddingX={1} paddingY={1}>
        <ThemePicker
          themes={props.themes}
          current={props.current}
          width={columns - 2}
          height={rows - 2}
          note="Change it later with L during a tour, or gr config."
          onPreview={preview}
          onDone={props.onDone}
        />
      </Box>
    </ThemeContext>
  );
}

// The full-screen theme step of gr config. Resolves to the chosen theme, or undefined when cancelled.
export async function pickTheme(current = TERMINAL_THEME): Promise<string | undefined> {
  const themes = await themeList();
  const known = themes.some((t) => t.id === current) ? current : TERMINAL_THEME;
  const initial = await loadPalette(known).catch(() => terminalPalette);
  let chosen: string | undefined;
  const app = render(
    <ThemeSetup
      themes={themes}
      current={known}
      initial={initial}
      onDone={(name) => {
        chosen = name;
        app.unmount();
      }}
    />,
    { alternateScreen: true, exitOnCtrlC: false },
  );
  await app.waitUntilExit();
  // Ink unrefs stdin when it exits; the questions after this one need it to keep gr running.
  process.stdin.ref();
  return chosen;
}
