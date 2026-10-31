import { useMemo, useState } from 'react';
import { useInput } from '../input.js';
import { Box, Text, useSelected } from '../themed.js';
import { Hints } from '../KeyBar.js';
import { TextInput } from '../TextInput.js';
import { pad, truncate } from '../nav.js';
import { sanitizeTerminal as safe } from '../../util/sanitize.js';
import { plural } from '../plural.js';
import { searchTour, type SearchHit } from './search.js';
import type { Chapter, Tour } from '../../types.js';

// What `/` remembers between opens, so the next match is ↓ and enter away.
export interface LastSearch {
  query: string;
  sel: number;
}

const MARK: Record<SearchHit['kind'], string> = { add: '+', del: '-', ctx: ' ', explanation: '¶' };
const MARK_COLOR: Record<SearchHit['kind'], string | undefined> = { add: 'green', del: 'red', ctx: undefined, explanation: 'magenta' };

export function SearchPanel(props: {
  tour: Pick<Tour, 'hunks'>;
  chapters: Chapter[];
  last: LastSearch;
  width: number;
  height: number;
  onClose: (last: LastSearch) => void;
  onGo: (hit: SearchHit, last: LastSearch) => void;
}) {
  const [query, setQuery] = useState(props.last.query);
  const [sel, setSel] = useState(props.last.sel);
  const selectedRow = useSelected();
  const { hits, total } = useMemo(() => searchTour(props.tour, props.chapters, query), [props.tour, props.chapters, query]);
  const chosen = Math.min(sel, Math.max(0, hits.length - 1));
  const rows = Math.max(1, props.height - 3); // the query, the hints, a gap
  const top = Math.max(0, Math.min(chosen - Math.floor(rows / 2), hits.length - rows));
  useInput((input, key) => {
    if (key.escape) return props.onClose({ query, sel: chosen });
    if (key.downArrow || (key.ctrl && input === 'n')) return setSel(Math.min(hits.length - 1, chosen + 1));
    if (key.upArrow || (key.ctrl && input === 'p')) return setSel(Math.max(0, chosen - 1));
    if (key.return && hits[chosen]) props.onGo(hits[chosen], { query, sel: chosen });
  });
  const inner = props.width - 2;
  const chapterCount = new Set(hits.map((h) => h.ci)).size;
  const count = query ? (hits.length ? `${total > hits.length ? `first ${hits.length} of ${total}` : plural(total, 'match', 'matches')} · ${plural(chapterCount, 'chapter')}` : 'no matches') : '';
  const whereW = Math.min(32, Math.max(8, ...hits.slice(top, top + rows).map((h) => h.where.length)) + 2);
  const chW = 7;
  const textW = Math.max(8, inner - whereW - chW - 3);
  return (
    <Box flexDirection="column" paddingX={1} width={props.width}>
      <Box>
        <Text color="cyan" bold>
          {'/ '}
        </Text>
        <TextInput
          value={query}
          onChange={(v) => {
            setQuery(v);
            setSel(0);
          }}
          width={Math.max(8, inner - 4 - count.length - 1)}
          placeholder="text in this diff or its explanations, not the whole codebase"
        />
        <Text dimColor> {count}</Text>
      </Box>
      <Box flexDirection="column" height={rows} overflow="hidden">
        {hits.slice(top, top + rows).map((h, k) => {
          const i = top + k;
          // The line from a little before the match, so the match is in view. Cut at the match's
          // offsets first: sanitizing can change the length.
          const from = Math.max(0, h.at - Math.floor(textW / 3));
          const before = (from > 0 ? '…' : '') + safe(h.text.slice(from, h.at).replace(/\t/g, ' ')).slice(0, textW - 1);
          const match = safe(h.text.slice(h.at, h.at + query.length)).slice(0, Math.max(0, textW - before.length));
          const after = truncate(h.text.slice(h.at + query.length), textW - before.length - match.length);
          return (
            <Text key={`${h.hunkId}:${h.line ?? h.text}:${i}`} {...selectedRow(i === chosen)} wrap="truncate">
              {pad(` ${truncate(safe(h.where), whereW - 2)}`, whereW)}
              <Text color={MARK_COLOR[h.kind]}>{MARK[h.kind]} </Text>
              {before}
              <Text color="cyan" bold>
                {match}
              </Text>
              {pad(after, textW - before.length - match.length)}
              <Text dimColor>{` ch ${h.ci + 1}`}</Text>
            </Text>
          );
        })}
      </Box>
      <Hints
        keys={[
          ['↑↓', 'choose'],
          ['enter', 'go'],
          ['esc', 'close'],
        ]}
      />
    </Box>
  );
}
