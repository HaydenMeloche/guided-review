import { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import { Box, Text, useSelected, useTheme } from './themed.js';
import { ROLES, SURFACES, type ThemeInfo } from './theme.js';
import { highlightDiffLines, type HunkHighlights, type SyntaxSpan } from './highlight.js';
import { pad, riskMark, stateMark, truncate } from './nav.js';
import { KeyBar } from './KeyBar.js';
import { Heading } from './BriefingScreen.js';
import { plural } from './plural.js';
import type { DiffLine } from '../types.js';

const PREVIEW_DELAY_MS = 150;

// The color theme list. The theme the cursor rests on is applied (`onPreview`), so the sample
// beside it, and in a tour the screen behind it, show the theme before it is chosen. j/k move;
// / (or i) searches by name, where typing filters the list and the arrow keys move.
export function ThemePicker(props: {
  themes: ThemeInfo[];
  current: string; // the theme in use when the picker opened
  width: number;
  height: number;
  onPreview: (name: string) => void;
  onDone: (name: string | undefined) => void; // undefined: cancelled, the caller restores `current`
  note?: string; // shown above the keys, e.g. where the choice is saved
}) {
  const { themes } = props;
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [selId, setSelId] = useState(props.current);
  const shown = themes.filter((t) => matchesTheme(t, query));
  const sel = Math.max(
    0,
    shown.findIndex((t) => t.id === selId),
  );
  const selected = shown[sel];
  // A search that hides the theme under the cursor moves the cursor to its first match, and it
  // stays there when the search is cleared.
  useEffect(() => {
    if (selected && selected.id !== selId) setSelId(selected.id);
  }, [selected, selId]);
  const preview = useRef(props.onPreview);
  preview.current = props.onPreview;
  const selectedRow = useSelected();
  // Applied once the cursor rests: holding an arrow through the list would otherwise load every
  // theme and, over a tour, re-highlight the open files in each one.
  useEffect(() => {
    if (!selected) return;
    const t = setTimeout(() => preview.current(selected.id), PREVIEW_DELAY_MS);
    return () => clearTimeout(t);
  }, [selected]);

  const listH = Math.max(1, props.height - 3); // title and search, note, keys
  useInput((input, key) => {
    // From the latest cursor, so keys that arrive together each move it.
    const move = (to: (i: number) => number) =>
      setSelId((id) => {
        if (!shown.length) return id;
        const i = Math.max(
          0,
          shown.findIndex((t) => t.id === id),
        );
        return shown[Math.min(shown.length - 1, Math.max(0, to(i)))].id;
      });
    if (key.downArrow) return move((i) => i + 1);
    if (key.upArrow) return move((i) => i - 1);
    if (key.pageDown) return move((i) => i + listH);
    if (key.pageUp) return move((i) => i - listH);
    if (key.home) return move(() => 0);
    if (key.end) return move(() => shown.length - 1);
    if (key.return) return selected ? props.onDone(selected.id) : undefined;
    if (searching) {
      if (key.escape) {
        setSearching(false);
        return setQuery('');
      }
      if (key.backspace || key.delete) return setQuery((q) => q.slice(0, -1));
      if (key.ctrl && input === 'u') return setQuery('');
      if (input && !key.ctrl && !key.meta && !key.tab && input >= ' ') setQuery((q) => q + input);
      return;
    }
    if (input === 'j') return move((i) => i + 1);
    if (input === 'k') return move((i) => i - 1);
    if (input === 'J') return move((i) => i + listH);
    if (input === 'K') return move((i) => i - listH);
    if (input === 'g') return move(() => 0);
    if (input === 'G') return move(() => shown.length - 1);
    if (input === '/' || input === 'i') return setSearching(true);
    if (key.escape || input === 'q') return props.onDone(undefined);
  });

  const listW = Math.min(30, Math.max(16, ...themes.map((t) => t.displayName.length + 4)));
  const sampleW = props.width - listW - 2;
  const top = Math.max(0, Math.min(sel - Math.floor(listH / 2), shown.length - listH));
  return (
    <Box flexDirection="column" width={props.width} height={props.height} paddingX={0}>
      <Text wrap="truncate">
        <Text bold> Color theme </Text>
        <Text dimColor>
          · {shown.length ? sel + 1 : 0}/{shown.length}
          {query ? ` of ${themes.length}` : ''}
          {'  '}
        </Text>
        {searching ? (
          <>
            <Text color="cyan">/ {query}</Text>
            <Text inverse> </Text>
          </>
        ) : (
          <Text dimColor>/ to search</Text>
        )}
      </Text>
      <Box flexDirection="row" height={listH}>
        <Box flexDirection="column" width={listW}>
          {shown.length ? null : <Text dimColor> No theme matches.</Text>}
          {shown.slice(top, top + listH).map((t, i) => {
            const here = top + i === sel;
            return (
              <Text key={t.id} {...selectedRow(here)} wrap="truncate">
                {pad(` ${t.id === props.current ? '●' : ' '} ${t.displayName}`, listW - 2)}
                <Text dimColor={!here}>{t.type === 'light' ? '☀' : ' '}</Text>{' '}
              </Text>
            );
          })}
        </Box>
        {sampleW >= 40 ? (
          <Box marginLeft={2} width={sampleW} flexDirection="column">
            <ThemeSample width={sampleW} height={listH} />
          </Box>
        ) : null}
      </Box>
      <Text dimColor wrap="truncate">
        {' '}
        {props.note ?? ''}
      </Text>
      <KeyBar
        accent
        width={props.width}
        keys={
          searching
            ? [
                ['↑/↓', 'preview'],
                ['enter', 'choose'],
                ['esc', 'stop searching'],
              ]
            : [
                ['j/k', 'preview'],
                ['/', 'search'],
                ['enter', 'choose'],
                ['esc', 'cancel'],
              ]
        }
      />
    </Box>
  );
}

// Every word of the query appears in the theme's name, id, or type ("dark", "light").
export function matchesTheme(theme: ThemeInfo, query: string): boolean {
  const haystack = `${theme.displayName} ${theme.id} ${theme.type}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

const SAMPLE: DiffLine[] = [
  { kind: 'ctx', text: 'export async function fetchWithRetry(url: string, attempts = 3) {', oldLine: 12, newLine: 12 },
  { kind: 'del', text: '  return fetch(url);', oldLine: 13 },
  { kind: 'add', text: '  for (let i = 0; i < attempts; i++) {', newLine: 13 },
  { kind: 'add', text: '    const res = await fetch(url); // retried on 5xx', newLine: 14 },
  { kind: 'add', text: '    if (res.status < 500) return res;', newLine: 15 },
  { kind: 'add', text: '  }', newLine: 16 },
  { kind: 'ctx', text: '  throw new Error(`gave up on ${url}`);', oldLine: 14, newLine: 17 },
  { kind: 'ctx', text: '}', oldLine: 15, newLine: 18 },
];

// The two main screens in miniature, in the current theme: the briefing (headings, the
// author's description, a flag, chapters) and a chapter (explanation, highlighted hunk).
function ThemeSample(props: { width: number; height: number }) {
  const { syntax } = useTheme();
  const selectedRow = useSelected();
  const [spans, setSpans] = useState<{ syntax: string; value?: HunkHighlights }>({ syntax: '' });
  useEffect(() => {
    let live = true;
    void highlightDiffLines('sample.ts', SAMPLE, undefined, syntax).then((value) => live && setSpans({ syntax, value }));
    return () => {
      live = false;
    };
  }, [syntax]);
  const highlights = spans.value; // the sample's text never changes, so the last theme's colors hold until the new ones arrive
  const w = props.width;
  const chapters: [string, Parameters<typeof stateMark>[0], number][] = [
    ['Retry failed requests', 'read', 3],
    ['Client configuration', 'deferred', 2],
    ['Tests for the client', 'unread', 0],
  ];
  const rule = (label: string) => (
    <Text dimColor wrap="truncate">
      {`── ${label} ${'─'.repeat(Math.max(0, w - label.length - 4))}`}
    </Text>
  );
  return (
    <Box flexDirection="column" width={w} height={props.height} overflow="hidden">
      {rule('Briefing')}
      <Text wrap="truncate">
        <Text color="cyan" bold>
          acme/api
        </Text>
        <Text bold color={ROLES.title}>
          {' '}
          #482 Retry requests that fail
        </Text>
        <Text dimColor>{'  '}by dev · guided</Text>
      </Text>
      <Text wrap="truncate">
        Retries a request up to <Text color="cyan">attempts</Text> times when the server fails.
      </Text>
      <Text wrap="truncate">
        <Heading terminal={{ dimColor: true }}>From the author</Heading>
        <Text dimColor> · </Text>fixes the flaky deploys in <Text color="cyan">#470</Text>
      </Text>
      <Text color="yellow" wrap="truncate">
        ⚑ large pr: 1,240 changed lines across 18 files
      </Text>
      <Text wrap="truncate">
        <Heading terminal={{}}>Chapters</Heading>{' '}
        <Text bold color="cyan">
          · Guided order
        </Text>
        <Text bold dimColor>
          {' '}
          · 4/9 hunks done
        </Text>
      </Text>
      {chapters.map(([title, state, risk], i) => {
        const st = stateMark(state);
        const rk = riskMark(risk);
        return (
          <Text key={title} {...selectedRow(i === 0)} wrap="truncate">
            <Text color={st.color}>{st.mark}</Text>
            <Text color={rk.color}>{rk.mark}</Text> <Text color={i === 0 ? undefined : ROLES.title}>{pad(title, w - 13)}</Text>
            <Text dimColor>{` ${plural(3 - i, 'hunk')}`}</Text>
          </Text>
        );
      })}
      {rule('Chapter')}
      <Text wrap="truncate">
        <Text bold>{pad('Retry failed requests', Math.max(1, w - 13))}</Text> <Text color="green">████</Text>
        <Text dimColor>░░░░ 4/9</Text>
      </Text>
      <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} width={w} flexShrink={0}>
        <Text bold color="blue">
          Explanation
        </Text>
        <Text wrap="truncate">
          Retries up to <Text color="cyan">attempts</Text> times on a server error.
        </Text>
        <Text color="yellow" wrap="truncate">
          ◐ partly tested · <Text color="red">○ no test for the give-up path</Text>
        </Text>
      </Box>
      <Text dimColor wrap="truncate">
        {' '}
        src/client.ts <Text color="magenta">[question]</Text>
      </Text>
      {SAMPLE.map((l, i) => (
        <SampleLine key={i} line={l} spans={highlights?.[i]} width={w} />
      ))}
    </Box>
  );
}

function SampleLine(props: { line: DiffLine; spans?: SyntaxSpan[]; width: number }) {
  const { line } = props;
  const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
  const no = String(line.kind === 'del' ? line.oldLine : line.newLine).padStart(3);
  const codeW = Math.max(1, props.width - 6);
  const text = truncate(line.text, codeW).padEnd(codeW);
  const cuts = [...new Set([0, text.length, ...(props.spans ?? []).flatMap((s) => [s.start, s.end])])].filter((n) => n >= 0 && n <= text.length).sort((a, b) => a - b);
  return (
    <Text backgroundColor={line.kind === 'add' ? SURFACES.lineAdd : line.kind === 'del' ? SURFACES.lineDel : undefined} wrap="truncate">
      <Text dimColor>{no} </Text>
      <Text color={line.kind === 'add' ? 'green' : line.kind === 'del' ? 'red' : undefined}>{sign}</Text>{' '}
      {cuts.slice(0, -1).map((start, i) => (
        <Text key={start} color={props.spans?.find((s) => s.start <= start && cuts[i + 1] <= s.end)?.color}>
          {text.slice(start, cuts[i + 1])}
        </Text>
      ))}
    </Text>
  );
}
