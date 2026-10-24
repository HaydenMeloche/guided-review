import type { ThemeRegistrationAny } from 'shiki';
import type { SvgColors } from '../diagram/svg.js';

// The colors a theme gives the interface. The named slots are the ANSI names the screens
// use (`color="cyan"`); a theme remaps them the way a terminal color scheme would.
export interface Palette {
  name: string;
  type: 'dark' | 'light';
  fg?: string; // default text; unset leaves the terminal's own
  muted?: string; // dimmed text, from the theme's comment color; unset falls back to the terminal's dim
  heading?: string; // section headings, from the theme's heading or keyword color
  title?: string; // PR and chapter titles, from the theme's function-name color
  selection?: string; // behind a selected row; unset, selected rows are inverted
  range?: string; // behind the rows of a range selection, a lighter shade of `selection`
  bg?: string; // painted behind the whole screen; unset leaves the terminal's own
  ansi: Record<AnsiName, string>;
  popup: string; // behind popups
  diffLine: { add: string; del: string }; // behind added and removed lines
  diffWord: { add: string; del: string }; // behind the words a changed line changed
  syntax: string; // the shiki theme for code
}

export const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray'] as const;
export type AnsiName = (typeof ANSI_NAMES)[number];

// The default: the terminal's own colors, with rose-pine-moon for code.
export const TERMINAL_THEME = 'terminal';

export const terminalPalette: Palette = {
  name: TERMINAL_THEME,
  type: 'dark',
  ansi: Object.fromEntries(ANSI_NAMES.map((n) => [n, n])) as Record<AnsiName, string>,
  popup: '#1E1E2E',
  diffLine: { add: '#173B2A', del: '#42262C' },
  diffWord: { add: '#2B6B47', del: '#7A3442' },
  syntax: 'rose-pine-moon',
};

export interface ThemeInfo {
  id: string;
  displayName: string;
  type: 'dark' | 'light';
}

// Every theme: the terminal default first, then shiki's, dark before light.
export async function themeList(): Promise<ThemeInfo[]> {
  const { bundledThemesInfo } = await import('shiki/themes');
  const shiki = bundledThemesInfo.map(({ id, displayName, type }) => ({ id, displayName, type }));
  return [{ id: TERMINAL_THEME, displayName: 'Terminal colors', type: 'dark' }, ...shiki.filter((t) => t.type === 'dark'), ...shiki.filter((t) => t.type === 'light')];
}

export async function isTheme(name: string): Promise<boolean> {
  return (await themeList()).some((t) => t.id === name);
}

const cache = new Map<string, Promise<Palette>>();

// The palette for a theme name; unknown names reject.
export function loadPalette(name: string): Promise<Palette> {
  if (name === TERMINAL_THEME) return Promise.resolve(terminalPalette);
  let p = cache.get(name);
  if (!p) {
    p = import('shiki/themes').then(async ({ bundledThemes }) => {
      if (!Object.hasOwn(bundledThemes, name)) throw new Error(`unknown theme ${JSON.stringify(name)}`);
      const theme = (await bundledThemes[name as keyof typeof bundledThemes]()).default;
      return paletteFrom(name, theme);
    });
    p.catch(() => cache.delete(name));
    cache.set(name, p);
  }
  return p;
}

// ---------- deriving a palette from a VS Code theme ----------

type RGB = [number, number, number];

function parseHex(color: string | undefined): { rgb: RGB; alpha: number } | undefined {
  const m = color?.trim().match(/^#([0-9a-f]{3,8})$/i);
  if (!m) return undefined;
  let hex = m[1];
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('');
  if (hex.length !== 6 && hex.length !== 8) return undefined;
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return { rgb: [n(0), n(2), n(4)], alpha: hex.length === 8 ? n(6) / 255 : 1 };
}

const toHex = (rgb: RGB) =>
  '#' +
  rgb
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

// `amount` of `b` over `a`.
export function mix(a: string, b: string, amount: number): string {
  const x = parseHex(a)!.rgb;
  const y = parseHex(b)!.rgb;
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * amount) as RGB);
}

// A theme color made opaque over `bg`; undefined when unset or not a hex color.
function solid(color: string | undefined, bg: string): string | undefined {
  const c = parseHex(color);
  if (!c) return undefined;
  return c.alpha >= 1 ? toHex(c.rgb) : mix(bg, toHex(c.rgb), c.alpha);
}

function luminance(color: string): number {
  const [r, g, b] = parseHex(color)!.rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Moves `color` toward `fg` until it reads against `bg`.
function readable(color: string, fg: string, bg: string, min: number): string {
  for (let step = 0; step <= 10; step++) {
    const c = step ? mix(color, fg, step / 10) : color;
    if (contrast(c, bg) >= min) return c;
  }
  return fg;
}

// VS Code's own terminal colors, for themes that set none.
const FALLBACK_ANSI: Record<'dark' | 'light', Record<'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan', string>> = {
  dark: { red: '#f14c4c', green: '#23d18b', yellow: '#f5f543', blue: '#3b8eea', magenta: '#d670d6', cyan: '#29b8db' },
  light: { red: '#cd3131', green: '#00bc00', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc' },
};

const ACCENT_CONTRAST = 3;

// Where each accent sits on the color wheel, to find the theme's own shade of it among its code colors.
const ACCENT_HUE: Record<keyof (typeof FALLBACK_ANSI)['dark'], number> = { red: 355, yellow: 45, green: 125, cyan: 185, blue: 215, magenta: 295 };
const HUE_TOLERANCE = 25;

// Hue in degrees and saturation (0-1) in HSL terms.
function hueSat(color: string): { hue: number; sat: number } {
  const [r, g, b] = parseHex(color)!.rgb.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (!d) return { hue: 0, sat: 0 };
  const l = (max + min) / 2;
  const sat = d / (1 - Math.abs(2 * l - 1));
  const hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { hue: (hue * 60 + 360) % 360, sat };
}

// The theme's color for the first of `scopes` it styles. A theme selector applies to a scope it
// equals or prefixes (`entity.name` styles `entity.name.function`); the most specific one wins.
function tokenColor(settings: TokenSetting[], scopes: string[]): string | undefined {
  for (const scope of scopes) {
    let best: { color: string; length: number } | undefined;
    for (const t of settings) {
      const color = t.settings?.foreground;
      if (!color) continue;
      for (const selector of scopesOf(t)) {
        const last = selector.split(' ').at(-1)!;
        if ((scope === last || scope.startsWith(last + '.')) && last.length > (best?.length ?? -1)) best = { color, length: last.length };
      }
    }
    if (best) return best.color;
  }
  return undefined;
}

// Scopes for errors, diffs, and markup rather than code; their colors don't speak for the theme.
const NOT_CODE = /^(invalid|message|markup|meta\.diff|brackethighlighter|punctuation\.definition\.(deleted|inserted|changed)|carriage-return|token\.)/;

const hueDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

type TokenSetting = { scope?: string | string[]; settings?: { foreground?: string } };
const scopesOf = (t: TokenSetting) => (Array.isArray(t.scope) ? t.scope : typeof t.scope === 'string' ? t.scope.split(',').map((x) => x.trim()) : []);

export function paletteFrom(name: string, theme: ThemeRegistrationAny): Palette {
  const colors = (theme.colors ?? {}) as Record<string, string | undefined>;
  const type = theme.type === 'light' ? 'light' : 'dark';
  const bg = solid(colors['editor.background'], type === 'light' ? '#ffffff' : '#000000') ?? (type === 'light' ? '#ffffff' : '#1e1e1e');
  const settings = Array.isArray(theme.tokenColors) ? theme.tokenColors : Array.isArray(theme.settings) ? theme.settings : [];
  const tokenFg = settings.find((s) => !s.scope && s.settings?.foreground)?.settings.foreground;
  const fg = readable(solid(colors['editor.foreground'] ?? tokenFg ?? colors.foreground, bg) ?? (type === 'light' ? '#333333' : '#d4d4d4'), type === 'light' ? '#000000' : '#ffffff', bg, 4.5);

  // The theme's code colors give the interface its character: an accent takes the theme's most
  // used code color near its hue, so a risk mark stays red but in the theme's red. Without one
  // near enough, it takes the theme's terminal color.
  const uses = new Map<string, number>();
  for (const t of settings as TokenSetting[]) {
    const c = solid(t.settings?.foreground, bg);
    const code = scopesOf(t).filter((sc) => !NOT_CODE.test(sc)).length;
    if (c && code) uses.set(c, (uses.get(c) ?? 0) + code);
  }
  const accent = (key: keyof (typeof FALLBACK_ANSI)['dark']) => {
    const fromCode = [...uses]
      .map(([c, n]) => ({ c, n, ...hueSat(c) }))
      .filter((t) => t.sat >= 0.3 && hueDistance(t.hue, ACCENT_HUE[key]) <= HUE_TOLERANCE && contrast(t.c, bg) >= ACCENT_CONTRAST)
      .sort((a, b) => b.n - a.n)[0]?.c;
    if (fromCode) return fromCode;
    const cap = key[0].toUpperCase() + key.slice(1);
    // Bright variants read better on dark backgrounds, plain ones on light.
    const order = type === 'dark' ? [`terminal.ansiBright${cap}`, `terminal.ansi${cap}`] : [`terminal.ansi${cap}`, `terminal.ansiBright${cap}`];
    const candidates = order.map((k) => solid(colors[k], bg)).filter((c): c is string => !!c);
    const best = candidates.find((c) => contrast(c, bg) >= ACCENT_CONTRAST) ?? candidates[0] ?? FALLBACK_ANSI[type][key];
    return readable(best, fg, bg, ACCENT_CONTRAST);
  };
  const comment = (settings as TokenSetting[]).find((t) => t.settings?.foreground && scopesOf(t).some((sc) => sc === 'comment' || sc.startsWith('comment.')))?.settings?.foreground;
  const muted = readable(solid(comment, bg) ?? mix(bg, fg, 0.55), fg, bg, ACCENT_CONTRAST);
  const yellow = accent('yellow');
  const ansi: Record<AnsiName, string> = {
    // The screens use black only as text on a yellow highlight.
    black: contrast(bg, yellow) >= contrast(fg, yellow) ? bg : fg,
    red: accent('red'),
    green: accent('green'),
    yellow,
    blue: accent('blue'),
    magenta: accent('magenta'),
    cyan: accent('cyan'),
    white: fg,
    gray: muted,
  };
  const selection = selectionOver(solid(colors['editor.selectionBackground'] ?? colors['list.activeSelectionBackground'], bg), fg, bg, ansi.cyan);
  const heading = readable(solid(tokenColor(settings, ['markup.heading', 'keyword', 'storage']), bg) ?? ansi.blue, fg, bg, 4.5);
  const title = readable(solid(tokenColor(settings, ['entity.name.function', 'support.function', 'entity.name']), bg) ?? ansi.cyan, fg, bg, 4.5);
  return {
    name,
    type,
    fg,
    muted,
    heading,
    title,
    selection,
    range: selection ? mix(bg, selection, 0.5) : undefined,
    bg,
    ansi,
    popup: popupOver(solid(colors['editorWidget.background'], bg), fg, bg),
    diffLine: { add: mix(bg, ansi.green, 0.16), del: mix(bg, ansi.red, 0.16) },
    diffWord: { add: mix(bg, ansi.green, 0.36), del: mix(bg, ansi.red, 0.36) },
    syntax: name,
  };
}

// A selected row's background: the theme's selection color, kept apart from the background and
// light (or dark) enough for text to read on it. Undefined when no shade does both; the row is
// then inverted.
function selectionOver(selection: string | undefined, fg: string, bg: string, accent: string): string | undefined {
  const base = selection && contrast(selection, bg) >= 1.15 ? selection : mix(bg, accent, 0.3);
  for (let step = 0; step < 10; step++) {
    const c = mix(base, bg, step / 10);
    if (contrast(fg, c) >= 4.5) return contrast(c, bg) >= 1.1 ? c : undefined;
  }
  return undefined;
}

// A popup background that stands apart from the screen behind it.
function popupOver(widget: string | undefined, fg: string, bg: string): string {
  return widget && contrast(widget, bg) >= 1.08 ? widget : mix(bg, fg, 0.08);
}

// Names for the palette's backgrounds, usable wherever a color is.
export const SURFACES = {
  selection: 'surface:selection',
  range: 'surface:range',
  popup: 'surface:popup',
  lineAdd: 'surface:line-add',
  lineDel: 'surface:line-del',
  wordAdd: 'surface:word-add',
  wordDel: 'surface:word-del',
} as const;

// Text roles: a heading is blue with the terminal's colors; the rest are plain text there.
// `line` is a diagram's arrows and unchanged boxes; `changedBox` and `changedText` are the frame
// and text of a box the PR changes, yellow with the terminal's colors.
export const ROLES = { heading: 'role:heading', title: 'role:title', line: 'role:line', changedBox: 'role:changed-box', changedText: 'role:changed-text' } as const;

// A screen color through the palette: ANSI and surface names are remapped, anything else passes through.
export function resolveColor(palette: Palette, color: string | undefined): string | undefined {
  if (!color) return color;
  if (Object.hasOwn(palette.ansi, color)) return palette.ansi[color as AnsiName];
  switch (color) {
    case SURFACES.popup:
      return palette.popup;
    case SURFACES.selection:
      return palette.selection;
    case SURFACES.range:
      return palette.range;
    case ROLES.heading:
      return palette.heading ?? palette.ansi.blue;
    case ROLES.title:
      return palette.title;
    case ROLES.line:
      return palette.muted;
    case ROLES.changedBox:
      return palette.heading ?? palette.ansi.yellow;
    case ROLES.changedText:
      return palette.title ?? palette.ansi.yellow;
    case SURFACES.lineAdd:
      return palette.diffLine.add;
    case SURFACES.lineDel:
      return palette.diffLine.del;
    case SURFACES.wordAdd:
      return palette.diffWord.add;
    case SURFACES.wordDel:
      return palette.diffWord.del;
  }
  return color;
}

// The colors of a diagram opened in the browser; undefined with the terminal's colors, where it
// follows the browser's light or dark setting instead.
export function diagramColors(palette: Palette): SvgColors | undefined {
  if (!palette.bg || !palette.fg || !palette.muted) return undefined;
  return {
    scheme: palette.type,
    bg: palette.bg,
    fg: palette.fg,
    muted: palette.muted,
    line: palette.muted,
    box: palette.popup,
    hl: mix(palette.bg, palette.heading ?? palette.ansi.yellow, 0.14),
    hlLine: palette.heading ?? palette.ansi.yellow,
  };
}
