import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useInput } from 'ink';
import { Box, Text, useSelected, useTheme } from './themed.js';
import { ROLES } from './theme.js';
import type { Chapter, ChapterOrder, Tour } from '../types.js';
import { chapterState, ORDER_LABEL, pad, progress, stateMark, type States } from './nav.js';
import { DiagramView } from './DiagramView.js';
import { renderGraph } from '../diagram/text.js';
import { MdLineView, renderMarkdown } from './markdown.js';
import { Reader } from './Panels.js';
import { AskOverlay } from './AskOverlay.js';
import { KeyBar, type AgentCtx } from './ChapterScreen.js';
import { Key } from './KeyBar.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';
import type { Readiness } from '../review/merge.js';
import { ReadinessLine } from './MergeScreen.js';
import { Busy } from './Spinner.js';
import { HelpPopup } from './Help.js';
import { helpOf } from './keys.js';
import { reviewLegend } from './legend.js';
import { REVIEW_BRIEFING_KEYS, reviewBriefingBar } from './screenKeys.js';
import { plural } from './plural.js';
import { HELP_NOTE } from './ChapterScreen.js';

const FLAG_COLOR: Record<string, string> = {
  'scope-creep': 'magenta',
  'generated-out-of-sync': 'yellow',
  'large-pr': 'yellow',
  'no-entry-point': 'yellow',
  'model-unavailable': 'red',
  'missing-change': 'cyan',
  info: 'gray',
};

// One screen: the goal, an overview diagram, the chapter list with reading state
// and size, and anything flagged up front.
export function BriefingScreen(props: {
  tour: Tour;
  chapters: Chapter[];
  allChapters?: Chapter[]; // the whole tour; a re-review greys the chapters `chapters` leaves out
  order: ChapterOrder;
  cycleOrder: () => void;
  deltaOnly?: boolean;
  toggleDelta?: () => void;
  states: States;
  analyzing?: string; // chapters still being narrated, shown at the header's right end
  agent?: AgentCtx;
  aiOff?: string; // why the agent is absent
  width: number;
  height: number;
  active?: boolean;
  onStart: (ci?: number) => void;
  resume?: string; // where n picks up, when a position is saved
  onSubmit: () => void;
  readiness?: Readiness; // whether the PR can merge; unset in a preview or until it arrives
  onMerge?: () => void; // M: merge the PR
  onFeedback?: () => void; // t: the feedback on your own PR (author mode)
  onChecks?: () => void; // c: the PR's checks and their logs
  onTheme?: () => void; // L: the color theme picker
  onBack?: () => void; // esc, q: back to the PR list; unset (a preview), q quits
  onQuit: () => void;
}) {
  const { tour, chapters, states, width, height } = props;
  const selectedRow = useSelected();
  const [sel, setSel] = useState(0);
  const [overlay, setOverlay] = useState<'none' | 'diagram' | 'ask' | 'read' | 'reviews' | 'help'>('none');
  useEffect(() => setSel(0), [props.order]);
  // D keeps the selected chapter when it is in both lists.
  const keepSel = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (keepSel.current === undefined) return;
    setSel(
      Math.max(
        0,
        chapters.findIndex((c) => c.id === keepSel.current),
      ),
    );
    keepSel.current = undefined;
  }, [chapters]);

  // Per-render work over the whole tour is memoized, so j/k only re-renders the list.
  const prog = useMemo(() => progress(tour, states), [tour, states]);
  const natural = useMemo(() => (tour.overview ? Math.max(0, ...renderGraph(tour.overview, Math.floor(width * 0.6)).lines.map((l) => l.length)) : 0), [tour.overview, width]);
  const wide = !!tour.overview && width >= 120;
  const rightW = wide ? Math.min(natural + 2, Math.floor(width * 0.6)) : 0;
  const leftW = wide ? width - rightW - 4 : width - 2;
  const intent = useMemo(() => renderMarkdown(tour.intent, leftW), [tour.intent, leftW]);
  const descAll = useMemo(() => (tour.description?.trim() ? renderMarkdown(tour.description, leftW) : []), [tour.description, leftW]);

  useInput(
    (input, key) => {
      if (input === 'j' || key.downArrow) return setSel((s) => Math.min(chapters.length - 1, s + 1));
      if (input === 'k' || key.upArrow) return setSel((s) => Math.max(0, s - 1));
      if (key.return) return props.onStart(sel);
      if (input === 'n' || input === ' ') return props.onStart();
      if (input === 'd' && tour.overview) return setOverlay('diagram');
      if (input === 'a') return setOverlay('ask');
      if (input === '?' || input === 'h') return setOverlay('help');
      if (input === 'f') return props.cycleOrder();
      if (input === 'D' && tour.rereview && props.toggleDelta) {
        keepSel.current = chapters[sel]?.id ?? '';
        return props.toggleDelta();
      }
      if (input === 's') return props.onSubmit();
      if (input === 'M' && props.onMerge) return props.onMerge();
      if (input === 't' && props.onFeedback) return props.onFeedback();
      if (input === 'c' && props.onChecks) return props.onChecks();
      if (input === 'L' && props.onTheme) return props.onTheme();
      if (input === 'r' && tour.description?.trim()) return setOverlay('read');
      if (input === 'V' && tour.existingReviews?.some((r) => r.author !== tour.author && r.author !== tour.viewer)) return setOverlay('reviews');
      // Esc and q go up a level; in a preview the briefing is the top, where only q quits.
      if (key.escape) return props.onBack?.();
      if (input === 'q') return (props.onBack ?? props.onQuit)();
      if (input === 'Q') return props.onQuit();
    },
    { isActive: props.active !== false && overlay === 'none' },
  );

  if (overlay === 'diagram' && tour.overview) {
    return (
      <DiagramView
        graph={tour.overview}
        width={width}
        height={height}
        onClose={() => setOverlay('none')}
        onJump={(hid) => {
          const c = chapters.findIndex((ch) => ch.hunkIds.includes(hid));
          props.onStart(c >= 0 ? c : undefined);
        }}
      />
    );
  }
  if (overlay === 'read') {
    return <Reader title={`#${tour.pr} — from the author`} markdown={tour.description ?? ''} width={width} height={height} onClose={() => setOverlay('none')} />;
  }
  if (overlay === 'reviews') {
    const markdown = (tour.existingReviews ?? [])
      .filter((r) => r.author !== tour.author && r.author !== tour.viewer)
      .map((r) => `## @${r.author} · ${r.state.toLowerCase().replace(/_/g, ' ')} · ${r.submittedAt.slice(0, 10)}\n\n${r.body.trim() || 'No summary left.'}\n\n${r.url}`)
      .join('\n\n---\n\n');
    return <Reader title={`#${tour.pr} — reviewer feedback`} markdown={markdown} width={width} height={height} onClose={() => setOverlay('none')} />;
  }
  const rr = tour.rereview;
  const blast = tour.blastRadius.filter((b) => b.callers.length).slice(0, 4);

  // Wide terminals: text on the left, the overview diagram on the right at its natural
  // size (up to 60% of the width). Narrow terminals stack the diagram under the text.
  const askHeight = overlay === 'ask' ? Math.min(14, Math.max(5, height - 10)) : 0;
  const bodyH = height - 4 - askHeight; // title, margin, status line, key bar

  // Missing tests show on each hunk in the chapters, so the briefing leaves that flag out.
  const flags = tour.flags.filter((f) => f.kind !== 'missing-tests').slice(0, 6);
  const otherReviews = (tour.existingReviews ?? []).filter((r) => r.author !== tour.author && r.author !== tour.viewer);
  const reviews = otherReviews.slice(-3).reverse();
  const rrRows = rr ? 1 + Math.min(5, rr.comments.length) + 1 : 0;
  // On a re-review showing only changes, every chapter is listed and the unchanged ones are greyed.
  const delta = !!rr && !!props.deltaOnly;
  const fullCount = (id: string) => (props.allChapters ?? chapters).find((c) => c.id === id)?.hunkIds.length ?? 0;
  const rows =
    delta && props.allChapters
      ? props.allChapters.map((c) => ({ chapter: chapters.find((d) => d.id === c.id) ?? c, ci: chapters.findIndex((d) => d.id === c.id) }))
      : chapters.map((chapter, ci) => ({ chapter, ci }));
  const selRow = Math.max(
    0,
    rows.findIndex((r) => r.ci === sel),
  );
  const otherRows =
    intent.length +
    1 +
    (props.readiness ? 1 : 0) +
    rrRows +
    (reviews.length ? reviews.length + 2 : 0) +
    (flags.length ? flags.length + 1 : 0) +
    tour.notes.length +
    (blast.length ? blast.length + 2 : 0);
  // Long chapter lists show a window around the selection instead of every chapter.
  const chapterRoom = Math.max(5, bodyH - otherRows - 3 - 4);
  const windowed = rows.length > chapterRoom;
  const shownCount = windowed ? chapterRoom - 1 : rows.length;
  const chStart = windowed ? Math.max(0, Math.min(selRow - Math.floor(shownCount / 2), rows.length - shownCount)) : 0;
  const fixedRows = otherRows + shownCount + (windowed ? 1 : 0) + 3;
  const diagramBelowH = wide ? 0 : Math.max(0, Math.min(16, bodyH - fixedRows - 8));
  // heading + margin + the '… more' line
  const descRoom = Math.max(3, bodyH - fixedRows - (diagramBelowH ? diagramBelowH + 1 : 0) - 4);
  const desc = descAll.slice(0, descRoom);

  const left = (
    <Box flexDirection="column" width={leftW}>
      {props.readiness ? <ReadinessLine readiness={props.readiness} width={leftW} hint={!!props.onMerge} /> : null}
      {intent.map((l, i) => (
        <MdLineView key={i} line={l} />
      ))}
      {descAll.length ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <Heading terminal={{ dimColor: true }}>From the author</Heading>
          {desc.map((l, i) => (
            <MdLineView key={i} line={l} />
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
      {reviews.length ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <Text>
            <Heading terminal={{ color: 'cyan' }}>Other reviewers</Heading>
            <Text dimColor> · </Text>
            <Key k="V" />
            <Text dimColor> to read all {plural(otherReviews.length, 'review')}</Text>
          </Text>
          {reviews.map((r) => (
            <Text key={r.id} wrap="truncate">
              {safe(
                `@${r.author} · ${r.state.toLowerCase().replace(/_/g, ' ')} · ${
                  safe(r.body)
                    .trim()
                    .replace(/\s+/g, ' ')
                    .slice(0, Math.max(12, leftW - 45)) || 'No summary left.'
                }`,
              )}
            </Text>
          ))}
        </Box>
      ) : null}
      {flags.length ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          {flags.map((f, i) => (
            <Text key={i} color={FLAG_COLOR[f.kind] ?? 'gray'} wrap="truncate">
              {safe(`⚑ ${f.kind.replace(/-/g, ' ')}: ${f.message}`)}
            </Text>
          ))}
        </Box>
      ) : null}
      {tour.notes.map((n, i) => (
        <Text key={i} dimColor wrap="truncate">
          {safe(`ℹ ${n}`)}
        </Text>
      ))}
      {rr ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <Text wrap="truncate">
            {delta ? (
              <>
                <Text color="yellow" bold>
                  Changes only:
                </Text>
                <Text>
                  {' '}
                  {plural(rr.newHunkIds.length, 'new or changed hunk')} since {safe(rr.previousHead.slice(0, 8))}, in {chapters.length} of {rows.length} chapters
                </Text>
                <Text dimColor> · </Text>
                <Key k="D" />
                <Text dimColor> for the full review</Text>
              </>
            ) : (
              <>
                <Text color="cyan" bold>
                  Full review:
                </Text>
                <Text>
                  {' '}
                  every hunk · {rr.newHunkIds.length} new or changed since {safe(rr.previousHead.slice(0, 8))}
                </Text>
                <Text dimColor> · </Text>
                <Key k="D" />
                <Text dimColor> for changes only</Text>
              </>
            )}
          </Text>
          {rr.comments.slice(0, 5).map((c, i) => (
            <Text key={i} wrap="truncate">
              <Text color={c.addressed ? 'green' : 'yellow'}>{c.addressed ? '✓ addressed ' : '○ open      '}</Text>
              {safe(`${c.path ? `${c.path}:${c.line ?? ''} ` : ''}${c.body.replace(/\s+/g, ' ')}`)}
              <Text dimColor> — {safe(c.reason)}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        <Text>
          <Heading terminal={{}}>Chapters</Heading>{' '}
          <Text bold color="cyan">
            · {ORDER_LABEL[props.order]} order
          </Text>
          <Text bold dimColor>
            {' '}
            · {prog.read + prog.skipped}/{prog.total} hunks done
          </Text>
        </Text>
        <Text>
          <Text dimColor>
            {props.order === 'flow'
              ? 'Recommended reading path through the changed flows'
              : props.order === 'risk'
                ? 'Highest-risk chapters first'
                : props.order === 'size'
                  ? 'Fewest changed lines first'
                  : 'Files in path order'}
            {' · '}
          </Text>
          <Key k="f" />
          <Text dimColor> to change</Text>
        </Text>
        {rows.slice(chStart, chStart + shownCount).map(({ chapter: c, ci }) => {
          const unchanged = ci < 0;
          const st = stateMark(chapterState(tour, c, states));
          const count = !delta
            ? `${plural(c.hunkIds.length, 'hunk')}`
            : unchanged
              ? `${plural(c.hunkIds.length, 'hunk')} · unchanged`
              : `${c.hunkIds.length} of ${plural(fullCount(c.id), 'hunk')} changed`;
          const meta = ` ${count}${c.optional ? ' · optional' : c.kind !== 'flow' ? ` · ${c.kind}` : ''}`;
          const selected = !unchanged && ci === sel;
          const quiet = unchanged || (c.collapsed && !selected);
          return (
            <Text key={c.id} {...selectedRow(selected)} dimColor={quiet} wrap="truncate">
              <Text color={unchanged ? undefined : st.color}>{st.mark}</Text>{' '}
              <Text color={quiet || selected ? undefined : ROLES.title}>{pad(safe(c.title), Math.max(20, leftW - meta.length - 3))}</Text>
              <Text dimColor>{meta}</Text>
            </Text>
          );
        })}
        {windowed ? <Text dimColor>{`  ${chStart ? `… ${chStart} above · ` : ''}${rows.length - chStart - shownCount} more below`}</Text> : null}
      </Box>
      {blast.length ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <Heading terminal={{}}>Blast radius</Heading>
          {blast.map((b) => (
            <Text key={b.symbol + b.hunkId} wrap="truncate">
              {safe(
                `${b.symbol}: ${plural(b.callers.length, 'unchanged caller')} — ${b.callers
                  .slice(0, 3)
                  .map((c) => `${c.file}:${c.line}`)
                  .join(', ')}`,
              )}
            </Text>
          ))}
        </Box>
      ) : null}
      {tour.existingThreads.length ? <Text dimColor>{plural(tour.existingThreads.length, 'existing review thread')} shown inline.</Text> : null}
      {tour.overview && diagramBelowH >= 6 ? (
        <Box marginTop={1} height={diagramBelowH} overflow="hidden" flexShrink={0}>
          <DiagramView graph={tour.overview} width={leftW} height={diagramBelowH} interactive={false} />
        </Box>
      ) : null}
    </Box>
  );

  const screen = (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Box>
        <Box flexShrink={1}>
          <Text wrap="truncate">
            <Text color="cyan" bold>
              {safe(tour.repo)}
            </Text>
            <Text bold color={ROLES.title}>
              {' '}
              #{tour.pr} {safe(tour.title)}
            </Text>
            <Text dimColor>
              {'  '}by {safe(tour.author)} · {safe(tour.headSha.slice(0, 8))} · {tour.mode === 'agent' ? 'guided' : 'plain mode'}
            </Text>
          </Text>
        </Box>
        <Box flexGrow={1} />
        {props.analyzing ? <Busy text={props.analyzing} /> : null}
      </Box>
      <Box flexDirection="row" height={bodyH} overflow="hidden" marginTop={1}>
        {left}
        {wide && tour.overview ? (
          <Box flexDirection="column" marginLeft={2} width={rightW} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor="gray" paddingLeft={1}>
            <Text>
              <Heading terminal={{ dimColor: true }}>Overview</Heading>
              <Text dimColor> · </Text>
              <Key k="d" />
              <Text dimColor> to explore</Text>
            </Text>
            <DiagramView graph={tour.overview} width={rightW - 2} height={bodyH - 2} interactive={false} />
          </Box>
        ) : null}
      </Box>
      {overlay === 'ask' ? <AskOverlay target="the whole PR" agent={props.agent} aiOff={props.aiOff} width={width - 2} height={askHeight} onClose={() => setOverlay('none')} /> : null}
      <Text> </Text>
      <KeyBar
        width={width}
        accent
        // Keys hinted where they apply on screen (D, f, d beside the overview, r under a cut-off
        // description) stay off the bar.
        keys={reviewBriefingBar({
          start: props.resume ?? 'start',
          agent: !!props.agent,
          readDescription: descAll.length <= desc.length,
          diagram: !(wide && tour.overview),
          feedback: !!props.onFeedback,
          checks: !!props.onChecks,
          theme: !!props.onTheme,
        })}
        end={[
          ['?', 'keys'],
          ['q', props.onBack ? 'PR list' : 'quit'],
        ]}
      />
    </Box>
  );
  if (overlay === 'help' && props.active !== false)
    return (
      <HelpPopup
        background={screen}
        width={width}
        height={height}
        title="briefing"
        sections={helpOf(REVIEW_BRIEFING_KEYS)}
        legend={reviewLegend()}
        note={HELP_NOTE}
        onClose={() => setOverlay('none')}
      />
    );
  return screen;
}

// A section heading in the theme's heading color; with the terminal's colors, styled as before.
export function Heading(props: { terminal: { color?: string; dimColor?: boolean }; children: ReactNode }) {
  const { heading } = useTheme();
  return (
    <Text bold {...(heading ? { color: heading } : props.terminal)}>
      {props.children}
    </Text>
  );
}
