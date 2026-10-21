import React, { useEffect, useState } from 'react';
import { Box, Text, useTheme } from '../themed.js';
import type { Hunk, TestLink } from '../../types.js';
import { truncate } from '../nav.js';
import { highlightDiffLines, highlightSourceLines, type HunkHighlights } from '../highlight.js';
import { codeChunks } from './text.js';
import { DIFF_BACKGROUND, SyntaxText } from './SyntaxText.js';

const LINK_TEXT = { coverage: 'coverage run', 'name-match': 'name match', naming: 'naming guess' } as const;

export function TestPane(props: {
  tests: TestLink[];
  covers?: Hunk['covers'];
  idx: number;
  cursor: number;
  scroll: number;
  setScroll: (n: number) => void;
  focused: boolean;
  inline?: { node: React.ReactNode; height: number };
  width: number;
  height: number;
}) {
  const { width, height } = props;
  const covers = props.covers;
  const selected = covers ?? props.tests[props.idx];
  const [highlights, setHighlights] = useState<HunkHighlights>();
  const [diffHighlights, setDiffHighlights] = useState<(HunkHighlights | undefined)[]>();
  // Keyed on the test's file and text, so a tour update with the same test code keeps its highlight.
  const testFileName = covers?.file ?? props.tests[props.idx]?.testFile;
  const { syntax } = useTheme();
  const testKey = selected
    ? `${testFileName}\0${'diffHunks' in selected && selected.diffHunks?.length ? selected.diffHunks.map((d) => d.lines.map((l) => l.kind + l.text).join('\n')).join('\0') : selected.lines.join('\n')}`
    : '';
  const highlightKey = `${syntax}\0${testKey}`;
  const latest = React.useRef({ selected, file: testFileName, syntax, testKey });
  latest.current = { selected, file: testFileName, syntax, testKey };
  const shownTest = React.useRef('');
  useEffect(() => {
    let active = true;
    // Another test clears its colors; another theme keeps the old ones until the new arrive.
    if (shownTest.current !== latest.current.testKey) {
      setHighlights(undefined);
      setDiffHighlights(undefined);
    }
    shownTest.current = latest.current.testKey;
    const { selected, file, syntax } = latest.current;
    if (selected && file) {
      if ('diffHunks' in selected && selected.diffHunks?.length) {
        void Promise.all(selected.diffHunks.map((diff) => highlightDiffLines(file, diff.lines, undefined, syntax))).then((result) => {
          if (active) setDiffHighlights(result);
        });
      } else {
        void highlightSourceLines(file, selected.lines, syntax).then((result) => {
          if (active) setHighlights(result);
        });
      }
    }
    return () => {
      active = false;
    };
  }, [highlightKey]);
  const lines: React.ReactNode[] = [];
  let codeIndex = 0;
  let cursorRow = -1;
  const marker = () => {
    const selected = props.focused && codeIndex === props.cursor;
    if (selected) cursorRow = lines.length;
    codeIndex++;
    return <Text color={selected ? 'cyan' : undefined}>{selected ? '▶' : ' '}</Text>;
  };
  if (covers) {
    lines.push(
      <Text key="h" bold>
        {truncate(`Covers (unchanged): ${covers.file}${covers.symbol ? ` › ${covers.symbol}` : ''}`, width)}
      </Text>,
    );
    covers.lines.forEach((l, i) => {
      const caret = marker();
      codeChunks(l, width - 6).forEach((code, part) =>
        lines.push(
          <Text key={`c${i}_${part}`}>
            {part === 0 ? caret : ' '}
            <Text dimColor>{part === 0 ? String(covers.startLine + i).padStart(4) : ' '.repeat(4)} </Text>
            <SyntaxText text={code} spans={highlights?.[i]} column={part * Math.max(1, width - 6)} />
          </Text>,
        ),
      );
    });
  } else {
    props.tests.forEach((t: TestLink, ti) => {
      const active = ti === props.idx;
      const guess = t.source === 'naming';
      lines.push(
        <Text key={`t${ti}`} inverse={active && props.focused} bold={active} dimColor={!active}>
          {truncate(`${active ? '▸' : ' '} ${t.testName}`, width - 1)}
        </Text>,
      );
      lines.push(
        <Text key={`m${ti}`}>
          {t.diffHunks?.length ? (
            <Text bold color={t.testChange === 'new' ? 'green' : 'yellow'}>
              {t.testChange === 'new' ? '● new' : '◐ modified'}
            </Text>
          ) : null}
          <Text dimColor italic={guess}>
            {truncate(
              `  ${t.testFile}:${t.startLine} · ${LINK_TEXT[t.source]}${guess ? ' (guess)' : ''} · ${Math.round(t.confidence * 100)}%`,
              width - (t.diffHunks?.length ? (t.testChange === 'new' ? 5 : 10) : 0),
            )}
          </Text>
        </Text>,
      );
      if (active) {
        if (t.diffHunks?.length) {
          t.diffHunks.forEach((diff, di) => {
            if (t.diffHunks!.length > 1)
              lines.push(
                <Text key={`h${ti}_${di}`} color="cyan">
                  {truncate(diff.header, width)}
                </Text>,
              );
            diff.lines.forEach((l, i) => {
              const caret = marker();
              const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
              const color = l.kind === 'add' ? 'green' : l.kind === 'del' ? 'red' : undefined;
              codeChunks(l.text, width - 12).forEach((code, part) =>
                lines.push(
                  <Text key={`d${ti}_${di}_${i}_${part}`}>
                    {part === 0 ? caret : ' '}
                    <Text backgroundColor={DIFF_BACKGROUND[l.kind]}>
                      <Text dimColor>{part === 0 ? `${l.oldLine ?? ''}`.padStart(4) + ' ' + `${l.newLine ?? ''}`.padStart(4) : ' '.repeat(9)} </Text>
                      <Text color={color}>{part === 0 ? sign : ' '}</Text>
                      <SyntaxText text={code} spans={diffHighlights?.[di]?.[i]} column={part * Math.max(1, width - 12)} />
                    </Text>
                  </Text>,
                ),
              );
            });
          });
        } else {
          t.lines.forEach((l, i) => {
            const caret = marker();
            codeChunks(l, width - 6).forEach((code, part) =>
              lines.push(
                <Text key={`l${ti}_${i}_${part}`}>
                  {part === 0 ? caret : ' '}
                  <Text dimColor>{part === 0 ? String(t.startLine + i).padStart(4) : ' '.repeat(4)} </Text>
                  <SyntaxText text={code} spans={highlights?.[i]} column={part * Math.max(1, width - 6)} />
                </Text>,
              ),
            );
          });
        }
      }
    });
  }
  let top = Math.min(props.scroll, Math.max(0, lines.length - height));
  if (cursorRow >= 0 && cursorRow < top) top = cursorRow;
  if (cursorRow >= top + height) top = cursorRow - height + 1;
  useEffect(() => {
    if (top !== props.scroll) props.setScroll(top);
  });
  if (props.inline && cursorRow >= 0) {
    const avail = Math.max(2, height - props.inline.height);
    const start = Math.max(0, cursorRow - Math.max(1, Math.floor(avail * 0.6)) + 1);
    const before = lines.slice(start, cursorRow + 1);
    const after = lines.slice(cursorRow + 1, cursorRow + 1 + Math.max(0, avail - before.length));
    return (
      <Box flexDirection="column" width={width} height={height} overflow="hidden">
        {before}
        <Box flexShrink={0} paddingLeft={1}>
          {props.inline.node}
        </Box>
        {after}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden" borderStyle={undefined}>
      {lines.slice(top, top + height)}
    </Box>
  );
}
