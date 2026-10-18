import { Text } from './themed.js';
import { ROLES } from './theme.js';
import { lexer, type Token, type Tokens } from 'marked';
import { sanitizeTerminal } from '../util/sanitize.js';
import { BEL, OSC } from './terminalStatus.js';

// Markdown rendered as styled terminal lines. It returns lines (not one string) because
// the screens size their sections by counting rows.
//
// The input is untrusted (PR bodies, review comments, model output), so every span that
// leaves renderMarkdown or wrapSpans has had terminal control characters stripped, and
// MdLineView strips them again for lines built elsewhere.

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  dim?: boolean;
  color?: string;
  href?: string; // emitted as an OSC 8 hyperlink: cmd/ctrl-click opens it in the browser
}

export type MdLine = Span[];

type Style = Omit<Span, 'text'>;

const CODE_COLOR = 'cyan';
const HEADING_COLOR = ROLES.heading; // blue with the terminal's colors
const ALERT_COLOR: Record<string, string> = { NOTE: 'blue', TIP: 'green', IMPORTANT: 'magenta', WARNING: 'yellow', CAUTION: 'red' };

// ---------- inline ----------

function inlineSpans(tokens: Token[] | undefined, style: Style = {}): Span[] {
  const out: Span[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong':
        out.push(...inlineSpans((t as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...inlineSpans((t as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case 'del':
        out.push(...inlineSpans((t as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case 'codespan':
        out.push({ ...style, text: decode((t as Tokens.Codespan).text), color: CODE_COLOR });
        break;
      case 'link': {
        const l = t as Tokens.Link;
        const label = inlineSpans(l.tokens, { ...style, underline: true });
        out.push(...label);
        const text = label.map((s) => s.text).join('');
        if (l.href && l.href !== text && !l.href.startsWith('#')) out.push({ ...style, text: ` (${shortUrl(l.href)})`, dim: true });
        break;
      }
      case 'image': {
        const img = t as Tokens.Image;
        out.push(imageSpan(img.href, decode(img.text), style));
        break;
      }
      case 'br':
        out.push({ text: '\n' });
        break;
      case 'html': {
        // Inline tags carry no text worth keeping, except GitHub's <img> screenshots.
        for (const m of (t as Tokens.HTML).text.matchAll(/<img\b[^>]*>/gi)) {
          const src = htmlAttr(m[0], 'src');
          if (src) out.push(imageSpan(src, htmlAttr(m[0], 'alt') ?? '', style));
        }
        break;
      }
      case 'escape':
        out.push({ ...style, text: (t as Tokens.Escape).text });
        break;
      case 'checkbox':
        break; // the list item draws ☑ / ☐
      case 'text': {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length) out.push(...inlineSpans(tt.tokens, style));
        else out.push({ ...style, text: decode(tt.text) });
        break;
      }
      default:
        if ('tokens' in t && Array.isArray((t as { tokens?: Token[] }).tokens)) out.push(...inlineSpans((t as { tokens: Token[] }).tokens, style));
        else if ('text' in t) out.push({ ...style, text: decode(String((t as { text: string }).text)) });
    }
  }
  return out;
}

// `alt` is already entity-decoded by the caller. Linked images show the host so a
// disguised link (e.g. a tracking pixel that exfiltrates data in its query) is visible.
function imageSpan(href: string | undefined, alt: string, style: Style): Span {
  const host = href && /^https?:\/\//i.test(href) ? urlHost(href) : undefined;
  const label = `[image${alt ? `: ${alt}` : ''}${host ? ` · ${host}` : ''}]`;
  return host ? { ...style, text: label, color: 'cyan', underline: true, href } : { ...style, text: label, dim: true };
}

function urlHost(href: string): string | undefined {
  try {
    return sanitizeTerminal(new URL(href).host) || undefined;
  } catch {
    return undefined;
  }
}

// Reads one attribute from an HTML tag, entity-decoded. Accepts double-quoted,
// single-quoted and unquoted values, with optional whitespace around `=`.
function htmlAttr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i'));
  if (!m) return undefined;
  return decode(m[1] ?? m[2] ?? m[3]);
}

// Percent-encodes characters that would end or break a Markdown link destination.
// encodeURIComponent leaves ( and ) alone, so those are encoded explicitly.
const encodeDestChar = (c: string) => (c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c));

// Turns an <img> tag into Markdown image syntax. The alt is decoded by htmlAttr, then its
// `&` is re-encoded so the Markdown pass doesn't decode it a second time, and `\` is
// written as an entity so a trailing backslash can't escape the closing `]`.
function imgTagToMarkdown(tag: string): string {
  const src = htmlAttr(tag, 'src');
  if (!src) return '';
  const alt = (htmlAttr(tag, 'alt') ?? '').replace(/[[\]]/g, '').replace(/&/g, '&amp;').replace(/\\/g, '&#92;');
  return `![${alt}](${src.replace(/[\s()<>]/g, encodeDestChar)})`;
}

function shortUrl(href: string): string {
  const u = href.replace(/^https?:\/\/(www\.)?/, '');
  return u.length > 50 ? `${u.slice(0, 49)}…` : u;
}

// Decodes the entities Markdown and GitHub HTML commonly carry, in a single pass so
// `&amp;lt;` becomes `&lt;` rather than `<`.
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#92': '\\' };
function decode(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|#92);/g, (_, e: string) => ENTITIES[e]);
}

const cleanSpan = (s: Span): Span => {
  const text = sanitizeTerminal(s.text);
  const href = s.href === undefined ? undefined : sanitizeTerminal(s.href);
  return text === s.text && href === s.href ? s : { ...s, text, ...(s.href === undefined ? {} : { href }) };
};

// Word-wraps styled spans to `width`, keeping each word's style. Continuation lines get
// `indent` (plain) so list items and quotes line up.
export function wrapSpans(spans: Span[], width: number, first: Span[] = [], indent: Span[] = []): MdLine[] {
  const len = (l: Span[]) => l.reduce((n, s) => n + [...s.text].length, 0);
  const lines: MdLine[] = [];
  let line: Span[] = [...first];
  let lineHasWord = false;
  const push = () => {
    lines.push(trimEnd(line));
    line = [...indent];
    lineHasWord = false;
  };
  for (const span of spans.map(cleanSpan)) {
    // Split into words and whitespace, keeping explicit newlines.
    for (const part of span.text.split(/(\n|\s+)/)) {
      if (!part) continue;
      if (part === '\n') {
        push();
        continue;
      }
      const isSpace = /^\s+$/.test(part);
      if (isSpace) {
        if (lineHasWord) line.push({ ...span, text: ' ' });
        continue;
      }
      let word = part;
      const room = () => width - len(line);
      if (lineHasWord && [...word].length > room()) push();
      // A word longer than a whole line is broken.
      while ([...word].length > room() && room() > 0) {
        const r = room();
        line.push({ ...span, text: [...word].slice(0, r).join('') });
        word = [...word].slice(r).join('');
        push();
      }
      line.push({ ...span, text: word });
      lineHasWord = true;
    }
  }
  if (lineHasWord || !lines.length) lines.push(trimEnd(line));
  return lines;
}

function trimEnd(line: Span[]): Span[] {
  const out = [...line];
  while (out.length && /^\s*$/.test(out[out.length - 1].text) && out.length > 1) out.pop();
  if (out.length) out[out.length - 1] = { ...out[out.length - 1], text: out[out.length - 1].text.replace(/\s+$/, '') };
  return out;
}

// ---------- blocks ----------

function blockLines(tokens: Token[], width: number, out: MdLine[], depth = 0) {
  const gap = () => {
    if (out.length && out[out.length - 1].some((s) => s.text.trim())) out.push([]);
  };
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
        break;
      case 'heading': {
        const h = t as Tokens.Heading;
        gap();
        const spans = inlineSpans(h.tokens, { bold: true, color: h.depth <= 2 ? HEADING_COLOR : undefined, underline: h.depth === 1 });
        out.push(...wrapSpans(spans, width));
        break;
      }
      case 'paragraph':
        gap();
        out.push(...wrapSpans(inlineSpans((t as Tokens.Paragraph).tokens), width));
        break;
      case 'text': {
        const tt = t as Tokens.Text;
        out.push(...wrapSpans(tt.tokens ? inlineSpans(tt.tokens) : [{ text: decode(tt.text) }], width));
        break;
      }
      case 'list': {
        const l = t as Tokens.List;
        if (depth === 0) gap();
        l.items.forEach((item, i) => {
          const marker = item.task ? (item.checked ? '☑ ' : '☐ ') : l.ordered ? `${Number(l.start || 1) + i}. ` : depth % 2 ? '◦ ' : '• ';
          const pad = ' '.repeat([...marker].length);
          const inline: Token[] = [];
          const nested: Token[] = [];
          for (const c of item.tokens) (c.type === 'list' || c.type === 'code' || c.type === 'blockquote' ? nested : inline).push(c);
          const spans = inlineSpans(inline.flatMap((c) => (c.type === 'paragraph' ? [...((c as Tokens.Paragraph).tokens ?? []), { type: 'br', raw: '' } as Token] : [c])));
          while (spans.length && spans[spans.length - 1].text === '\n') spans.pop();
          const style: Style = item.task && item.checked ? { dim: true } : {};
          const first: Span[] = [{ text: marker, color: item.task ? (item.checked ? 'green' : undefined) : 'gray' }];
          out.push(
            ...wrapSpans(
              spans.map((s) => ({ ...style, ...s })),
              width,
              first,
              [{ text: pad }],
            ),
          );
          if (nested.length) {
            const sub: MdLine[] = [];
            blockLines(nested, width - pad.length, sub, depth + 1);
            out.push(...sub.map((ln) => [{ text: pad }, ...ln]));
          }
        });
        break;
      }
      case 'code': {
        const c = t as Tokens.Code;
        gap();
        if (c.lang) out.push([{ text: `  ${c.lang}`, dim: true }]);
        for (const raw of c.text.split('\n')) {
          const text = raw.replace(/\t/g, '  ');
          const room = Math.max(1, width - 2);
          out.push([
            { text: '▏ ', dim: true },
            { text: [...text].length > room ? `${[...text].slice(0, room - 1).join('')}…` : text, color: 'white' },
          ]);
        }
        break;
      }
      case 'blockquote': {
        const b = t as Tokens.Blockquote;
        gap();
        // GitHub alerts: > [!NOTE], [!TIP], [!IMPORTANT], [!WARNING], [!CAUTION]
        const alert = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/i.exec(b.text);
        if (alert) {
          const kind = alert[1].toUpperCase();
          const color = ALERT_COLOR[kind];
          const sub: MdLine[] = [];
          blockLines(lexer(b.text.slice(alert[0].length)), width - 2, sub, depth);
          out.push([
            { text: '▎ ', color },
            { text: kind[0] + kind.slice(1).toLowerCase(), bold: true, color },
          ]);
          out.push(...sub.map((ln) => [{ text: '▎ ', color }, ...ln]));
          break;
        }
        const sub: MdLine[] = [];
        blockLines(b.tokens, width - 2, sub, depth);
        out.push(...sub.map((ln) => [{ text: '▎ ', color: 'gray' }, ...ln.map((s) => ({ ...s, italic: true, dim: true }))]));
        break;
      }
      case 'hr':
        gap();
        out.push([{ text: '─'.repeat(Math.max(3, Math.min(width, 40))), dim: true }]);
        break;
      case 'table':
        gap();
        out.push(...tableLines(t as Tokens.Table, width));
        break;
      case 'html': {
        // Render common GitHub HTML as terminal-friendly Markdown. Marked treats a
        // <details> block as one HTML token, including all of its inner Markdown.
        const html = (t as Tokens.HTML).text
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace(/<br\s*\/?\s*>/gi, '\n')
          .replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi, '\n**$1**\n')
          .replace(/<\/(?:p|div|details|ul|ol|li|pre)>/gi, '\n')
          .replace(/<li\b[^>]*>/gi, '\n- ')
          .replace(/<img\b[^>]*>/gi, imgTagToMarkdown)
          .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
          .replace(/<[^>]+>/g, '')
          .trim();
        if (html) blockLines(lexer(html, { gfm: true }), width, out, depth);
        break;
      }
      default:
        if ('text' in t && typeof (t as { text?: unknown }).text === 'string') out.push(...wrapSpans([{ text: (t as { text: string }).text }], width));
    }
  }
}

function tableLines(t: Tokens.Table, width: number): MdLine[] {
  const cell = (c: Tokens.TableCell) =>
    inlineSpans(c.tokens)
      .map((s) => s.text)
      .join('');
  const header = t.header.map(cell);
  const rows = t.rows.map((r) => r.map(cell));
  const n = header.length;
  const natural = header.map((h, i) => Math.max([...h].length, ...rows.map((r) => [...(r[i] ?? '')].length), 1));
  const budget = Math.max(n * 3, width - (3 * n + 1));
  const widths = [...natural];
  // Shrink the widest columns until the table fits.
  while (widths.reduce((a, b) => a + b, 0) > budget) {
    const i = widths.indexOf(Math.max(...widths));
    if (widths[i] <= 3) break;
    widths[i]--;
  }
  const fit = (s: string, w: number) => ([...s].length > w ? `${[...s].slice(0, w - 1).join('')}…` : s + ' '.repeat(w - [...s].length));
  const rule = (l: string, m: string, r: string) => [{ text: l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r, dim: true }];
  const row = (cells: string[], bold = false): MdLine => {
    const spans: Span[] = [{ text: '│', dim: true }];
    cells.forEach((c, i) => {
      spans.push({ text: ` ${fit(c ?? '', widths[i])} `, bold });
      spans.push({ text: '│', dim: true });
    });
    return spans;
  };
  return [rule('┌', '┬', '┐'), row(header, true), rule('├', '┼', '┤'), ...rows.map((r) => row(r)), rule('└', '┴', '┘')];
}

// GitHub templates leave comments and emoji shortcodes that read as noise in a terminal.
function preclean(md: string): string {
  return sanitizeTerminal(md.replace(/\r\n?/g, '\n'))
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|\s):[a-z0-9_+-]+:(?=\s|$)/g, '$1');
}

export function renderMarkdown(md: string, width: number): MdLine[] {
  const out: MdLine[] = [];
  try {
    blockLines(lexer(preclean(md), { gfm: true }), Math.max(10, width), out);
  } catch {
    return md.split('\n').flatMap((l) => wrapSpans([{ text: l }], width));
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i].map(cleanSpan);
  while (out.length && !out[out.length - 1].some((s) => s.text.trim())) out.pop();
  while (out.length && !out[0].some((s) => s.text.trim())) out.shift();
  return out;
}

export function plainText(line: MdLine): string {
  return line.map((s) => s.text).join('');
}

// Applies a style on top of every span, e.g. dim italics for the agent's inferences.
export function restyle(lines: MdLine[], style: Style): MdLine[] {
  const { color, ...rest } = style;
  return lines.map((l) => l.map((s) => ({ ...s, ...rest, color: s.color ?? color })));
}

export const line = (text: string, style: Style = {}): MdLine => [{ text, ...style }];

export function MdLineView(props: { line: MdLine }) {
  if (!props.line.length) return <Text> </Text>;
  return (
    <Text wrap="truncate">
      {props.line.map((s, i) => (
        <Text key={i} bold={s.bold} italic={s.italic} underline={s.underline} strikethrough={s.strike} dimColor={s.dim} color={s.color}>
          {s.href ? hyperlink(sanitizeTerminal(s.text), s.href) : sanitizeTerminal(s.text)}
        </Text>
      ))}
    </Text>
  );
}

const OSC8 = `${OSC}8;;`;
// The href is stripped of C0 and C1 controls: BEL, ESC, and \u009c (ST) / \u009d (OSC)
// would otherwise end the sequence early or start a new one in some terminals.
export const hyperlink = (text: string, href: string) => `${OSC8}${sanitizeTerminal(href)}${BEL}${text}${OSC8}${BEL}`;
