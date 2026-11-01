import { useRef, useState } from 'react';
import { useInput } from '../input.js';
import { Box, Text, useSelected } from '../themed.js';
import { Hints } from '../KeyBar.js';
import { SourcePreview } from '../SourcePreview.js';
import { pad, truncate } from '../nav.js';
import { sanitizeTerminal as safe } from '../../util/sanitize.js';
import type { BlastItem } from '../../types.js';

// The hunk's blast radius (B): each place in a file the PR leaves alone that uses what the hunk
// changes, matched by name, with the source around the chosen one under the list.

const CHANGE: Record<NonNullable<BlastItem['change']>, string> = { signature: 'signature changed', table: 'table changed', event: 'event changed' };

export function CallersPanel(props: { items: BlastItem[]; root?: string; width: number; height: number; onClose: () => void }) {
  const rows = props.items.flatMap((b) => b.callers.map((c) => ({ item: b, caller: c })));
  const [sel, setSel] = useState(0);
  const selRef = useRef(0); // keys that arrive together each see the last move
  const selectedRow = useSelected();
  useInput((input, key) => {
    if (key.escape || input === 'q' || input === 'B') return props.onClose();
    const move = (by: number) => {
      selRef.current = Math.max(0, Math.min(rows.length - 1, selRef.current + by));
      setSel(selRef.current);
    };
    if (input === 'j' || key.downArrow) return move(1);
    if (input === 'k' || key.upArrow) return move(-1);
  });
  const w = props.width - 2;
  const listRows = Math.max(1, Math.min(rows.length, Math.floor((props.height - 3) / 3)));
  const previewRows = Math.max(0, props.height - 4 - listRows);
  const top = Math.max(0, Math.min(sel - Math.floor(listRows / 2), rows.length - listRows));
  const symbolW = Math.min(28, Math.max(...rows.map((r) => r.item.symbol.length)) + 2);
  const whereW = Math.min(36, Math.max(...rows.map((r) => `${r.caller.file}:${r.caller.line}`.length)) + 2);
  const chosen = rows[sel];
  const symbols = props.items.map((b) => `${b.symbol}${b.change ? ` (${CHANGE[b.change]})` : ''}`).join(', ');
  return (
    <Box flexDirection="column" width={props.width} height={props.height} paddingX={1}>
      <Text dimColor wrap="truncate">
        {safe(`Uses of ${symbols} in files this PR doesn’t change, matched by name`)}
      </Text>
      <Box flexDirection="column" height={listRows} overflow="hidden" flexShrink={0}>
        {rows.slice(top, top + listRows).map(({ item, caller }, k) => {
          const i = top + k;
          return (
            <Text key={`${item.symbol}:${caller.file}:${caller.line}`} {...selectedRow(i === sel)} wrap="truncate">
              <Text color={item.change ? 'yellow' : undefined}>{pad(` ${truncate(safe(item.symbol), symbolW - 2)}`, symbolW)}</Text>
              <Text color="cyan">{pad(truncate(safe(`${caller.file}:${caller.line}`), whereW - 2), whereW)}</Text>
              {pad(safe(caller.text), Math.max(8, w - symbolW - whereW))}
            </Text>
          );
        })}
      </Box>
      {chosen && previewRows >= 3 ? (
        <Box marginTop={1} flexShrink={0}>
          <SourcePreview root={props.root} path={chosen.caller.file} startLine={chosen.caller.line} title={safe(`${chosen.caller.file}:${chosen.caller.line}`)} width={w} height={previewRows} />
        </Box>
      ) : null}
      <Box flexGrow={1} />
      <Hints
        keys={[
          ['j/k', 'choose'],
          ['esc', 'close'],
        ]}
      />
    </Box>
  );
}
