import { useMemo, useState } from 'react';
import { useInput } from 'ink';
import { Box, Text } from './themed.js';
import type { Chapter, ChecklistItem, Draft, Tour } from '../types.js';
import { buildReviewPayload, groupByLabel, LABELS, postingNote, suggestVerdict } from '../review/submit.js';
import { postReview, type ReviewPayload } from '../github/gh.js';
import { githubWebHost } from '../github/auth.js';
import { progress, truncate, type States } from './nav.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';
import { LABEL_COLOR } from './CommentEditor.js';
import { TextInput } from './TextInput.js';
import { KeyBar } from './KeyBar.js';
import { PostPreview } from './PostPreview.js';
import { suggestionStillApplies } from './composer.js';

type Event = ReviewPayload['event'];
const EVENT_TEXT: Record<Event, string> = { APPROVE: 'Approve', REQUEST_CHANGES: 'Request changes', COMMENT: 'Comment' };

// Lists drafts by label, unread hunks and a suggested verdict. Nothing posts until the reviewer
// presses P and confirms. A draft that posting will change (moved, plain-code suggestion, review
// body) carries a dim note; it is a hint and never blocks.
export function SubmitScreen(props: {
  tour: Tour;
  chapters: Chapter[];
  states: States;
  drafts: Draft[];
  checklist?: ChecklistItem[];
  confirms?: Record<string, boolean>;
  width: number;
  height: number;
  onEdit: (d: Draft) => void;
  onDelete: (d: Draft) => void;
  host?: string; // web host for links; githubWebHost() by default
  onPosted: (ids: string[], review: { id: number; url: string }, moved: { draftId: string; note: string }[]) => void;
  onBack: () => void;
  onQuit?: () => void; // Q
}) {
  const { tour, states, width } = props;
  const pending = useMemo(() => props.drafts.filter((d) => !d.posted), [props.drafts]);
  const ordered = useMemo(() => {
    const g = groupByLabel(pending);
    return LABELS.flatMap((l) => g[l]);
  }, [pending]);
  const verdict = useMemo(() => suggestVerdict(tour, props.drafts, states), [tour, props.drafts, states]);
  const [event, setEvent] = useState<Event>(verdict.event);
  const [sel, setSel] = useState(0);
  const [summary, setSummary] = useState('');
  const [mode, setMode] = useState<'list' | 'summary' | 'confirm' | 'posting' | 'confirm-delete' | 'preview'>('list');
  const [result, setResult] = useState('');
  const host = useMemo(() => props.host ?? githubWebHost(), [props.host]);
  // Posting, the preview and the hints share these options, so each shows what posts.
  const stillApplies = useMemo(() => suggestionStillApplies(tour), [tour]);
  const payloadOpts = useMemo(() => ({ host, suggestionStillApplies: stillApplies }), [host, stillApplies]);
  const notes = useMemo(() => new Map(pending.map((d) => [d.id, postingNote(tour, d, payloadOpts)])), [tour, pending, payloadOpts]);
  const [previewing, setPreviewing] = useState<Draft>();

  const checklist = props.checklist ?? [];
  const confirmed = checklist.filter((c) => props.confirms?.[c.id]);
  const unread = props.chapters.map((c) => ({ c, p: progress(tour, states, c.hunkIds) })).filter((x) => x.p.unread + x.p.deferred > 0);

  const post = async () => {
    setMode('posting');
    try {
      const { payload, moved } = buildReviewPayload(tour, pending, event, summary.trim(), payloadOpts);
      const review = await postReview(tour.repo, tour.pr, payload);
      props.onPosted(
        pending.map((d) => d.id),
        review,
        moved,
      );
    } catch (e) {
      setResult(`Post failed: ${(e as Error).message}`);
      setMode('list');
    }
  };

  useInput(
    (input, key) => {
      if (mode === 'confirm') {
        if (input === 'y' || key.return) return void post();
        return setMode('list');
      }
      if (mode === 'confirm-delete') {
        if (input === 'y' && ordered[sel]) props.onDelete(ordered[sel]);
        return setMode('list');
      }
      if (key.escape || input === 'q') return props.onBack();
      if (input === 'Q') return props.onQuit?.();
      if (input === 'j' || key.downArrow) return setSel((s) => Math.min(Math.max(0, ordered.length - 1), s + 1));
      if (input === 'k' || key.upArrow) return setSel((s) => Math.max(0, s - 1));
      if (input === 'e' && ordered[sel]) return props.onEdit(ordered[sel]);
      if (input === 'p' && ordered[sel]) return openPreview(ordered[sel]);
      if (input === 'x' && ordered[sel]) return setMode('confirm-delete');
      if (input === 'a') return setEvent('APPROVE');
      if (input === 'r') return setEvent('REQUEST_CHANGES');
      if (input === 'c') return setEvent('COMMENT');
      if (input === 'b') return setMode('summary');
      if (input === 'P') {
        if (event === 'REQUEST_CHANGES' && !pending.length && !summary.trim()) return setResult('Requesting changes needs at least one comment or a summary.');
        return setMode('confirm');
      }
    },
    { isActive: mode !== 'summary' && mode !== 'posting' && mode !== 'preview' },
  );

  function openPreview(d: Draft) {
    setPreviewing(d);
    setMode('preview');
  }

  useInput((_i, key) => key.escape && setMode('list'), { isActive: mode === 'summary' });

  const listRoom = Math.max(3, props.height - 14 - unread.length);

  if (mode === 'preview' && previewing) {
    return (
      <Box flexDirection="column" width={width} height={props.height} paddingX={1}>
        <PostPreview draft={previewing} tour={tour} host={host} stillApplies={stillApplies} width={width - 2} height={props.height} onClose={() => setMode('list')} />
      </Box>
    );
  }
  const top = Math.max(0, Math.min(sel - Math.floor(listRoom / 2), ordered.length - listRoom));
  let lastLabel = '';

  return (
    <Box flexDirection="column" width={width} height={props.height} paddingX={1}>
      <Text bold wrap="truncate">
        Submit review · <Text color="cyan">{safe(tour.repo)}</Text> #{tour.pr} {truncate(tour.title, width - 30)}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          Suggested: <Text bold>{EVENT_TEXT[verdict.event]}</Text>
        </Text>
        {verdict.reasons.map((r, i) => (
          <Text key={i} dimColor>
            {'  '}· {truncate(r, width - 6)}
          </Text>
        ))}
        <Text>
          Verdict:{' '}
          {(['APPROVE', 'REQUEST_CHANGES', 'COMMENT'] as Event[]).map((e) => (
            <Text key={e} inverse={e === event} color={e === 'APPROVE' ? 'green' : e === 'REQUEST_CHANGES' ? 'red' : 'cyan'}>
              {` ${EVENT_TEXT[e]} `}
            </Text>
          ))}
          <Text dimColor> (a / r / c)</Text>
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Summary</Text>
        {mode === 'summary' ? (
          <TextInput value={summary} onChange={setSummary} onSubmit={() => setMode('list')} width={width - 4} placeholder="Optional review body" maxRows={4} />
        ) : (
          <Text dimColor={!summary}>{safe(summary) || '(none — b to write one)'}</Text>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Drafts ({pending.length})</Text>
        {!ordered.length ? <Text dimColor>No draft comments.</Text> : null}
        {ordered.slice(top, top + listRoom).map((d, k) => {
          const i = top + k;
          const header = d.label !== lastLabel ? d.label : '';
          lastLabel = d.label;
          const where =
            d.anchor.type === 'line'
              ? `${d.anchor.file}:${d.anchor.line}`
              : d.anchor.type === 'range'
                ? `${d.anchor.file}:${d.anchor.startLine}-${d.anchor.line}`
                : d.anchor.type === 'chapter'
                  ? `flow ${props.chapters.find((c) => c.id === (d.anchor as { chapterId: string }).chapterId)?.title ?? ''}`
                  : 'diagram node';
          const note = notes.get(d.id);
          const text = truncate(
            `${where} — ${d.body.replace(/\s+/g, ' ')}${d.refs?.length ? ` [${d.refs.length} reference${d.refs.length === 1 ? '' : 's'}]` : ''}${d.suggestion !== undefined ? ' [suggestion]' : ''}${d.note ? ` (${d.note})` : ''}`,
            // The hint keeps its room; the body gives way.
            Math.max(12, width - 16 - (note ? note.length + 3 : 0)),
          );
          return (
            <Text key={d.id} wrap="truncate">
              <Text inverse={i === sel}>
                <Text color={LABEL_COLOR[d.label]}>{header.padEnd(11)}</Text>
                {text}
              </Text>
              {note ? <Text dimColor>{`  ${note}`}</Text> : null}
            </Text>
          );
        })}
      </Box>
      {checklist.length ? (
        <Text color={confirmed.length === checklist.length ? 'green' : 'yellow'}>
          Team checklist: {confirmed.length}/{checklist.length} confirmed
          {checklist.some((c) => c.status === 'fail') ? ` · ${checklist.filter((c) => c.status === 'fail').length} flagged by the agent` : ''} (not posted to GitHub)
        </Text>
      ) : null}
      {unread.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="yellow">
            Not yet read
          </Text>
          {unread.map(({ c, p }) => (
            <Text key={c.id} dimColor>
              {truncate(`  ${c.title}: ${p.unread} unread${p.deferred ? `, ${p.deferred} deferred` : ''}`, width - 4)}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box flexGrow={1} />
      {result ? <Text color="red">{safe(result)}</Text> : null}
      {mode === 'confirm' ? (
        <Text color="yellow" bold>
          Post a "{EVENT_TEXT[event]}" review with {pending.length} comment(s) to {safe(tour.repo)}#{tour.pr}? Y / n
        </Text>
      ) : mode === 'confirm-delete' ? (
        <Text color="yellow">Delete this draft? y / n</Text>
      ) : mode === 'posting' ? (
        <Text color="yellow">Posting…</Text>
      ) : (
        <KeyBar
          width={width}
          keys={[
            ['P', 'post'],
            ['esc', 'back'],
            ['a/r/c', 'verdict'],
            ['b', 'summary'],
            ['j/k', 'select'],
            ['e/x', 'draft'],
            ['p', 'preview as posted'],
          ]}
        />
      )}
    </Box>
  );
}
