import { useEffect, useRef, useState } from 'react';
import { useInput } from '../input.js';
import { Box, Text, useSelected } from '../themed.js';
import { Hints, type Hint } from '../KeyBar.js';
import { pad, truncate } from '../nav.js';
import { age } from '../PickerScreen.js';
import { sanitizeTerminal as safe } from '../../util/sanitize.js';
import type { HistoryEntry } from '../../review/history.js';

// The history of the selected lines (H): the commits that last changed them before the PR,
// newest first. Enter shows a commit's change to them under the list; o opens its PR.

export function HistoryPanel(props: {
  title: string; // the lines, as "src/x.ts:44-52 at base"
  load: () => Promise<HistoryEntry[]>;
  width: number;
  height: number;
  onOpenPR?: (pr: number) => void; // o, when a commit names its PR
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry[] | { error: string }>();
  const [sel, setSel] = useState(0);
  const selRef = useRef(0); // keys that arrive together (j then enter) each see the last move
  const [open, setOpen] = useState<number>(); // the entry whose change shows
  const [scroll, setScroll] = useState(0);
  const selectedRow = useSelected();
  useEffect(() => {
    let live = true;
    props.load().then(
      (e) => live && setEntries(e),
      (e: unknown) => live && setEntries({ error: (e as Error).message }),
    );
    return () => {
      live = false;
    };
    // Loaded once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const list = Array.isArray(entries) ? entries : [];
  const listRows = Math.max(1, Math.min(list.length || 1, open === undefined ? props.height - 3 : Math.floor((props.height - 3) / 3)));
  const patch = open !== undefined ? (list[open]?.patch ?? '').split('\n') : [];
  const patchRows = Math.max(0, props.height - 4 - listRows);
  useInput((input, key) => {
    if (key.escape || input === 'q' || input === 'H') return open !== undefined && key.escape ? setOpen(undefined) : props.onClose();
    const move = (by: number) => {
      selRef.current = Math.max(0, Math.min(list.length - 1, selRef.current + by));
      setSel(selRef.current);
      if (open !== undefined) {
        setOpen(selRef.current);
        setScroll(0);
      }
    };
    if (input === 'j' || key.downArrow) return move(1);
    if (input === 'k' || key.upArrow) return move(-1);
    if (key.return && list[selRef.current]) {
      setScroll(0);
      return setOpen((o) => (o === selRef.current ? undefined : selRef.current));
    }
    if (input === 'J' || key.pageDown) return setScroll((s) => Math.min(Math.max(0, patch.length - patchRows), s + Math.max(1, patchRows - 1)));
    if (input === 'K' || key.pageUp) return setScroll((s) => Math.max(0, s - Math.max(1, patchRows - 1)));
    if (input === 'o' && props.onOpenPR) {
      const pr = list[selRef.current]?.pr;
      if (pr) props.onOpenPR(pr);
    }
  });

  const w = props.width - 2;
  const top = Math.max(0, Math.min(sel - Math.floor(listRows / 2), list.length - listRows));
  const keys: Hint[] = [
    ['j/k', 'choose'],
    ['enter', open !== undefined ? 'hide the change' : 'show the change'],
    ...((props.onOpenPR && list[sel]?.pr ? [['o', 'open the PR']] : []) as Hint[]),
    ...((open !== undefined ? [['J/K', 'scroll']] : []) as Hint[]),
    ['esc', open !== undefined ? 'back to the list' : 'close'],
  ];
  return (
    <Box flexDirection="column" width={props.width} height={props.height} paddingX={1}>
      <Text dimColor wrap="truncate">
        {safe(props.title)}
      </Text>
      <Box flexDirection="column" height={listRows} overflow="hidden" flexShrink={0}>
        {!entries ? <Text dimColor>Reading the history…</Text> : null}
        {entries && !Array.isArray(entries) ? <Text dimColor>{truncate(`Couldn’t read the history: ${safe(entries.error)}`, w)}</Text> : null}
        {Array.isArray(entries) && !entries.length ? <Text dimColor>No earlier commit changed these lines.</Text> : null}
        {list.slice(top, top + listRows).map((e, k) => {
          const i = top + k;
          const when = age(new Date(e.at * 1000).toISOString()).replace(/ ago$/, '');
          const left = ` ${when.padStart(4)}  ${pad(`@${e.author}`, 14)} `;
          const pr = e.pr ? `#${e.pr}` : '';
          return (
            <Text key={e.sha} {...selectedRow(i === sel)} wrap="truncate">
              <Text dimColor>{safe(left)}</Text>
              {pad(safe(e.subject), Math.max(8, w - left.length - pr.length - 1))}
              <Text color="cyan">{pr}</Text>
            </Text>
          );
        })}
      </Box>
      {open !== undefined ? (
        <Box flexDirection="column" height={patchRows} overflow="hidden" marginTop={1}>
          {patch.slice(scroll, scroll + patchRows).map((l, i) => (
            <Text
              key={scroll + i}
              wrap="truncate"
              color={l.startsWith('+') && !l.startsWith('+++') ? 'green' : l.startsWith('-') && !l.startsWith('---') ? 'red' : undefined}
              dimColor={/^(diff|---|\+\+\+|@@)/.test(l)}
            >
              {safe(l.replace(/\t/g, '  ')) || ' '}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box flexGrow={1} />
      <Hints keys={keys} />
    </Box>
  );
}
