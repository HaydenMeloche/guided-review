import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Chapter, ChapterOrder, Tour } from '../types.js';
import { chapterState, ORDER_LABEL, pad, progress, stateMark, type States } from './nav.js';
import { DiagramView } from './DiagramView.js';
import { renderGraph } from '../diagram/text.js';
import { MdLineView, renderMarkdown } from './markdown.js';
import { Reader } from './Panels.js';
import { AskOverlay } from './AskOverlay.js';
import { KeyBar, type AgentCtx } from './ChapterScreen.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';

const FLAG_COLOR: Record<string, string> = {
  'scope-creep': 'magenta',
  'missing-tests': 'red',
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
  order: ChapterOrder;
  cycleOrder: () => void;
  states: States;
  analyzing?: string; // progress line while chapters are still being narrated
  agent?: AgentCtx;
  width: number;
  height: number;
  active?: boolean;
  onStart: (ci?: number) => void;
  onSubmit: () => void;
  onBack?: () => void; // q: back to the PR list; unset, q quits
  onQuit: () => void;
}) {
  const { tour, chapters, states, width, height } = props;
  const [sel, setSel] = useState(0);
  const [overlay, setOverlay] = useState<'none' | 'diagram' | 'ask' | 'read' | 'reviews'>('none');
  useEffect(() => setSel(0), [props.order]);

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
      if (input === '?') return setOverlay('ask');
      if (input === 'f') return props.cycleOrder();
      if (input === 's') return props.onSubmit();
      if (input === 'r' && tour.description?.trim()) return setOverlay('read');
      if (input === 'V' && tour.existingReviews?.some((r) => r.author !== tour.author && r.author !== tour.viewer)) return setOverlay('reviews');
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

  const flags = tour.flags.slice(0, 6);
  const otherReviews = (tour.existingReviews ?? []).filter((r) => r.author !== tour.author && r.author !== tour.viewer);
  const reviews = otherReviews.slice(-3).reverse();
  const rrRows = rr ? 1 + Math.min(5, rr.comments.length) + 1 : 0;
  const otherRows = intent.length + 1 + rrRows + (reviews.length ? reviews.length + 2 : 0) + (flags.length ? flags.length + 1 : 0) + tour.notes.length + (blast.length ? blast.length + 2 : 0);
  // Long chapter lists show a window around the selection instead of every chapter.
  const chapterRoom = Math.max(5, bodyH - otherRows - 3 - 4);
  const windowed = chapters.length > chapterRoom;
  const shownCount = windowed ? chapterRoom - 1 : chapters.length;
  const chStart = windowed ? Math.max(0, Math.min(sel - Math.floor(shownCount / 2), chapters.length - shownCount)) : 0;
  const fixedRows = otherRows + shownCount + (windowed ? 1 : 0) + 3;
  const diagramBelowH = wide ? 0 : Math.max(0, Math.min(16, bodyH - fixedRows - 8));
  // heading + margin + the '… more' line
  const descRoom = Math.max(3, bodyH - fixedRows - (diagramBelowH ? diagramBelowH + 1 : 0) - 4);
  const desc = descAll.slice(0, descRoom);

  const left = (
    <Box flexDirection="column" width={leftW}>
      {intent.map((l, i) => (
        <MdLineView key={i} line={l} />
      ))}
      {descAll.length ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <Text bold dimColor>
            From the author
          </Text>
          {desc.map((l, i) => (
            <MdLineView key={i} line={l} />
          ))}
          {descAll.length > desc.length ? <Text dimColor italic>{`… ${descAll.length - desc.length} more line(s): r to read it all`}</Text> : null}
        </Box>
      ) : null}
      {rr ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <Text color="cyan" bold>
            Re-review since {safe(rr.previousHead.slice(0, 8))}: {rr.newHunkIds.length} new or changed hunk(s)
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
      {reviews.length ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <Text bold color="cyan">
            Other reviewers · V to read all {otherReviews.length} review(s)
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
      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        <Text bold>
          Chapters <Text color="cyan">· {ORDER_LABEL[props.order]} order</Text>
          <Text dimColor>
            {' '}
            · {prog.read + prog.skipped}/{prog.total} hunks done
          </Text>
        </Text>
        <Text dimColor>
          {props.order === 'flow'
            ? 'Recommended reading path through the changed flows'
            : props.order === 'risk'
              ? 'Highest-risk chapters first'
              : props.order === 'size'
                ? 'Fewest changed lines first'
                : 'Files in path order'}{' '}
          · f to change
        </Text>
        {chapters.slice(chStart, chStart + shownCount).map((c, k) => {
          const i = chStart + k;
          const st = stateMark(chapterState(tour, c, states));
          const meta = ` ${c.hunkIds.length} hunk(s)${c.optional ? ' · optional' : c.kind !== 'flow' ? ` · ${c.kind}` : ''}`;
          return (
            <Text key={c.id} inverse={i === sel} dimColor={c.collapsed && i !== sel} wrap="truncate">
              <Text color={st.color}>{st.mark}</Text> {pad(safe(c.title), Math.max(20, leftW - meta.length - 3))}
              <Text dimColor>{meta}</Text>
            </Text>
          );
        })}
        {windowed ? <Text dimColor>{`  ${chStart ? `… ${chStart} above · ` : ''}${chapters.length - chStart - shownCount} more below`}</Text> : null}
      </Box>
      {blast.length ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <Text bold>Blast radius</Text>
          {blast.map((b) => (
            <Text key={b.symbol + b.hunkId} wrap="truncate">
              {safe(
                `${b.symbol}: ${b.callers.length} unchanged caller(s) — ${b.callers
                  .slice(0, 3)
                  .map((c) => `${c.file}:${c.line}`)
                  .join(', ')}`,
              )}
            </Text>
          ))}
        </Box>
      ) : null}
      {tour.existingThreads.length ? <Text dimColor>{tour.existingThreads.length} existing review thread(s) are shown inline.</Text> : null}
      {tour.overview && diagramBelowH >= 6 ? (
        <Box marginTop={1} height={diagramBelowH} overflow="hidden" flexShrink={0}>
          <DiagramView graph={tour.overview} width={leftW} height={diagramBelowH} interactive={false} />
        </Box>
      ) : null}
    </Box>
  );

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Text wrap="truncate">
        <Text color="cyan" bold>
          {safe(tour.repo)}
        </Text>
        <Text bold>
          {' '}
          #{tour.pr} {safe(tour.title)}
        </Text>
        <Text dimColor>
          {'  '}by {safe(tour.author)} · {safe(tour.headSha.slice(0, 8))} · {tour.mode === 'agent' ? 'guided' : 'plain mode'}
        </Text>
      </Text>
      <Box flexDirection="row" height={bodyH} overflow="hidden" marginTop={1}>
        {left}
        {wide && tour.overview ? (
          <Box flexDirection="column" marginLeft={2} width={rightW} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor="gray" paddingLeft={1}>
            <Text bold dimColor>
              Overview <Text dimColor>· d to explore</Text>
            </Text>
            <DiagramView graph={tour.overview} width={rightW - 2} height={bodyH - 2} interactive={false} />
          </Box>
        ) : null}
      </Box>
      {overlay === 'ask' ? <AskOverlay target="the whole PR" agent={props.agent} width={width - 2} height={askHeight} onClose={() => setOverlay('none')} /> : null}
      {props.analyzing ? <Text color="yellow">⟳ {safe(props.analyzing)} (you can start reading now)</Text> : <Text> </Text>}
      <KeyBar
        width={width}
        keys={[
          ['n', 'start / resume'],
          ['enter', 'open chapter'],
          ['j/k', 'select'],
          ['f', 'change order'],
          ['r', 'read description'],
          ['V', 'other reviews'],
          ['d', 'overview diagram'],
          ['?', 'ask about the PR'],
          ['s', 'submit'],
          ...((props.onBack
            ? [
                ['q', 'PR list'],
                ['Q', 'quit'],
              ]
            : [['q', 'quit']]) as [string, string][]),
        ]}
      />
    </Box>
  );
}
