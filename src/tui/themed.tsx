import { createContext, use, useRef, useState, type ComponentProps } from 'react';
import { Box as InkBox, Text as InkText, type TextProps } from 'ink';
import { loadPalette, resolveColor, terminalPalette, type Palette } from './theme.js';

// The interface's colors. Screens use Text and Box from here rather than from ink, so the
// ANSI color names they pass go through the theme.
export const ThemeContext = createContext<Palette>(terminalPalette);

export const useTheme = () => use(ThemeContext);

// Whether the palette is a theme the picker is previewing rather than the one in use: work done
// for it (highlighting) goes in a preview cache.
export const PreviewingContext = createContext(false);
export const usePreviewing = () => use(PreviewingContext);

// Whether a Text is inside another: only the outermost one sets the theme's default color,
// so a nested Text without a color keeps its parent's.
const InText = createContext(false);

// The background a Box paints or inherits. Ink draws borders without one, so a Box hands it
// to its border; otherwise a border shows the terminal's background through a theme's.
const Surface = createContext<string | undefined>(undefined);

// Whether a Text sits inside one shown in the theme's muted color in place of Ink's dim.
const InMuted = createContext(false);

export function Text(props: TextProps) {
  const palette = useTheme();
  const nested = use(InText);
  const inMuted = use(InMuted);
  // Dimmed text without its own color takes the theme's muted color instead of a faded foreground.
  const muted = props.dimColor && !props.color && palette.muted;
  const color = muted || (resolveColor(palette, props.color) ?? (nested ? undefined : palette.fg));
  // Ink dims nested text along with its parent. A muted parent is not dimmed, so text inside it
  // with its own color (syntax spans on an expanded line) dims itself to keep that look.
  const dimColor = muted ? false : props.dimColor || (inMuted && !!props.color);
  let node = <InkText {...props} dimColor={dimColor} color={color} backgroundColor={resolveColor(palette, props.backgroundColor)} />;
  // Providers only where a value changes: a diff pane holds thousands of nested spans.
  if (muted && !inMuted) node = <InMuted value={true}>{node}</InMuted>;
  return nested ? node : <InText value={true}>{node}</InText>;
}

export function Box(props: ComponentProps<typeof InkBox>) {
  const palette = useTheme();
  const inherited = use(Surface);
  const backgroundColor = resolveColor(palette, props.backgroundColor);
  const surface = backgroundColor ?? inherited ?? palette.bg;
  const borderColor = resolveColor(palette, props.borderColor) ?? (props.borderStyle ? palette.fg : undefined);
  const borderBackgroundColor = resolveColor(palette, props.borderBackgroundColor) ?? (props.borderStyle ? surface : undefined);
  const node = <InkBox {...props} borderColor={borderColor} borderBackgroundColor={borderBackgroundColor} backgroundColor={backgroundColor} />;
  return surface === inherited ? node : <Surface value={surface}>{node}</Surface>;
}

// How a selected row is marked: the theme's selection background, or inverted with the terminal's colors.
export function useSelected(): (on: boolean) => { inverse?: boolean; backgroundColor?: string } {
  const { selection } = useTheme();
  return (on) => (!on ? {} : selection ? { backgroundColor: selection } : { inverse: true });
}

// The palette while themes are previewed. `preview` loads one and shows it; a slower load of a
// theme moved past is dropped.
export function useThemePreview(initial: Palette): { palette: Palette; preview: (name: string) => void } {
  const [palette, setPalette] = useState(initial);
  const wanted = useRef('');
  return {
    palette,
    preview: (name) => {
      wanted.current = name;
      void loadPalette(name)
        .then((p) => wanted.current === name && setPalette(p))
        .catch(() => undefined);
    },
  };
}
