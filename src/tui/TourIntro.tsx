import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { sanitizeTerminal as safe } from '../util/sanitize.js';

// Loading screen for a tour: a title card over a drifting pattern that tracks the
// pipeline while it runs. The app cuts straight to the briefing once it is written.

const FRAME_MS = 40;
const NEEDLE = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const CURTAIN_BG = '#1E1E2E';

interface Seg {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

// One card line, either plain text or colored segments (e.g. a green ✓ and its step).
export type IntroLine = string | Seg[];

// Card lines can carry the PR title, so terminal controls are stripped before measuring.
const lineSegs = (l: IntroLine, i: number): Seg[] => (typeof l === 'string' ? [{ text: safe(l), color: i === 0 ? 'white' : 'gray', bold: i === 0 }] : l.map((s) => ({ ...s, text: safe(s.text) })));
const segLen = (segs: Seg[]) => segs.reduce((n, s) => n + [...s.text].length, 0);

// Truncates or pads a segment list to exactly n columns.
function fitSegs(segs: Seg[], n: number): Seg[] {
  if (segLen(segs) <= n) return [...segs, { text: ' '.repeat(n - segLen(segs)) }];
  const cut = slice(segs, 0, Math.max(0, n - 1));
  return [...cut, { text: '…', color: cut.at(-1)?.color }];
}

// The full screen as rows of segments, with the card centered on the pattern.
export function introFrame(width: number, height: number, lines: IntroLine[], elapsed: number): Seg[][] {
  const needle = Math.floor(elapsed / 90) % NEEDLE.length;
  const drift = Math.floor(elapsed / 80);
  const pattern = (row: number, from: number, to: number): Seg => ({
    text: Array.from({ length: Math.max(0, to - from) }, (_, i) => ((from + i + row + drift) % 6 === 0 ? '╱' : ' ')).join(''),
    color: 'gray',
    dim: true,
  });
  const body = lines.map(lineSegs);
  const inner = Math.max(0, Math.min(width - 6, Math.max(44, ...body.map((l) => segLen(l) + 4))));
  const border = (text: string): Seg => ({ text, color: 'cyan' });
  const row = (segs: Seg[]) => [border('│'), ...fitSegs([{ text: '  ' }, ...segs], inner), border('│')];
  const card: Seg[][] = [
    [border(`╭${'─'.repeat(inner)}╮`)],
    row([{ text: `${NEEDLE[needle]}  Guided Review`, color: 'cyan', bold: true }]),
    row([]),
    ...body.map(row),
    [border(`╰${'─'.repeat(inner)}╯`)],
  ];
  const cardW = inner + 2;
  const top = Math.floor((height - card.length) / 2);
  const left = Math.floor((width - cardW) / 2);
  return Array.from({ length: height }, (_, r) => {
    const c = card[r - top];
    if (!c || cardW > width) return [pattern(r, 0, width)];
    return [pattern(r, 0, left), ...c, pattern(r, left + cardW, width)];
  });
}

function slice(segs: Seg[], from: number, to: number): Seg[] {
  const out: Seg[] = [];
  let col = 0;
  for (const s of segs) {
    const chars = [...s.text];
    const a = Math.max(from, col);
    const b = Math.min(to, col + chars.length);
    if (b > a) out.push({ ...s, text: chars.slice(a - col, b - col).join('') });
    col += chars.length;
  }
  return out;
}

export function TourIntro(props: {
  width: number;
  height: number;
  lines: (spinner: string) => IntroLine[]; // spinner frame for in-progress steps
  onBack?: () => void; // q: back to the PR list; unset, q quits
  onQuit: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setElapsed(Date.now() - start), FRAME_MS);
    return () => clearInterval(t);
  }, []);
  useInput((input) => {
    if (input === 'q') (props.onBack ?? props.onQuit)();
    if (input === 'Q') props.onQuit();
  });

  const rows = introFrame(props.width, props.height, props.lines(SPIN[Math.floor(elapsed / 90) % SPIN.length]), elapsed);
  return (
    <Box width={props.width} height={props.height} flexDirection="column" overflow="hidden" backgroundColor={CURTAIN_BG}>
      {rows.map((segs, i) => (
        <Text key={i} wrap="truncate">
          {segs.map((s, j) => (
            <Text key={j} color={s.color} bold={s.bold} dimColor={s.dim}>
              {safe(s.text)}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}
