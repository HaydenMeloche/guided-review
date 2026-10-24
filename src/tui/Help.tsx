import { useState, type ReactNode } from 'react';
import { useInput } from 'ink';
import { Box, Text } from './themed.js';
import { truncate } from './nav.js';
import { KeyBar } from './KeyBar.js';
import { MdLineView, type MdLine } from './markdown.js';
import type { HelpSection } from './keys.js';
import { ReviewPopup } from './ReviewPopup.js';

// The key reference every screen opens with ?: the screen's keys grouped by what they do, then
// the keys that work everywhere, and on review screens a second page explaining the marks.
// It scrolls when it does not fit, so nothing is cut on a short terminal.

const LABEL_W = 11;
const KEY_W = 14;
const CHROME = 2; // title, footer

export const EVERYWHERE: HelpSection = {
  title: 'Everywhere',
  rows: [
    ['esc', 'close what is open, or go back a level'],
    ['q', 'go up a level'],
    ['Q', 'quit'],
    ['?', 'these keys'],
  ],
};

// The help's rows: a section's title beside its first row, a blank row between sections.
function keyLines(sections: HelpSection[], width: number): MdLine[] {
  const out: MdLine[] = [];
  for (const [i, s] of [...sections, EVERYWHERE].entries()) {
    if (i) out.push([]);
    for (const [j, [k, text]] of s.rows.entries()) {
      out.push([
        { text: (j ? '' : s.title).padEnd(LABEL_W), dim: true, bold: true },
        { text: k.padEnd(KEY_W), color: 'cyan', bold: true },
        { text: truncate(text, Math.max(1, width - LABEL_W - KEY_W)) },
      ]);
    }
  }
  return out;
}

// The popup size that fits the help without scrolling.
export function helpSize(sections: HelpSection[], legend?: MdLine[], note?: string): { width: number; height: number } {
  const rows = [...sections, EVERYWHERE].flatMap((s) => s.rows);
  const keysW = LABEL_W + KEY_W + Math.max(...rows.map(([, t]) => t.length));
  const legendW = Math.max(0, ...(legend ?? []).map((l) => l.reduce((n, s) => n + s.text.length, 0)));
  const lines = Math.max(keyLines(sections, keysW).length, legend?.length ?? 0) + (note ? 1 : 0);
  return { width: Math.max(keysW, legendW, (note ?? '').length) + 4, height: lines + CHROME + 2 };
}

export function Help(props: { title: string; sections: HelpSection[]; legend?: MdLine[]; note?: string; width: number; height: number; onClose: () => void }) {
  const [page, setPage] = useState<'keys' | 'legend'>('keys');
  const [top, setTop] = useState(0);
  const inner = props.width - 2;
  const lines = page === 'legend' && props.legend ? props.legend : keyLines(props.sections, inner);
  const room = Math.max(1, props.height - CHROME - (props.note ? 1 : 0));
  const max = Math.max(0, lines.length - room);
  const scroll = (to: number) => setTop(Math.max(0, Math.min(max, to)));
  useInput((input, key) => {
    if (key.escape || key.return || input === 'q' || input === '?' || input === 'h') return props.onClose();
    if (key.tab && props.legend) {
      setTop(0);
      return setPage((p) => (p === 'keys' ? 'legend' : 'keys'));
    }
    if (input === 'j' || key.downArrow) return scroll(top + 1);
    if (input === 'k' || key.upArrow) return scroll(top - 1);
    if (input === 'J' || key.pageDown || input === ' ') return scroll(top + room);
    if (input === 'K' || key.pageUp) return scroll(top - room);
    if (input === 'g') return scroll(0);
    if (input === 'G') return scroll(max);
  });
  const pages = props.legend ? ` · ${page === 'keys' ? 1 : 2}/2` : '';
  const position = max ? ` · ${Math.min(lines.length, top + room)}/${lines.length}` : '';
  return (
    <Box flexDirection="column" paddingX={1} width={props.width}>
      <Text wrap="truncate">
        <Text bold>{page === 'legend' ? 'Marks' : 'Keys'}</Text>
        <Text dimColor>{` · ${props.title}${pages}${position}`}</Text>
      </Text>
      {props.note ? (
        <Text color="yellow" wrap="truncate">
          {props.note}
        </Text>
      ) : null}
      <Box flexDirection="column" height={room} overflow="hidden">
        {lines.slice(top, top + room).map((l, i) => (
          <MdLineView key={top + i} line={l} />
        ))}
      </Box>
      <KeyBar
        width={inner - 2}
        accent
        keys={[...((max ? [['j/k', 'scroll']] : []) as [string, string][]), ...((props.legend ? [['tab', page === 'keys' ? 'marks' : 'keys']] : []) as [string, string][]), ['esc', 'close']]}
      />
    </Box>
  );
}

// The help floating over a screen, sized to fit it when the terminal allows.
export function HelpPopup(props: { background: ReactNode; width: number; height: number; title: string; sections: HelpSection[]; legend?: MdLine[]; note?: string; onClose: () => void }) {
  const size = helpSize(props.sections, props.legend, props.note);
  return (
    <ReviewPopup background={props.background} width={props.width} height={props.height} maxWidth={size.width} maxHeight={size.height}>
      {(w, h) => <Help title={props.title} sections={props.sections} legend={props.legend} note={props.note} width={w} height={h} onClose={props.onClose} />}
    </ReviewPopup>
  );
}
