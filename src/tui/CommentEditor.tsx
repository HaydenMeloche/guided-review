import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { useApp, useInput } from 'ink';
import { Box, Text } from './themed.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommentLabel, Draft, Hunk } from '../types.js';
import { lineOn } from '../review/submit.js';
import { suggestionApplicability } from '../review/suggestion.js';
import { TextInput, type PreviewProps } from './TextInput.js';
import { mentionHighlight } from './completion.js';
import { AI_BODY_ROWS, AiSuggestionView, aiChromeRows, aiKeys, useAiSuggestion } from './AiSuggestion.js';
import { SourcePreview } from './SourcePreview.js';
import { anchorText, draftFrom, initComposer, isLineAnchor, linesWord, suggestionMetaFor, suggestionStillApplies, type ComposerEnv, type ComposerState, type SetComposer } from './composer.js';
import { mergeRefs, referenceCompleter, refHighlight, refTarget } from './references.js';
import { truncate } from './nav.js';
import { SURFACES } from './theme.js';
import { KeyBar, type Hint } from './KeyBar.js';
import { openInEditor } from '../util/editor.js';
import { sanitizeTerminal } from '../util/sanitize.js';

const LABELS: CommentLabel[] = ['blocking', 'question', 'suggestion', 'nit'];
export const LABEL_COLOR: Record<CommentLabel, string> = { blocking: 'red', question: 'blue', suggestion: 'cyan', nit: 'gray' };

// A comment's label as a colored chip, the same in the composer, under the line, and on the
// submit screen, so a blocking comment looks the same in all three.
export function LabelChip(props: { label: CommentLabel; selected?: boolean }) {
  return (
    <Text backgroundColor={SURFACES.popup} color={LABEL_COLOR[props.label]} inverse={props.selected} bold={props.selected}>
      {` ${props.label} `}
    </Text>
  );
}

// Below this many rows the composer is the compact inline editor; above it, the full one
// with the suggestion diff.
const FULL_ROWS = 18;
const INLINE_FALLBACK = 20; // rows assumed for the AI proposal when the owner gives none
const AI_HINT = 'suggest a code change with AI';
const AI_HINT_SHORT = 'suggest a fix with AI';
const DISCARD_MS = 2000;
const COMPACT_CHROME = 7;

export type { SetComposer };

// The comment composer. Text mode is the editor as it always was: Tab cycles the label,
// Enter saves, Ctrl+G edits a code suggestion in $EDITOR. `@` mentions people or references
// code (inserted as a code span naming the ref), with a completion list, filters for callers,
// tests, threads and recent places, and a preview; Ctrl+T opens the AI line under the body.
// `mode` decides which one owns the keys, and Esc closes the innermost layer first.
export function CommentEditor(props: {
  draft: Draft;
  target: string; // human description of the anchor
  hunk?: Hunk;
  selectedText?: string; // the anchored lines, prefilled into a suggestion
  width: number;
  height?: number; // rows available; enough of them shows the full composer
  mentions?: string[];
  env?: ComposerEnv;
  // Controlled state, so the owner can move the composer on screen without losing it.
  state?: ComposerState;
  setState?: SetComposer;
  aiRows?: number; // rows for the AI line and its proposal in the compact composer
  listRows?: number; // rows for an open @ list and its preview in the compact composer
  onSave: (d: Draft) => void;
  onCancel: () => void;
}) {
  const { suspendTerminal } = useApp();
  const { env } = props;
  const [own, setOwn] = useState<ComposerState>(() => initComposer(props.draft, { index: env?.repoIndex?.() }));
  const st = props.state ?? own;
  const set: SetComposer = props.setState ?? ((f) => setOwn(f));
  const patch = (p: Partial<ComposerState>) => set((s) => ({ ...s, ...p }));
  const [completing, setCompleting] = useState(false); // TextInput's list owns Esc while open
  // Esc on typed text asks once: a second Esc within DISCARD_MS discards it.
  const [discardArmed, setDiscardArmed] = useState(false);
  useEffect(() => {
    if (!discardArmed) return;
    const t = setTimeout(() => setDiscardArmed(false), DISCARD_MS);
    return () => clearTimeout(t);
  }, [discardArmed]);
  const latest = useRef(st);
  latest.current = st;

  const { anchor, mode } = st;
  const tour = env?.tour;
  const lineAnchor = isLineAnchor(anchor) ? anchor : undefined;
  const hunk = (lineAnchor && tour?.hunks[lineAnchor.hunkId]) || props.hunk;
  const canSuggest = !!lineAnchor;
  // The prefill for a new suggestion: the lines the anchor replaces now (it may have moved).
  const selected = (tour && anchorText(tour, anchor)) ?? props.selectedText;

  // What `@callers:` and `@tests:` look at: the anchored hunk and line, as they are now.
  const anchored = useRef({ hunk, file: lineAnchor?.file, line: lineAnchor?.line });
  anchored.current = { hunk, file: lineAnchor?.file, line: lineAnchor?.line };
  const completers = useMemo(
    () =>
      env
        ? [
            referenceCompleter({
              index: st.index,
              root: env.root,
              headSha: env.tour.headSha,
              mentions: props.mentions,
              changedFiles: env.tour.files.map((f) => f.path),
              refs: () => latest.current.refs,
              recent: env.recent,
              attach: (ref) => set((s) => ({ ...s, refs: mergeRefs(s.refs, [ref]).refs })),
              tour: env.tour,
              anchor: () => anchored.current,
            }),
          ]
        : undefined,
    // The completer reads refs and the anchor through refs; it only changes with the index or checkout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [st.index, env?.root, env?.tour, props.mentions],
  );
  const highlight = useMemo(() => [env ? refHighlight(st.refs) : undefined, mentionHighlight(props.mentions)].filter((r) => r !== undefined), [env, st.refs, props.mentions]);
  const renderPreview = env ? (p: PreviewProps) => <DwellPreview onDwell={env.noteRecent} root={env.root} {...p} title={`${p.path} @ ${env.tour.headSha.slice(0, 7)}`} /> : undefined;

  const editInEditor = async (initial: string): Promise<string | undefined> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-'));
    try {
      const file = path.join(dir, 'suggestion' + path.extname(hunk?.file ?? '.txt'));
      fs.writeFileSync(file, initial);
      await suspendTerminal(() => openInEditor(file));
      return fs.readFileSync(file, 'utf8').replace(/\n$/, '');
    } catch (e) {
      patch({ msg: `Suggestion not changed: ${(e as Error).message}` });
      return undefined;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const editSuggestion = async () => {
    const text = await editInEditor(st.suggestion ?? selected ?? '');
    if (text === undefined) return;
    const meta = tour ? suggestionMetaFor(tour, anchor, { source: 'manual' }) : undefined;
    const left = lineAnchor?.side === 'LEFT' ? " GitHub can't apply suggestions to removed lines, so it posts as a plain code block." : '';
    set((s) => ({ ...s, suggestion: text, suggestionMeta: meta, msg: `Suggestion updated.${left}` }));
  };

  const ai = useAiSuggestion({ st, set, env, editCode: editInEditor });

  useInput(
    (input, key) => {
      if (key.escape) {
        if (completing) return;
        const typed = st.body.trim() !== props.draft.body.trim() || st.suggestion !== props.draft.suggestion;
        if (!typed || discardArmed) return props.onCancel();
        setDiscardArmed(true);
        return patch({ msg: 'esc again to discard · enter to save' });
      }
      if (discardArmed) {
        setDiscardArmed(false);
        if (st.msg === 'esc again to discard · enter to save') patch({ msg: '' });
      }
      if (key.ctrl && input === 'g') return canSuggest ? void editSuggestion() : patch({ msg: 'A code suggestion needs a comment on a line or range.' });
      if (key.ctrl && input === 'd' && st.suggestion !== undefined) return set((s) => ({ ...s, suggestion: undefined, suggestionMeta: undefined, msg: 'Suggestion removed.' }));
      if (!env) return;
      if (key.ctrl && input === 't') return ai.open();
    },
    { isActive: mode === 'text' },
  );

  const save = () => {
    if (!st.body.trim() && !st.suggestion) return patch({ msg: 'Empty comment: Esc to cancel.' });
    props.onSave(draftFrom(props.draft, st));
  };

  const width = props.width;
  const inner = width - 4;
  const full = (props.height ?? 0) >= FULL_ROWS;
  const header = (
    <Text wrap="truncate">
      <Text bold>Comment</Text> <Text dimColor>on {props.target}</Text>
      {tour ? <AnchorStatus tour={tour} state={st} /> : null}
    </Text>
  );
  // The labels, and what the chosen one does: it posts as a bold tag that groups the review.
  const labels = (note: string) => (
    <Text wrap="truncate">
      {LABELS.map((l, i) => (
        <Text key={l}>
          {i ? ' ' : ''}
          <LabelChip label={l} selected={l === st.label} />
        </Text>
      ))}
      <Text dimColor>{`  posts as **[${st.label}]**${note ? ` · ${note}` : ''}`}</Text>
    </Text>
  );
  const listHeight = full ? Math.max(0, (props.height ?? 0) - 12) : props.listRows;
  const field = (rows: number) => (
    <TextInput
      value={st.body}
      onChange={(body) => set((s) => ({ ...s, body }))}
      cursor={st.cursor}
      onCursor={(cursor) => set((s) => ({ ...s, cursor }))}
      onSubmit={save}
      width={inner}
      placeholder="Type a review note…"
      maxRows={rows}
      mentions={env ? undefined : props.mentions}
      completers={completers}
      renderPreview={renderPreview}
      highlightTokens={highlight}
      active={mode === 'text'}
      onCompleting={(open) => {
        setCompleting(open);
        // The owner sizes the inline slot by it: an open list gets room for its preview.
        if (props.state && !!props.state.listOpen !== open) patch({ listOpen: open });
      }}
      listHeight={listHeight}
      onTab={(reverse) => set((s) => ({ ...s, label: LABELS[(LABELS.indexOf(s.label) + (reverse ? LABELS.length - 1 : 1)) % LABELS.length] }))}
    />
  );
  // Where the reference at the cursor points; hidden while the completion list is open.
  const target = env && mode === 'text' && !completing ? refTarget(st.body, st.cursor, st.refs) : undefined;
  const targetLine = target ? (
    <Text dimColor wrap="truncate">
      {truncate(`→ ${target}`, inner)}
    </Text>
  ) : null;

  const aiOpen = ai.ai && tour;
  const aiSection = (budget: number) =>
    ai.ai && tour ? <AiSuggestionView ai={ai.ai} tour={tour} state={st} width={inner} budget={budget} onInstruction={ai.setInstruction} onSubmit={() => void ai.generate()} /> : null;
  const offerAi = canSuggest && !!env?.agent && tour?.mode === 'agent';
  // Every key the text layer takes, most used first; the bar cuts what does not fit and says so.
  const textKeys: Hint[] = [
    ['enter', 'save'],
    ...((offerAi ? [['ctrl+t', inner >= 90 ? AI_HINT : inner >= 60 ? AI_HINT_SHORT : 'AI fix']] : []) as Hint[]),
    ...((env ? [['@', 'people/code']] : []) as Hint[]),
    ['ctrl+j', 'newline'],
    ['tab', 'label'],
    ...((canSuggest ? [['ctrl+g', 'suggestion in $EDITOR']] : []) as Hint[]),
    ...((st.suggestion !== undefined ? [['ctrl+d', 'drop suggestion']] : []) as Hint[]),
    ['esc', 'cancel'],
  ];
  // The message, if any, takes the footer: a warning about to discard in yellow, the rest dim.
  const footer = (keys: Hint[] | string) =>
    st.msg ? (
      <Text color={discardArmed ? 'yellow' : undefined} dimColor={!discardArmed} wrap="truncate">
        {truncate(st.msg, inner)}
      </Text>
    ) : typeof keys === 'string' ? (
      <Text dimColor wrap="truncate">
        {truncate(keys, inner)}
      </Text>
    ) : (
      <KeyBar width={inner} keys={keys} accent />
    );
  const sourceNote = st.suggestionMeta?.source === 'ai' ? 'AI suggestion' : '';

  if (full && env && tour) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
        {header}
        {labels(sourceNote)}
        <Box marginTop={1}>{field(6)}</Box>
        {targetLine ?? <Text> </Text>}
        {aiOpen ? aiSection(Math.max(4, (props.height ?? 0) - 12)) : st.suggestion !== undefined ? <SuggestionDiff state={st} env={env} original={selected} width={inner} max={6} /> : null}
        {footer(ai.ai ? aiKeys(ai.ai) : textKeys)}
      </Box>
    );
  }

  // The AI line takes the suggestion's place and one footer row; the body gives up rows to it.
  if (aiOpen)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
        {header}
        {labels(sourceNote)}
        <Box marginTop={1}>{field(AI_BODY_ROWS)}</Box>
        {aiSection(props.aiRows ?? Math.max(4, (props.height ?? INLINE_FALLBACK) - aiChromeRows(st, width)))}
        {footer(aiKeys(ai.ai!))}
      </Box>
    );

  // The compact composer fits the slot it was given: border, header, labels, gap, the target
  // line's row (kept whether or not the cursor is on a reference, so nothing below jumps), and
  // the footer take COMPACT_CHROME rows; the body and a suggestion share the rest.
  const room = props.height ? Math.max(2, props.height - COMPACT_CHROME) : 12;
  const suggestionRows = st.suggestion !== undefined ? Math.max(2, Math.min(8, room - 2)) : 0;
  const bodyRows = Math.max(1, Math.min(8, room - suggestionRows));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} width={width}>
      {header}
      {labels(sourceNote)}
      <Box marginTop={1}>{field(bodyRows)}</Box>
      {env && !completing ? (targetLine ?? <Text> </Text>) : null}
      {st.suggestion !== undefined ? (
        env ? (
          <SuggestionDiff state={st} env={env} original={selected} width={inner} max={Math.max(1, suggestionRows - 1)} gap={false} />
        ) : (
          <Box flexDirection="column">
            <Text dimColor>suggestion (posted as a GitHub suggestion block):</Text>
            {st.suggestion
              .split('\n')
              .slice(0, Math.max(1, suggestionRows - 1))
              .map((l, i) => (
                <Text key={i} color="green">
                  {'+ ' + sanitizeTerminal(l)}
                </Text>
              ))}
          </Box>
        )
      ) : null}
      {footer(textKeys)}
    </Box>
  );
}

// Where the comment posts and whether GitHub takes it there.
function AnchorStatus(props: { tour: NonNullable<ComposerEnv['tour']>; state: ComposerState }) {
  const a = props.state.anchor;
  if (!isLineAnchor(a)) return null;
  const inDiff = Object.values(props.tour.hunks).some((h) => h.file === a.file && h.lines.some((l) => lineOn(l, a.side) === a.line));
  return (
    <Text dimColor>
      {' '}
      {a.side} · <Text color={inDiff ? 'green' : 'yellow'}>{inDiff ? '● in diff' : '· not in the diff: posts on the nearest line'}</Text>
    </Text>
  );
}

function SuggestionDiff(props: { state: ComposerState; env: ComposerEnv; original?: string; width: number; max: number; gap?: boolean }) {
  const { state: st, env, width } = props;
  const meta = st.suggestionMeta;
  const who = meta?.source === 'ai' ? 'AI proposal, accepted by you' : 'written by you';
  // The rule posting uses: written at this head, or the anchored lines read the same here.
  const applies = suggestionApplicability(env.tour, st.anchor, meta, { originalUnchanged: suggestionStillApplies(env.tour)({ anchor: st.anchor, suggestionMeta: meta }) });
  const status = applies.ok ? `applies to ${linesWord(st.anchor)}` : `plain code block: ${applies.reason}`;
  const minus = (props.original ?? '').split('\n').filter((l, i, all) => all.length > 1 || l);
  const plus = st.suggestion ? st.suggestion.split('\n') : [];
  // Short of room, the replacement shows and the lines it replaces give way.
  const all = [...minus.map((l) => ['-', l] as const), ...plus.map((l) => ['+', l] as const)];
  const rows = all.length > props.max ? all.filter(([sign]) => sign === '+') : all;
  return (
    <Box marginTop={props.gap === false ? 0 : 1} flexDirection="column">
      <Text wrap="truncate">
        <Text bold>Suggestion</Text>
        <Text dimColor> · {truncate(`${who} · ${status}`, width - 12)}</Text>
      </Text>
      {rows.slice(0, props.max).map(([sign, l], i) => (
        <Text key={i} color={sign === '-' ? 'red' : 'green'} wrap="truncate">
          {truncate(`${sign} ${l}`, width)}
        </Text>
      ))}
      {rows.length > props.max ? <Text dimColor>{`  … ${rows.length - props.max} more lines`}</Text> : null}
    </Box>
  );
}

// A preview the reviewer stays on for a second is a recent location.
function DwellPreview(props: ComponentProps<typeof SourcePreview> & { onDwell?: ComposerEnv['noteRecent'] }) {
  const { onDwell, ...rest } = props;
  const noted = useRef(onDwell);
  noted.current = onDwell;
  useEffect(() => {
    const t = setTimeout(() => noted.current?.({ path: rest.path, line: rest.startLine, why: 'preview' }), 1000);
    return () => clearTimeout(t);
  }, [rest.path, rest.startLine]);
  return <SourcePreview {...rest} />;
}
