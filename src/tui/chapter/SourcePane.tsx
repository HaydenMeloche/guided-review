import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, usePreviewing, useTheme } from '../themed.js';
import type { DiffLine, Draft, ExistingThread, Hunk } from '../../types.js';
import { truncate } from '../nav.js';
import { LABEL_COLOR } from '../CommentEditor.js';
import type { HunkHighlights } from '../highlight.js';
import { highlightHunkCached, hunkHighlightKey, peekHunkHighlights } from '../highlightCache.js';
import { wordDiff, type CharRange, type Fold } from '../../diff/lines.js';
import { clean, codeChunks } from './text.js';
import { DIFF_BACKGROUND, SyntaxText, WORD_BACKGROUND } from './SyntaxText.js';
import { GUTTER, SPLIT_GUTTER } from '../paneWidths.js';
import { draftsAt, movedNote, threadAt } from './lineNotes.js';
import { G } from '../glyphs.js';

export const SourcePane = React.memo(function SourcePane(props: {
  inline?: { afterIdx: number; node: React.ReactNode; height: number }; // comment editor under the selected line
  hunk: Hunk;
  cursor: number;
  range: [number, number] | null;
  raw: boolean;
  split: boolean; // old and new side by side
  partner: number[]; // pairChangedLines(hunk.lines)
  hidden: ReadonlyMap<number, Fold>; // removed lines folded into their replacement (foldedLines)
  ignoreWhitespace: boolean;
  scroll: number;
  setScroll: (n: number) => void;
  threads: ExistingThread[];
  drafts: Draft[];
  root?: string;
  headSha: string;
  baseSha: string;
  width: number;
  height: number;
}) {
  const { hunk, cursor, range, width, height } = props;
  // Highlights depend on the hunk's identity and the shas, not on the hunk object: a tour
  // update hands every hunk a new object, and that must not re-read and re-tokenize the file.
  const request = { hunk, root: props.root, headSha: props.headSha, baseSha: props.baseSha };
  const { syntax } = useTheme(); // a theme change re-renders with a new key
  const previewing = usePreviewing();
  const key = hunkHighlightKey(request, syntax);
  const hunkKey = hunkHighlightKey(request, ''); // the same hunk in any theme
  const [state, setState] = useState<{ key: string; hunkKey: string; value?: HunkHighlights }>(() => ({ key, hunkKey, value: peekHunkHighlights(request, syntax, previewing)?.value }));
  const cached = state.key === key ? undefined : peekHunkHighlights(request, syntax, previewing);
  if (cached && state.key !== key) setState({ key, hunkKey, value: cached.value });
  // Another theme's colors for this hunk stay on screen until this theme's arrive.
  const highlights = state.key === key || state.hunkKey === hunkKey ? state.value : undefined;
  const latest = React.useRef({ request, syntax, previewing });
  latest.current = { request, syntax, previewing };
  useEffect(() => {
    let active = true;
    void highlightHunkCached(latest.current.request, latest.current.syntax, latest.current.previewing)
      .catch(() => undefined)
      .then((value) => {
        if (active) setState((s) => (s.key === key && s.value === value ? s : { key, hunkKey, value }));
      });
    return () => {
      active = false;
    };
  }, [key, hunkKey]);
  // The changed words of each paired line, as ranges into its displayed (cleaned) text.
  const words = useMemo(() => {
    const out: (CharRange[] | undefined)[] = [];
    props.partner.forEach((p, i) => {
      if (p < i || hunk.lines[i].kind !== 'del') return;
      const diff = wordDiff(clean(hunk.lines[i].text), clean(hunk.lines[p].text));
      out[i] = diff?.a;
      out[p] = diff?.b;
    });
    return out;
  }, [hunk, props.partner]);
  const rows = useMemo(() => {
    const out: { idx: number; node: React.ReactNode }[] = [];
    if (props.raw) {
      out.push({ idx: -1, node: <Text color="cyan">{truncate(hunk.header, width)}</Text> });
      hunk.lines.forEach((l, i) => {
        const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
        codeChunks(l.text, width - 2).forEach((code, part) => {
          out.push({
            idx: i,
            node: (
              <Text backgroundColor={DIFF_BACKGROUND[l.kind]}>
                <Text color={l.kind === 'add' ? 'green' : l.kind === 'del' ? 'red' : undefined}>{part === 0 ? sign : ' '}</Text>
                {code}
              </Text>
            ),
          });
        });
      });
      return out;
    }
    const reindentedOnly = (l: DiffLine, i: number) => l.kind === 'ctx' || props.hidden.get(i) === 'whitespace' || props.hidden.get(props.partner[i]) === 'whitespace';
    if (props.ignoreWhitespace && hunk.lines.every(reindentedOnly)) out.push({ idx: -1, node: <Text dimColor>{truncate('  whitespace-only changes hidden · w to show', width)}</Text> });
    // Review threads, drafts and a moved block's origin under line j, on rows of line i.
    const notesUnder = (j: number, i: number) => {
      const l = hunk.lines[j];
      const line = l.kind === 'del' ? l.oldLine : l.newLine;
      const threads = threadAt(props.threads, hunk.file, line, l.kind === 'del' ? 'LEFT' : 'RIGHT');
      if (threads.length)
        out.push({
          idx: i,
          node: (
            <Text color="cyan">
              {truncate(
                `          ${G.thread} ${threads.length} review ${threads.length === 1 ? 'thread' : 'threads'} · ${threads.reduce((n, t) => n + t.comments.length, 0)} comments · e to read`,
                width,
              )}
            </Text>
          ),
        });
      for (const d of draftsAt(props.drafts, hunk, line, l.kind === 'del' ? 'LEFT' : 'RIGHT')) {
        out.push({
          idx: i,
          node: <Text color={LABEL_COLOR[d.label]}>{truncate(`          ${G.draft} [${d.label}]${d.posted ? ' (posted)' : ''} ${clean(d.body).replace(/\s+/g, ' ')}`, width)}</Text>,
        });
      }
      const moved = movedNote(hunk, j);
      if (moved) out.push({ idx: i, node: <Text color="magenta">{truncate(`          ${moved}`, width)}</Text> });
    };
    if (props.split) {
      // Old on the left, new on the right; a removed line shares its replacement's row.
      const half = Math.max(8, Math.floor((width - 2) / 2));
      const codeW = Math.max(1, half - SPLIT_GUTTER);
      const cells = (j: number | undefined, side: 'old' | 'new'): React.ReactNode[] => {
        if (j === undefined) return [];
        const l = hunk.lines[j];
        const reindented = props.hidden.get(l.kind === 'del' ? j : props.partner[j]) === 'whitespace' && l.kind !== 'ctx';
        const no = `${(side === 'old' ? l.oldLine : l.newLine) ?? ''}`.padStart(4);
        const sign = reindented ? '~' : l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
        const color = reindented ? undefined : l.kind === 'add' ? 'green' : l.kind === 'del' ? 'red' : undefined;
        const text = clean(l.text);
        const emphasis = reindented || l.kind === 'ctx' ? undefined : words[j]?.filter(([s, e]) => !props.ignoreWhitespace || text.slice(s, e).trim());
        return codeChunks(l.text, codeW).map((code, part) => (
          <Text key={`${side}${part}`} backgroundColor={reindented ? undefined : DIFF_BACKGROUND[l.kind]} dimColor={l.expanded}>
            <Text dimColor>{`${part === 0 ? no : '    '} │ `}</Text>
            <Text color={color} dimColor={reindented}>
              {`${part === 0 ? sign : ' '} `}
            </Text>
            <SyntaxText text={code} spans={highlights?.[j]} column={part * codeW} emphasis={emphasis} emphasisColor={WORD_BACKGROUND[l.kind]} />
            {' '.repeat(Math.max(0, codeW - code.length))}
          </Text>
        ));
      };
      const blank = ' '.repeat(half);
      hunk.lines.forEach((l, i) => {
        if (props.hidden.has(i)) return;
        const beside = l.kind === 'add' && props.hidden.has(props.partner[i]) ? props.partner[i] : undefined;
        const left = cells(l.kind === 'add' ? beside : i, 'old');
        const right = cells(l.kind === 'del' ? undefined : i, 'new');
        for (let k = 0; k < Math.max(left.length, right.length); k++)
          out.push({
            idx: i,
            node: (
              <Text>
                {left[k] ?? blank}
                <Text dimColor>│</Text>
                {right[k] ?? blank}
              </Text>
            ),
          });
        if (beside !== undefined) notesUnder(beside, i);
        notesUnder(i, i);
      });
      return out;
    }
    hunk.lines.forEach((l, i) => {
      if (props.hidden.has(i)) return;
      // An added line whose removed partner is folded into it shows once, on a plain background:
      // marked ~ when only whitespace changed, or + with just the added words in green.
      const fold = props.hidden.get(props.partner[i]);
      const reindented = fold === 'whitespace';
      const kind = fold ? 'ctx' : l.kind;
      const no = `${(fold ? hunk.lines[props.partner[i]].oldLine : l.oldLine) ?? ''}`.padStart(4) + ' ' + `${l.newLine ?? ''}`.padStart(4);
      const sign = reindented ? '~' : l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
      const color = reindented ? undefined : l.kind === 'add' ? 'green' : l.kind === 'del' ? 'red' : undefined;
      const text = clean(l.text);
      const emphasis = reindented || l.kind === 'ctx' ? undefined : words[i]?.filter(([s, e]) => !props.ignoreWhitespace || text.slice(s, e).trim());
      codeChunks(l.text, width - GUTTER).forEach((code, part) =>
        out.push({
          idx: i,
          node: (
            <Text backgroundColor={DIFF_BACKGROUND[kind]} dimColor={l.expanded}>
              <Text dimColor>{`${part === 0 ? no : ' '.repeat(9)} │ `}</Text>
              <Text color={color} dimColor={reindented}>
                {`${part === 0 ? sign : ' '} `}
              </Text>
              <SyntaxText text={code} spans={highlights?.[i]} column={part * Math.max(1, width - GUTTER)} emphasis={emphasis} emphasisColor={WORD_BACKGROUND[l.kind]} />
            </Text>
          ),
        }),
      );
      notesUnder(i, i);
    });
    return out;
  }, [hunk, props.raw, props.split, props.partner, props.hidden, props.ignoreWhitespace, words, props.threads, props.drafts, width, highlights]);

  // Keep the cursor in view.
  const cursorRow = rows.findIndex((r) => r.idx === cursor);
  const cursorEnd = rows.findLastIndex((r) => r.idx === cursor);
  let top = props.scroll;
  if (cursorRow < top) top = cursorRow;
  if (cursorEnd >= top + height) top = cursorEnd - height + 1;
  top = Math.max(0, Math.min(top, Math.max(0, rows.length - height)));
  useEffect(() => {
    if (top !== props.scroll) props.setScroll(top);
  });

  const renderRow = (r: (typeof rows)[number], k: number) => {
    const inRange = range && r.idx >= range[0] && r.idx <= range[1];
    const first = rows[k - 1]?.idx !== r.idx;
    const isCursor = r.idx === cursor && first;
    return (
      <Box key={k}>
        <Text color={isCursor ? 'cyan' : inRange ? 'blue' : undefined}>{isCursor ? G.cursor : inRange ? G.range : ' '}</Text>
        {r.node}
      </Box>
    );
  };

  if (props.inline) {
    // Keep the commented line(s) in view with some context above, the editor right under them.
    const avail = Math.max(2, height - props.inline.height);
    const anchorRow = rows.reduce((last, r, i) => (r.idx <= props.inline!.afterIdx ? i : last), 0);
    const start = Math.max(0, anchorRow - Math.max(1, Math.floor(avail * 0.6)) + 1);
    const before = rows.slice(start, anchorRow + 1).map((r, k) => renderRow(r, start + k));
    const after = rows.slice(anchorRow + 1, anchorRow + 1 + Math.max(0, avail - before.length)).map((r, k) => renderRow(r, anchorRow + 1 + k));
    return (
      <Box flexDirection="column" width={width} flexShrink={0} height={height} overflow="hidden">
        {before}
        <Box flexShrink={0} paddingLeft={1}>
          {props.inline.node}
        </Box>
        {after}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} flexShrink={0} height={height} overflow="hidden">
      {rows.slice(top, top + height).map((r, k) => renderRow(r, top + k))}
      {rows.length > top + height ? <Text dimColor>{`  … ${rows.length - top - height} more`}</Text> : null}
    </Box>
  );
});
