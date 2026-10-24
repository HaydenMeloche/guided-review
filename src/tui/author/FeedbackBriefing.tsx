import { useEffect, useState, type ReactNode } from 'react';
import { useInput } from 'ink';
import { Box, Text, useSelected } from '../themed.js';
import { ROLES } from '../theme.js';
import type { ExistingReview, IssueComment, Tour } from '../../types.js';
import { BRIEFING_KEYS, briefingBar } from './keys.js';
import { isBlocking, STATE_LABEL, type FeedbackChapter, type FeedbackItem, type ReviewerStatus, type ThreadState } from '../../review/feedback.js';
import type { FeedbackTheme } from '../../agent/feedback.js';
import type { Readiness } from '../../review/merge.js';
import { ReadinessLine } from '../MergeScreen.js';
import type { CheckSummary, PendingReviewers } from '../../github/gh.js';
import { CHECK_MARK, checkLabel, duration, outcomeText, sortChecks } from '../../review/checks.js';
import { Reader } from '../Panels.js';
import { KeyBar, Key } from '../KeyBar.js';
import { HelpPopup } from '../Help.js';
import { helpOf } from '../keys.js';
import { SectionHeading } from '../BriefingScreen.js';
import { pad, truncate, wrap } from '../nav.js';
import { MdLineView, renderMarkdown } from '../markdown.js';
import { age } from '../PickerScreen.js';
import { plural } from '../plural.js';
import { sanitizeTerminal as safe } from '../../util/sanitize.js';
import { TONE_COLOR, useFlash } from '../flash.js';

export const VERDICT: Record<string, { text: string; color: string; mark: string }> = {
  APPROVED: { text: 'approved', color: 'green', mark: '✓' },
  CHANGES_REQUESTED: { text: 'changes requested', color: 'red', mark: '✗' },
  COMMENTED: { text: 'commented', color: 'cyan', mark: '○' },
  DISMISSED: { text: 'dismissed', color: 'gray', mark: '–' },
};

export const STATE_COLOR: Record<ThreadState, string> = { open: 'yellow', replied: 'cyan', addressed: 'green', resolved: 'gray' };

// A chapter's mark: red while a change request is open, yellow while anything is, green once
// everything has an answer.
export function chapterMark(c: FeedbackChapter): { mark: string; color: string } {
  const open = c.items.filter((i) => i.state === 'open');
  if (open.some(isBlocking)) return { mark: '●', color: 'red' };
  if (open.length) return { mark: '●', color: 'yellow' };
  return { mark: '✓', color: 'green' };
}

// The first screen of author mode: who reviewed and what they decided, whether the PR can
// merge, the feedback's themes, and the feedback chapters in the order to work through them.
export function FeedbackBriefing(props: {
  tour: Tour;
  items: FeedbackItem[];
  groups: FeedbackChapter[];
  reviewers: ReviewerStatus[];
  reviews: ExistingReview[];
  comments: IssueComment[];
  readiness?: Readiness;
  checks?: CheckSummary; // the head commit's checks; unset until the merge status arrives
  onChecks?: () => void; // c: the checks and their logs
  onReviewers?: () => void; // A: who is asked to review, and asking more
  pending?: PendingReviewers; // asked to review, and not answered yet
  since?: string;
  themes?: FeedbackTheme[];
  analyzing?: string;
  following?: boolean; // outdated threads are still being followed to the current head
  queued: number; // thread replies and the conversation comment
  commentQueued?: boolean;
  showHidden: boolean;
  silent: number; // won't-do threads with no reply
  notes: string[];
  writing?: string; // the briefing is still being written
  banner?: string;
  width: number;
  height: number;
  active: boolean;
  onStart: (ci?: number) => void;
  onSend: () => void;
  onComment?: () => void; // y: a comment on the PR's conversation, answering a review summary or comment
  onMerge?: () => void;
  onCopyUrl?: () => Promise<string>; // Y: the PR's link on the clipboard
  onToggleHidden: () => void;
  onFullTour: () => void;
  onRefresh: () => void;
  onTheme?: () => void;
  onBack?: () => void;
  onQuit: () => void;
}) {
  const { tour, items, groups, width, height } = props;
  const selectedRow = useSelected();
  const [sel, setSel] = useState(0);
  const [overlay, setOverlay] = useState<'none' | 'reviews' | 'comments' | 'description' | 'help'>('none');
  const { flash, show: setFlash, dismiss: dismissFlash } = useFlash();
  // n, p and Enter with no feedback chapter to open: say why, and what there is to do instead.
  const nothingToOpen = () => {
    const merge = props.readiness?.canMerge && props.onMerge ? ' M merges the PR.' : '';
    if (items.length) return setFlash(`Every thread is resolved: H shows them.${merge}`);
    const reviewed = props.reviews.some((r) => r.author !== tour.author);
    setFlash(`${reviewed ? 'The reviews left no threads to work through.' : 'No reviews yet, so there is no feedback to work through.'}${merge}`);
  };
  useEffect(() => setSel((s) => Math.min(s, Math.max(0, groups.length - 1))), [groups.length]);

  const summaries = props.reviews.filter((r) => r.author !== tour.author && r.body.trim());
  useInput(
    (input, key) => {
      dismissFlash();
      if (input === 'j' || key.downArrow) return setSel((s) => Math.min(groups.length - 1, s + 1));
      if (input === 'k' || key.upArrow) return setSel((s) => Math.max(0, s - 1));
      if (key.return) return groups.length ? props.onStart(sel) : nothingToOpen();
      if (input === 'n' || input === ' ') return groups.length ? props.onStart() : nothingToOpen();
      if (input === 'p' && !groups.length) return nothingToOpen();
      if (input === 's') return props.onSend();
      if (input === 'y' && props.onComment) return props.onComment();
      if (input === 'M' && props.onMerge) return props.onMerge();
      if (input === 'c' && props.onChecks && props.checks?.items.length) return props.onChecks();
      if (input === 'A' && props.onReviewers) return props.onReviewers();
      if (input === 'Y' && props.onCopyUrl) return void props.onCopyUrl().then((m) => setFlash(m, /^Copied|^Asked/.test(m) ? 'info' : undefined));
      if (input === 'H') return props.onToggleHidden();
      if (input === 't') return props.onFullTour();
      if (input === 'R') return props.onRefresh();
      if (input === 'V' && summaries.length) return setOverlay('reviews');
      if (input === 'g' && props.comments.length) return setOverlay('comments');
      if (input === 'r' && tour.description?.trim()) return setOverlay('description');
      if (input === 'L' && props.onTheme) return props.onTheme();
      if (input === '?' || input === 'h') return setOverlay('help');
      if (key.escape) return props.onBack?.();
      if (input === 'q') return (props.onBack ?? props.onQuit)();
      if (input === 'Q') return props.onQuit();
    },
    { isActive: props.active && overlay === 'none' },
  );

  if (overlay === 'reviews') {
    const markdown = summaries.map((r) => `## @${r.author} · ${r.state.toLowerCase().replace(/_/g, ' ')} · ${r.submittedAt.slice(0, 10)}\n\n${r.body.trim()}\n\n${r.url}`).join('\n\n---\n\n');
    return <Reader title={`#${tour.pr} — review summaries`} markdown={markdown} width={width} height={height} onClose={() => setOverlay('none')} />;
  }
  if (overlay === 'description') {
    return <Reader title={`#${tour.pr} — your description`} markdown={tour.description ?? ''} width={width} height={height} onClose={() => setOverlay('none')} />;
  }
  if (overlay === 'comments') {
    const markdown = props.comments.map((c) => `## @${c.author} · ${c.createdAt.slice(0, 10)}\n\n${c.body.trim() || '(empty)'}\n\n${c.url}`).join('\n\n---\n\n');
    return <Reader title={`#${tour.pr} — conversation`} markdown={markdown} width={width} height={height} onClose={() => setOverlay('none')} />;
  }

  const counts = { open: 0, replied: 0, addressed: 0, resolved: 0 } as Record<ThreadState, number>;
  for (const i of items) counts[i.state]++;
  const hiddenCount = counts.resolved;

  // Wide terminals: the PR on the left (what it does, the author's description, the feedback
  // chapters), and the feedback on the right (reviews, state, themes), as the review briefing
  // puts the overview beside its text. Narrow terminals stack the feedback above the PR.
  const wide = width >= 120;
  const leftW = wide ? Math.floor((width - 2) * 0.55) : width - 2;
  const rightW = wide ? width - 2 - leftW - 3 : width - 2;
  const bodyH = height - 4 - (props.banner ? 1 : 0); // title, the gap under it, progress line, key bar

  // ---------- the feedback ----------
  const right: ReactNode[] = [];
  const add = (key: string, node: ReactNode) => right.push(<Box key={key}>{node}</Box>);
  const gap = (key: string) => right.length && add(key, <Text> </Text>);
  if (props.since)
    add(
      'since',
      <Text color="magenta" wrap="truncate">
        {truncate(`↻ ${safe(props.since)}`, rightW)}
      </Text>,
    );
  for (const [k, n] of props.notes.entries())
    add(
      `note${k}`,
      <Text dimColor wrap="truncate">
        {truncate(`ℹ ${safe(n)}`, rightW)}
      </Text>,
    );
  gap('g0');
  add(
    'rhead',
    <SectionHeading title="Reviews" width={rightW}>
      {summaries.length ? (
        <>
          <Text dimColor> · </Text>
          <Key k="V" />
          <Text dimColor> to read {summaries.length === 1 ? 'the summary' : `${summaries.length} summaries`}</Text>
        </>
      ) : null}
    </SectionHeading>,
  );
  const asked = [...(props.pending?.users ?? []).map((u) => `@${u}`), ...(props.pending?.teams ?? []).map((t) => `@${tour.repo.split('/')[0]}/${t}`)];
  if (!props.reviewers.length && !asked.length) add('rnone', <Text dimColor>{props.onReviewers ? 'No reviews yet, and nobody is asked. A asks someone.' : 'No reviews yet.'}</Text>);
  for (const r of props.reviewers) {
    const v = VERDICT[r.verdict] ?? VERDICT.COMMENTED;
    add(
      `r:${r.login}`,
      <Text wrap="truncate">
        <Text color={v.color}>{`${v.mark} `}</Text>
        {safe(`@${r.login}`)} <Text color={v.color}>{v.text}</Text>
        <Text dimColor>{` · ${age(r.at)}${r.beforeLatestCommit === true ? ' · before your latest commit' : r.beforeLatestCommit === false ? ' · after your latest commit' : ''}`}</Text>
      </Text>,
    );
  }
  for (const name of asked)
    add(
      `asked:${name}`,
      <Text wrap="truncate">
        <Text color="yellow">● </Text>
        {safe(name)} <Text color="yellow">asked, waiting</Text>
      </Text>,
    );
  if (props.checks) {
    // Failures and running checks by name; the ones that passed as a count.
    const all = props.checks.items;
    const sorted = sortChecks(all);
    const loud = sorted.filter((c) => c.state === 'failed' || c.state === 'pending');
    const quiet = sorted.length - loud.length;
    const MAX = 6;
    gap('gc');
    add(
      'chead',
      <SectionHeading title="Checks" width={rightW}>
        {all.length && props.onChecks ? (
          <>
            <Text dimColor> · </Text>
            <Key k="c" />
            <Text dimColor>{loud.some((c) => c.jobId) ? ' to view them and their logs' : ' to view them'}</Text>
          </>
        ) : null}
      </SectionHeading>,
    );
    if (!all.length) add('cnone', <Text dimColor>No checks have reported on this commit.</Text>);
    for (const [k, c] of loud.slice(0, MAX).entries()) {
      const m = CHECK_MARK[c.state];
      const meta = ` ${outcomeText(c)}${c.state === 'pending' && duration(c) ? ` ${duration(c)}` : ''}${c.required ? ' · required' : ''}`;
      add(
        `c${k}`,
        <Text wrap="truncate">
          <Text color={m.color}>{`${m.mark} `}</Text>
          {truncate(safe(checkLabel(c, all)), Math.max(8, rightW - meta.length - 2))}
          <Text color={m.color} dimColor={c.state === 'pending'}>
            {meta}
          </Text>
        </Text>,
      );
    }
    if (loud.length > MAX) add('cmore', <Text dimColor>{`  … ${loud.length - MAX} more failing or running`}</Text>);
    if (quiet) {
      const passed = sorted.filter((c) => c.state === 'passed').length;
      const skipped = quiet - passed;
      add(
        'cquiet',
        <Text wrap="truncate">
          <Text color="green">{`✓ ${passed} passed`}</Text>
          <Text dimColor>{skipped ? ` · ${skipped} skipped` : ''}</Text>
        </Text>,
      );
    }
  }
  gap('g1');
  add('shead', <SectionHeading title="Threads" width={rightW} />);
  add(
    'counts',
    <Text wrap="truncate">
      {(['open', 'replied', 'addressed', 'resolved'] as ThreadState[]).map((st, i) => (
        <Text key={st}>
          {i ? <Text dimColor> · </Text> : null}
          <Text color={counts[st] ? STATE_COLOR[st] : undefined} dimColor={!counts[st]}>{`${counts[st]} ${STATE_LABEL[st]}`}</Text>
        </Text>
      ))}
    </Text>,
  );
  if (props.queued)
    add(
      'queued',
      <Text color="magenta" wrap="truncate">
        {(() => {
          const replies = props.queued - (props.commentQueued ? 1 : 0);
          return [replies ? `${replies} repl${replies === 1 ? 'y' : 'ies'}` : '', props.commentQueued ? 'a comment' : ''].filter(Boolean).join(' and ');
        })()}{' '}
        queued · <Key k="s" /> to send
      </Text>,
    );
  if (props.comments.length)
    add(
      'general',
      <Text wrap="truncate">
        <Key k="g" />
        <Text dimColor>{` to read ${plural(props.comments.length, 'general comment')} on the PR`}</Text>
      </Text>,
    );
  if (props.silent)
    add(
      'silent',
      <Text color="yellow" wrap="truncate">
        ⚑ {plural(props.silent, 'won’t-do thread')} {props.silent === 1 ? 'has' : 'have'} no reply yet
      </Text>,
    );
  if (props.themes?.length || props.analyzing) {
    gap('g2');
    add('thead', <SectionHeading title="Themes" width={rightW} />);
    if (props.analyzing && !props.themes?.length)
      add(
        'thinking',
        <Text dimColor wrap="truncate">
          {safe(props.analyzing)}
        </Text>,
      );
    for (const [k, t] of (props.themes ?? []).entries()) {
      // Themes wrap: they are the point of this side. The thread count ends the last line.
      const count = t.threadIds.length ? ` (${t.threadIds.length})` : '';
      const lines = wrap(`${safe(t.text)}${count}`, rightW - 4);
      lines.forEach((l, j) => {
        const last = j === lines.length - 1 && count && l.endsWith(count.trim());
        add(
          `t${k}:${j}`,
          <Text wrap="truncate">
            {j ? '  ' : '• '}
            {last ? l.slice(0, l.length - count.trim().length) : l}
            {last ? <Text dimColor>{count.trim()}</Text> : null}
          </Text>,
        );
      });
    }
  }

  // ---------- the PR ----------
  const intentAll = renderMarkdown(tour.intent, leftW);
  const descAll = tour.description?.trim() ? renderMarkdown(tour.description, leftW) : [];
  const stacked = wide ? 0 : Math.min(right.length, Math.floor(bodyH * 0.45));
  const avail = bodyH - (stacked ? stacked + 1 : 0);
  const listRows = Math.max(1, Math.min(groups.length, 5));
  const listNeed = 2 + listRows + (groups.length > listRows ? 1 : 0); // gap, heading, rows, "more"
  // The chapter list keeps its rows; the intent, then the description, take what is left.
  let prose = Math.max(1, avail - (props.readiness ? 1 : 0) - listNeed);
  const intent = intentAll.slice(0, prose);
  prose -= intent.length;
  const descFull = descAll.length + 2 <= prose; // gap and heading
  const desc = descFull ? descAll : prose - 3 >= 1 ? descAll.slice(0, prose - 3) : [];
  const descRows = desc.length ? desc.length + 2 + (desc.length < descAll.length ? 1 : 0) : 0;
  const listRoom = Math.max(1, avail - (props.readiness ? 1 : 0) - intent.length - descRows - 3);
  const start = Math.max(0, Math.min(sel - Math.floor(listRoom / 2), groups.length - listRoom));
  const shown = groups.slice(start, start + listRoom);

  const left = (
    <Box flexDirection="column" width={leftW} height={avail} overflow="hidden" flexShrink={0}>
      {props.readiness ? <ReadinessLine readiness={props.readiness} width={leftW} hint={!!props.onMerge} /> : null}
      {intent.map((l, i) => (
        <MdLineView key={`i${i}`} line={l} />
      ))}
      {desc.length ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <SectionHeading title="From you" width={leftW} />
          {desc.map((l, i) => (
            <MdLineView key={`d${i}`} line={l} />
          ))}
          {descAll.length > desc.length ? (
            <Text>
              <Text dimColor italic>{`… ${plural(descAll.length - desc.length, 'more line')}: `}</Text>
              <Key k="r" />
              <Text dimColor italic>
                {' '}
                to read it all
              </Text>
            </Text>
          ) : null}
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column" flexShrink={0}>
        <SectionHeading title="Feedback" width={leftW}>
          <Text dimColor>{` · change requests first · ${props.showHidden ? 'showing' : 'hiding'} ${hiddenCount} resolved · `}</Text>
          <Key k="H" />
        </SectionHeading>
        {!groups.length ? (
          <Text dimColor>
            {items.length ? 'Every thread is resolved. H shows them.' : 'No review threads on this PR yet.'}
            {props.readiness?.canMerge ? ' M merges it.' : ''}
          </Text>
        ) : null}
        {shown.map((c, k) => {
          const ci = start + k;
          const m = chapterMark(c);
          const change = c.items.filter((i) => isBlocking(i) && i.state === 'open').length;
          const meta = ` ${plural(c.items.length, 'thread')}${change ? ` · ${plural(change, 'change request')}` : ''}`;
          return (
            <Text key={c.id} {...selectedRow(ci === sel)} wrap="truncate">
              <Text color={m.color}>{m.mark}</Text> <Text color={ci === sel ? undefined : ROLES.title}>{pad(safe(c.title), Math.max(12, leftW - meta.length - 3))}</Text>
              <Text dimColor>{meta}</Text>
            </Text>
          );
        })}
        {groups.length > shown.length ? <Text dimColor>{`  ${start ? `… ${start} above · ` : ''}${groups.length - start - shown.length} more below`}</Text> : null}
      </Box>
    </Box>
  );

  const screen = (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Text wrap="truncate">
        <Text color="cyan" bold>
          {safe(tour.repo)}
        </Text>
        <Text bold color={ROLES.title}>
          {' '}
          #{tour.pr} {safe(tour.title)}
        </Text>
        <Text dimColor>
          {'  '}feedback for {safe(tour.author)} · {safe(tour.headSha.slice(0, 8))}
        </Text>
      </Text>
      {props.banner ? (
        <Text backgroundColor="yellow" color="black">
          {pad(` ${props.banner}`, width - 2)}
        </Text>
      ) : null}
      {wide ? (
        <Box flexDirection="row" height={bodyH} overflow="hidden" marginTop={1}>
          {left}
          <Box
            flexDirection="column"
            marginLeft={2}
            width={rightW + 1}
            borderStyle="single"
            borderTop={false}
            borderBottom={false}
            borderRight={false}
            borderColor="gray"
            paddingLeft={1}
            overflow="hidden"
          >
            {right.slice(0, bodyH)}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" height={bodyH} overflow="hidden" marginTop={1}>
          {right.slice(0, stacked)}
          {stacked ? <Box height={1} /> : null}
          {left}
        </Box>
      )}
      {flash ? (
        <Text color={TONE_COLOR[flash.tone]} wrap="truncate">
          {safe(flash.text)}
        </Text>
      ) : props.writing || props.analyzing ? (
        <Text color="yellow">⟳ {safe(props.writing ?? props.analyzing ?? '')}</Text>
      ) : props.following ? (
        <Text dimColor>Following outdated threads to the current head…</Text>
      ) : (
        <Text> </Text>
      )}
      <KeyBar
        width={width - 2}
        accent
        keys={[...briefingBar({ queuedCount: props.queued, comment: !!props.onComment, merge: !!props.onMerge, reviewers: !!props.onReviewers, copy: !!props.onCopyUrl, theme: !!props.onTheme })]}
        end={[
          ['?', 'keys'],
          ['q', props.onBack ? 'PR list' : 'quit'],
        ]}
      />
    </Box>
  );
  if (overlay === 'help' && props.active)
    return <HelpPopup background={screen} width={width} height={height} title="feedback briefing" sections={helpOf(BRIEFING_KEYS)} onClose={() => setOverlay('none')} />;
  return screen;
}
