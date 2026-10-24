import { useState } from 'react';
import { useInput } from './input.js';
import { Box, Text, useSelected } from './themed.js';
import { pad, truncate } from './nav.js';
import { Hints } from './KeyBar.js';
import { TextInput } from './TextInput.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';

// The command palette (`:`): every action on the screen with its shortcut, filtered as you type,
// and "go to" a file or chapter. Settings flipped once in a review live here first; their
// letters stay as shortcuts, which the palette names beside each command.

export interface PaletteItem {
  label: string;
  key?: string; // the shortcut, shown at the right
  detail?: string; // where a go-to lands, shown dim at the right
  run: () => void;
}

// The items every word of the query matches, in order: label words first, then the rest.
export function filterPalette(items: PaletteItem[], query: string): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  const text = (i: PaletteItem) => `${i.label} ${i.detail ?? ''} ${i.key ?? ''}`.toLowerCase();
  const matching = items.filter((i) => words.every((w) => text(i).includes(w)));
  // A command whose label starts with the query comes before one that only contains it.
  const starts = (i: PaletteItem) => i.label.toLowerCase().startsWith(words[0]);
  return [...matching.filter(starts), ...matching.filter((i) => !starts(i))];
}

export function CommandPalette(props: { items: PaletteItem[]; width: number; height: number; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const selectedRow = useSelected();
  const shown = filterPalette(props.items, query);
  const chosen = Math.min(sel, Math.max(0, shown.length - 1));
  const rows = Math.max(1, props.height - 3); // the query, the hints, a gap
  const top = Math.max(0, Math.min(chosen - Math.floor(rows / 2), shown.length - rows));
  useInput((_input, key) => {
    if (key.escape) return props.onClose();
    if (key.downArrow || (key.ctrl && _input === 'n')) return setSel(Math.min(shown.length - 1, chosen + 1));
    if (key.upArrow || (key.ctrl && _input === 'p')) return setSel(Math.max(0, chosen - 1));
    if (key.return && shown[chosen]) {
      props.onClose();
      shown[chosen].run();
    }
  });
  const inner = props.width - 2;
  const keyW = Math.max(0, ...shown.map((i) => (i.detail ?? i.key ?? '').length)) + 2;
  return (
    <Box flexDirection="column" paddingX={1} width={props.width}>
      <Box>
        <Text color="cyan" bold>
          {': '}
        </Text>
        <TextInput
          value={query}
          onChange={(v) => {
            setQuery(v);
            setSel(0);
          }}
          width={inner - 4}
          placeholder="a command, a file, or a chapter"
        />
      </Box>
      <Box flexDirection="column" height={rows} overflow="hidden">
        {shown.length ? (
          shown.slice(top, top + rows).map((item, k) => {
            const i = top + k;
            const right = item.detail ?? item.key ?? '';
            return (
              <Text key={`${item.label}:${i}`} {...selectedRow(i === chosen)} wrap="truncate">
                {pad(safe(` ${item.label}`), Math.max(8, inner - keyW))}
                {item.detail ? <Text dimColor>{truncate(right, keyW)}</Text> : <Text color="cyan">{right.padStart(keyW - 1)}</Text>}
              </Text>
            );
          })
        ) : (
          <Text dimColor> Nothing matches.</Text>
        )}
      </Box>
      <Hints
        keys={[
          ['↑↓', 'choose'],
          ['enter', 'run'],
          ['esc', 'close'],
        ]}
      />
    </Box>
  );
}
