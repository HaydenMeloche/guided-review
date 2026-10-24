import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useInput, usePaste } from 'ink';
import { Box, Text } from './themed.js';
import { truncate, wrap } from './nav.js';
import { sanitizeTerminal } from '../util/sanitize.js';
import {
  ACTIONS_HINT,
  fieldSegments,
  findCompletion,
  mentionCompleter,
  type Completer,
  type CompletionHint,
  type CompletionItem,
  type CompletionPreview,
  type HintPart,
  type RowSegment,
  type TokenKind,
  type TokenRule,
} from './completion.js';

export { mentionTrigger, referenceTrigger, type Completer, type CompletionItem, type CompletionPreview } from './completion.js';

// Rows for the list and its hint lines together: a second hint line takes one from the list, so
// an open list never grows the composer.
const LIST_ROWS = 6;
const DEBOUNCE_MS = 100;
// From this width a row's preview sits beside the list; below it, under the list.
export const PREVIEW_SIDE_MIN = 90;
const STACKED_PREVIEW_ROWS = 5;
const MAX_SIDE_LIST_ROWS = 12;

export interface PreviewProps extends CompletionPreview {
  cursor?: number; // a line cursor while choosing lines
  sel?: [number, number] | null;
  width: number;
  height: number;
}

interface Results {
  key: string;
  items: CompletionItem[];
  pending: boolean;
}

// Minimal editable text field: typing, paste, backspace, ←/→, Ctrl+A/E/U/W.
// Ctrl+J (or Shift+Enter, where the terminal reports it) inserts a newline. Enter calls onSubmit.
//
// Completion: when a completer's trigger matches the text before the cursor, a list opens
// under the field. ↑/↓ choose, Tab or Enter insert (Enter does not submit), Esc closes only
// the list. Ink calls every active useInput handler, so a parent with its own keys (Esc to
// cancel, say) keeps the flag from onCompleting in state and skips them while it is true.
//
// A completer's `instant` rows show at once, above its async rows and while those load; rows
// with a `group` are headed by a dim group name that the selection skips.
//
// A row with a `preview` shows it through renderPreview (or its `text`, as it is), beside the
// list on a wide field and under it on a narrow one. While the list is open ←/→ belong to it,
// not the text cursor: → focuses a file preview to choose lines (j/k, J/K, v range, Enter
// inserts them through the completer's pickLines), and ← or Esc returns to the list.
//
// A `keepOpen` row (a filter) replaces the query and leaves the list open on the new one.
export function TextInput(props: {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: (v: string) => void;
  placeholder?: string;
  width: number;
  active?: boolean;
  maxRows?: number;
  mentions?: string[];
  onTab?: (reverse: boolean) => void;
  // Controlled cursor, so a parent can keep it while this field is inactive or unmounted.
  cursor?: number;
  onCursor?: (n: number) => void;
  completers?: Completer[];
  onCompleting?: (open: boolean) => void;
  highlightTokens?: TokenRule[]; // e.g. code spans that name a reference, known @mentions
  // Rows the owner gives the open list, its preview and hint lines together; more than the
  // usual goes to the preview, so more of the code shows.
  listHeight?: number;
  renderPreview?: (p: PreviewProps) => React.ReactNode;
}) {
  const { value, onChange, active = true } = props;
  const [ownCursor, setOwnCursor] = useState(value.length);
  const c = Math.min(props.cursor ?? ownCursor, value.length);
  const setCursor = (n: number) => {
    if (props.cursor === undefined) setOwnCursor(n);
    props.onCursor?.(n);
  };

  const { mentions, completers: given } = props;
  const completers = useMemo(() => [...(given ?? []), ...(mentions?.length ? [mentionCompleter(mentions)] : [])], [given, mentions]);
  const match = active ? findCompletion(completers, value.slice(0, c)) : undefined;
  const tokenKey = match ? `${match.index}:${match.start}` : '';
  const matchKey = match ? `${tokenKey}:${match.query}` : '';
  const [results, setResults] = useState<Results>({ key: '', items: [], pending: false });
  const [dismissed, setDismissed] = useState('');
  // A token the cursor was moved onto (arrows, Ctrl+A/E) rather than typed: no list for it
  // until its text changes, so moving through the text never stops at a list. A field that
  // opens with the cursor after a token (editing a saved draft) starts the same way.
  const quiet = useRef<string | null>(null);
  quiet.current ??= matchKey;
  const [sel, setSel] = useState(0);
  const [focus, setFocus] = useState<'list' | 'lines'>('list');
  const [lines, setLines] = useState<{ cursor: number; anchor: number | null; count: number }>({ cursor: 1, anchor: null, count: 0 });
  const request = useRef(0);
  // Keyed by position and trigger, since parents often pass a fresh completers array.
  const seenAsync = useRef(new Set<string>());
  const asyncKey = match ? `${match.index}:${completers[match.index].trigger.source}` : '';
  const latest = useRef({ completers, match });
  latest.current = { completers, match };

  // Sync completers answer at once. Once a completer has returned a promise, later queries
  // wait for typing to pause, and a reply for an older query is dropped.
  useEffect(() => {
    const id = ++request.current;
    const { completers, match } = latest.current;
    setSel(0);
    setFocus('list');
    if (!match || matchKey === quiet.current) {
      setDismissed('');
      return setResults({ key: '', items: [], pending: false });
    }
    const completer = completers[match.index];
    const kind = `${match.index}:${completer.trigger.source}`;
    // While searching, keep showing this token's previous rows.
    const searching = (prev: Results): Results => ({ key: matchKey, items: prev.key.startsWith(`${match.index}:${match.start}:`) ? prev.items : [], pending: true });
    const run = () => {
      const r = completer.items(match.query);
      if (Array.isArray(r)) return setResults({ key: matchKey, items: r, pending: false });
      seenAsync.current.add(kind);
      setResults(searching);
      r.then(
        (items) => id === request.current && setResults({ key: matchKey, items, pending: false }),
        () => id === request.current && setResults({ key: matchKey, items: [], pending: false }),
      );
    };
    if (!seenAsync.current.has(kind)) return run();
    setResults(searching);
    const t = setTimeout(run, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [matchKey]);

  const fresh = results.key === matchKey;
  const completer = match ? completers[match.index] : undefined;
  const silent = !match || dismissed === tokenKey || quiet.current === matchKey;
  // Instant rows come straight from the query, in this render, so nothing waits on the search.
  const now = match && !silent && completer?.instant ? completer.instant(match.query) : [];
  // Until the effect answers, keep the same token's previous rows so the list doesn't blink.
  const later = fresh || (match && results.key.startsWith(tokenKey + ':')) ? results.items : [];
  const items = now.length ? [...now, ...later] : later;
  // Before the effect answers a new query, only an async completer counts as searching.
  const pending = !!match && (fresh ? results.pending : seenAsync.current.has(asyncKey));
  const open = !silent && (pending || items.length > 0);
  const chosen = Math.min(sel, Math.max(0, items.length - 1));
  const current = open ? items[chosen] : undefined;
  const preview = props.renderPreview ? current?.preview : undefined;
  const inLines = !!preview && focus === 'lines';
  const lineSel = (): [number, number] => (lines.anchor === null ? [lines.cursor, lines.cursor] : [Math.min(lines.anchor, lines.cursor), Math.max(lines.anchor, lines.cursor)]);

  const onCompleting = useRef(props.onCompleting);
  onCompleting.current = props.onCompleting;
  useEffect(() => {
    if (!open) return;
    onCompleting.current?.(true);
    return () => onCompleting.current?.(false);
  }, [open]);

  const moveTo = (n: number) => {
    const m = findCompletion(completers, value.slice(0, n));
    quiet.current = m ? `${m.index}:${m.start}:${m.query}` : '';
    setCursor(n);
  };

  const insert = (s: string) => {
    onChange(value.slice(0, c) + s + value.slice(c));
    setCursor(c + s.length);
  };

  const pick = (item: CompletionItem) => {
    if (!match) return;
    onChange(value.slice(0, match.start) + item.insert + value.slice(c));
    setCursor(match.start + item.insert.length);
    // An inserted item may still match its trigger; keep the list shut until the token ends.
    if (!item.keepOpen) setDismissed(tokenKey);
    item.onPick?.();
  };

  // Pasted text that ends in a trigger (a diff header ends in "@@") doesn't open the list.
  usePaste(
    (text) => {
      const pasted = text.replace(/\r\n?/g, '\n');
      const after = findCompletion(completers, value.slice(0, c) + pasted);
      if (after) setDismissed(`${after.index}:${after.start}`);
      insert(pasted);
    },
    { isActive: active },
  );

  // →: choose lines in the highlighted row's preview, starting at its first marked line.
  const enterLines = () => {
    if (!preview || preview.text !== undefined || !completer?.pickLines) return;
    const count = completer.lineCount?.(preview.path) ?? 0;
    if (!count) return;
    setLines({ cursor: Math.min(count, preview.startLine ?? 1), anchor: null, count });
    setFocus('lines');
  };
  const moveLine = (by: number) => setLines((l) => ({ ...l, cursor: Math.max(1, Math.min(l.count, l.cursor + by)) }));

  useInput(
    (input, key) => {
      if (inLines && current) {
        if (key.escape || key.leftArrow) return setFocus('list');
        if (key.upArrow || input === 'k') return moveLine(-1);
        if (key.downArrow || input === 'j') return moveLine(1);
        if (key.pageUp || input === 'K') return moveLine(-10);
        if (key.pageDown || input === 'J') return moveLine(10);
        if (input === 'v') return setLines((l) => ({ ...l, anchor: l.anchor === null ? l.cursor : null }));
        if (key.return && !key.shift) {
          const [s, e] = lineSel();
          const picked = completer?.pickLines?.(current, s, e);
          // Only the lines' own pick runs: one already referenced has none, and the row's would
          // attach the row's target instead.
          if (picked) pick({ ...current, insert: picked.insert, onPick: picked.onPick });
        }
        return; // the text stays as it is while lines are being chosen
      }
      if (open) {
        if (key.escape) return setDismissed(tokenKey);
        if (key.upArrow) return setSel(Math.max(0, chosen - 1));
        if (key.downArrow) return setSel(Math.min(items.length - 1, chosen + 1));
        if (key.tab || (key.return && !key.shift)) return items[chosen] ? pick(items[chosen]) : undefined;
        if (key.rightArrow) return enterLines();
        if (key.leftArrow) return;
      }
      if (key.return && !key.shift) return props.onSubmit?.(value);
      if (key.tab) return props.onTab?.(key.shift);
      if ((key.return && key.shift) || (key.ctrl && input === 'j')) return insert('\n');
      if (key.leftArrow) return moveTo(Math.max(0, c - 1));
      if (key.rightArrow) return moveTo(Math.min(value.length, c + 1));
      if (key.backspace || key.delete) {
        if (c === 0) return;
        onChange(value.slice(0, c - 1) + value.slice(c));
        return setCursor(c - 1);
      }
      if (key.ctrl && input === 'a') return moveTo(0);
      if (key.ctrl && input === 'e') return moveTo(value.length);
      if (key.ctrl && input === 'u') {
        onChange(value.slice(c));
        return setCursor(0);
      }
      if (key.ctrl && input === 'w') {
        const before = value.slice(0, c).replace(/\S+\s*$/, '');
        onChange(before + value.slice(c));
        return setCursor(before.length);
      }
      if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow) return;
      if (input) insert(input);
    },
    { isActive: active },
  );

  if (!value && props.placeholder) {
    return (
      <Text>
        {active ? <Text inverse> </Text> : null}
        <Text dimColor>{props.placeholder}</Text>
      </Text>
    );
  }
  // The value can be pasted or prefilled from untrusted text, so strip terminal controls
  // before inserting the \u0000 cursor marker (which sanitizeTerminal would also remove).
  const shown = active ? sanitizeTerminal(value.slice(0, c)) + '\u0000' + sanitizeTerminal(value.slice(c)) : sanitizeTerminal(value);
  // Fences are found on every row, then only the last maxRows are shown.
  const rows = fieldSegments(wrap(shown, Math.max(10, props.width)), props.highlightTokens).slice(props.maxRows ? -props.maxRows : 0);
  const field = (
    <Text>
      {rows.map((segs, i) => (
        <React.Fragment key={i}>
          <Row segments={segs} />
          {i < rows.length - 1 ? '\n' : ''}
        </React.Fragment>
      ))}
    </Text>
  );
  if (!open) return field;
  const own = hintOf(completer, current, match?.query ?? '');
  const hint: CompletionHint = inLines ? { ...own, actions: `j/k line · v ${lines.anchor === null ? 'start range' : 'end range'} · enter insert lines · ←/esc back to list` } : own;
  const listRows = LIST_ROWS - (hint.help ? 1 : 0);
  const hints = <HintLines hint={hint} width={props.width} />;
  if (!preview || !props.renderPreview) {
    return (
      <Box flexDirection="column">
        {field}
        <CompletionList items={items} chosen={chosen} pending={pending} pendingGroup={completer?.pendingGroup} width={props.width} rows={listRows} />
        {hints}
      </Box>
    );
  }
  const side = props.width >= PREVIEW_SIDE_MIN;
  const listW = side ? Math.min(56, Math.max(30, Math.floor(props.width * 0.4))) : props.width;
  const previewW = side ? props.width - listW - 1 : props.width;
  // The area above the hint lines: the list (and, stacked, the preview under it).
  const area = (props.listHeight ?? 0) - (hint.help ? 2 : 1);
  const previewH = side ? Math.max(listRows + 1, area) : Math.max(STACKED_PREVIEW_ROWS, area - listRows);
  // Beside a taller preview the list can show more rows too.
  const sideRows = side ? Math.max(listRows, Math.min(previewH - 1, MAX_SIDE_LIST_ROWS)) : listRows;
  const previewNode =
    preview.text !== undefined ? (
      <TextPreview title={preview.path} text={preview.text} width={previewW} height={previewH} />
    ) : (
      props.renderPreview({
        ...preview,
        ...(inLines ? { cursor: lines.cursor, sel: lines.anchor === null ? null : lineSel() } : {}),
        width: previewW,
        height: previewH,
      })
    );
  return (
    <Box flexDirection="column">
      {field}
      {side ? (
        <Box flexDirection="row">
          <Box width={listW} flexDirection="column">
            <CompletionList items={items} chosen={chosen} pending={pending} pendingGroup={completer?.pendingGroup} width={listW} rows={sideRows} dim={inLines} />
          </Box>
          <Box width={1} />
          {previewNode}
        </Box>
      ) : (
        <>
          <CompletionList items={items} chosen={chosen} pending={pending} pendingGroup={completer?.pendingGroup} width={props.width} rows={listRows} dim={inLines} />
          {previewNode}
        </>
      )}
      {hints}
    </Box>
  );
}

function hintOf(completer: Completer | undefined, item: CompletionItem | undefined, query: string): CompletionHint {
  const h = typeof completer?.hint === 'function' ? completer.hint(item, query) : completer?.hint;
  return typeof h === 'string' ? { actions: h } : (h ?? { actions: ACTIONS_HINT });
}

// The hint lines, cut to `width` rather than wrapped. Hint text may come from a query, so it is
// sanitized like the rest.
function HintLines(props: { hint: CompletionHint; width: number }) {
  const { hint, width } = props;
  let room = Math.max(0, width);
  const parts: HintPart[] = [];
  for (const p of hint.help ?? []) {
    const text = sanitizeTerminal(p.text).slice(0, room);
    if (!text) break;
    parts.push({ ...p, text });
    room -= text.length;
  }
  return (
    <>
      <Text dimColor wrap="truncate">
        {truncate(hint.actions, width)}
      </Text>
      {hint.help ? (
        <Text wrap="truncate">
          {parts.map((p, i) =>
            p.accent ? (
              <Text key={i} color="cyan">
                {p.text}
              </Text>
            ) : (
              <Text key={i} dimColor>
                {p.text}
              </Text>
            ),
          )}
        </Text>
      ) : null}
    </>
  );
}

// A row's text shown as it is (a review thread's comments), wrapped and cut to fit.
function TextPreview(props: { title: string; text: string; width: number; height: number }) {
  const { width, height } = props;
  const body = wrap(sanitizeTerminal(props.text), Math.max(10, width)).slice(0, Math.max(1, height - 1));
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Text dimColor wrap="truncate">
        {truncate(props.title, width)}
      </Text>
      {body.map((l, i) => (
        <Text key={i} wrap="truncate">
          {truncate(l, width)}
        </Text>
      ))}
    </Box>
  );
}

const TOKEN_COLOR: Record<TokenKind, string> = { ref: 'cyan', mention: 'blue' };

function Row(props: { segments: RowSegment[] }) {
  const { segments } = props;
  if (segments.length === 1 && !segments[0].cursor && !segments[0].token) return <>{segments[0].text}</>;
  return (
    <>
      {segments.map((seg) => (
        <Text key={seg.start} inverse={seg.cursor} color={seg.token ? TOKEN_COLOR[seg.token] : undefined}>
          {seg.text}
        </Text>
      ))}
    </>
  );
}

type ListRow = { item: CompletionItem; index: number } | { header: string };

// The list's rows: each item, with its group's name above the first item of a group. A lone
// group goes unheaded: the header only tells groups apart.
function listRows(items: CompletionItem[], headed: boolean): ListRow[] {
  const rows: ListRow[] = [];
  items.forEach((item, index) => {
    if (headed && item.group && item.group !== items[index - 1]?.group) rows.push({ header: item.group });
    rows.push({ item, index });
  });
  return rows;
}

// `dim`: lines are being chosen in the preview, so the selection is shown dimmed.
function CompletionList(props: { items: CompletionItem[]; chosen: number; pending: boolean; pendingGroup?: string; width: number; rows: number; dim?: boolean }) {
  const { items, chosen, width } = props;
  const groups = new Set(items.map((i) => i.group).filter(Boolean));
  if (props.pending && props.pendingGroup) groups.add(props.pendingGroup);
  const headed = groups.size > 1;
  const rows = listRows(items, headed);
  // "searching…" sits in the group still loading, under that group's header if it has no rows yet.
  const pendingHeader = headed && props.pending && props.pendingGroup && items[items.length - 1]?.group !== props.pendingGroup ? props.pendingGroup : undefined;
  const room = props.rows - (props.pending ? 1 : 0) - (pendingHeader ? 1 : 0);
  const at = rows.findIndex((r) => 'item' in r && r.index === chosen);
  const top = Math.max(0, Math.min(at - room + 1, rows.length - room));
  return (
    <Box flexDirection="column">
      {rows.slice(top, top + room).map((row) => {
        if ('header' in row)
          return (
            <Text key={`h:${row.header}`} dimColor wrap="truncate">
              {truncate(row.header, width)}
            </Text>
          );
        const { item } = row;
        const selected = row.index === chosen;
        // truncate strips terminal controls, so item text from a repo is safe to show.
        const label = truncate(item.label, width - 2);
        const detail = item.detail ? truncate(item.detail, width - 4 - label.length) : '';
        return (
          <Text key={item.key} wrap="truncate">
            <Text color={selected ? 'cyan' : undefined} inverse={selected && !props.dim} dimColor={selected && props.dim}>
              {(selected ? '▸ ' : '  ') + label}
            </Text>
            {detail ? <Text dimColor>{'  ' + detail}</Text> : null}
          </Text>
        );
      })}
      {pendingHeader ? (
        <Text dimColor wrap="truncate">
          {truncate(pendingHeader, width)}
        </Text>
      ) : null}
      {props.pending ? <Text dimColor>{'  searching…'}</Text> : null}
    </Box>
  );
}
