import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useInput } from './input.js';
import { Box, Text, useSelected, useTheme } from './themed.js';
import { ROLES } from './theme.js';
import type { Chapter, ChapterOrder, Flag, Tour } from '../types.js';
import { chapterState, meter, ORDER_LABEL, pad, progress, riskMark, stateMark, type States } from './nav.js';
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
import { HelpPopup } from './Help.js';
import { ReviewPopup } from './ReviewPopup.js';
import { CommandPalette, type PaletteItem } from './CommandPalette.js';
import { reviewLegend } from './legend.js';
import { REVIEW_BRIEFING_KEYS, reviewBriefingBar } from './screenKeys.js';
import { PALETTE_HINT } from './chapter/keys.js';
import { plural } from './plural.js';
import { G } from './glyphs.js';
import { TONE_COLOR, unboundKey, useFlash } from './flash.js';
import { helpOf, readsKey } from './keys.js';
import { hasSidePanel } from './breakpoints.js';
import { TitleBar } from './TitleBar.js';

// Rows each block may take; the chapters get the rest of the screen.
const BUDGET = { intent: 4, description: 6, flags: 3, reviews: 2, blast: 2 };
const BRIEFING_PROSE = 88;

// File references the briefing model puts in its summary, such as "(src/x.ts:31-42; y.ts:3)".
// The chapter rows already know their files; in chapter narration, where the code is on
// screen, they stay. Only a parenthesis holding nothing but references goes, and a reference
// has a slash or a line number: "(Node.js)" and "(v2.3)" are prose.
const REF_GROUP = /\s*\(((?:\s*[\w./@-]+\.\w+(?::\d+(?:-\d+)?)?\s*[;,]?)+)\)/g;
const isFileRef = (ref: string) => ref.includes('/') || /\.\w+:\d+(?:-\d+)?$/.test(ref);
export function stripFileRefs(text: string): string {
  return text.replace(REF_GROUP, (group, refs: string) =>
    refs
      .split(/[\s;,]+/)
      .filter(Boolean)
      .every(isFileRef)
      ? ''
      : group,
  );
}

// A flag as a row of the Watch for table: a short label, and its sentence as the detail.
const FLAG_LABEL: Record<string, string> = {
  'scope-creep': 'outside the stated scope',
  'generated-out-of-sync': 'generated file may be stale',
  'large-pr': 'large PR',
  'no-entry-point': 'no entry point found',
  'model-unavailable': 'model unavailable',
  'missing-change': 'possibly missing change',
  info: 'note',
};
function flagRow(f: Flag): { label: string; detail: string; color?: string; mark: string } {
  const label = f.kind === 'generated-out-of-sync' && /lockfile/i.test(f.message) ? 'lockfile may be stale' : (FLAG_LABEL[f.kind] ?? f.kind.replace(/-/g, ' '));
  const color = FLAG_COLOR[f.kind];
  return { label, detail: f.message, color: color === 'gray' ? undefined : color, mark: color === 'gray' ? G.note : G.flag };
}

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
  notice?: string; // news to show until a key is pressed, such as a review just posted
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
  const { flash, show: showFlash, dismiss: dismissFlash } = useFlash();
  const [noticeSeen, setNoticeSeen] = useState<string>();
  const notice = props.notice && props.notice !== noticeSeen ? props.notice : undefined;
  const [overlay, setOverlay] = useState<'none' | 'diagram' | 'ask' | 'read' | 'reviews' | 'help' | 'palette'>('none');
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
  const wide = !!tour.overview && hasSidePanel(width);
  const rightW = wide ? Math.min(natural + 2, Math.floor(width * 0.6)) : 0;
  const leftW = wide ? width - rightW - 4 : width - 2;
  // Prose beside a list reads best at a briefing's measure, narrower than a reader's.
  const proseW = Math.min(leftW, BRIEFING_PROSE);
  const intent = useMemo(() => {
    const all = renderMarkdown(stripFileRefs(tour.intent), proseW);
    return all.length > BUDGET.intent ? [...all.slice(0, BUDGET.intent - 1), [...all[BUDGET.intent - 1], { text: ' …', dim: true }]] : all;
  }, [tour.intent, proseW]);
  const descAll = useMemo(() => (tour.description?.trim() ? renderMarkdown(tour.description, proseW) : []), [tour.description, proseW]);

  useInput(
    (input, key) => {
      dismissFlash();
      if (notice) setNoticeSeen(notice);
      if (input === 'j' || key.downArrow) return setSel((s) => Math.min(chapters.length - 1, s + 1));
      if (input === 'k' || key.upArrow) return setSel((s) => Math.max(0, s - 1));
      if (key.return) return props.onStart(sel);
      // A chapter's number opens it.
      if (/^[1-9]$/.test(input)) {
        const row = rows[Number(input) - 1];
        return row && row.ci >= 0 ? props.onStart(row.ci) : undefined;
      }
      if (input === 'n' || input === ' ') return props.onStart();
      if (input === 'd' && tour.overview) return setOverlay('diagram');
      if (input === 'a') return setOverlay('ask');
      if (input === '?' || input === 'h') return setOverlay('help');
      if (input === ':') return setOverlay('palette');
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
      const none = unboundKey(input, key);
      if (none && !readsKey(REVIEW_BRIEFING_KEYS, input)) showFlash(none, 'quiet');
    },
    { isActive: props.active !== false && overlay === 'none' },
  );

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

  // Wide terminals: text on the left, the overview diagram on the right at its natural
  // size (up to 60% of the width). Narrow terminals stack the diagram under the text.
  const askHeight = overlay === 'ask' ? Math.min(14, Math.max(5, height - 10)) : 0;
  const bodyH = height - 4 - askHeight; // title, margin, status line, key bar

  // The briefing is a dashboard with a text budget: the author's description and the chapters
  // (the one thing the keys act on) come first after the intent, and every other block gets a
  // few rows, with the way to read the rest beside it.
  // Missing tests show on each hunk in the chapters, so the briefing leaves that flag out.
  const watch = [...tour.flags.filter((f) => f.kind !== 'missing-tests').map((f) => flagRow(f)), ...tour.notes.map((n) => ({ label: 'note', detail: n, color: undefined, mark: G.note }))];
  const watchShown = watch.slice(0, BUDGET.flags);
  const otherReviews = (tour.existingReviews ?? []).filter((r) => r.author !== tour.author && r.author !== tour.viewer);
  const reviews = otherReviews.slice(-BUDGET.reviews).reverse();
  const blast = tour.blastRadius.filter((b) => b.callers.length).slice(0, BUDGET.blast);
  const rrComments = rr ? rr.comments.slice(0, 3) : [];
  const rrRows = rr ? 1 + rrComments.length + 1 : 0;
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
  const desc = descAll.slice(0, BUDGET.description);
  // A cut between paragraphs would end on a blank row.
  while (desc.length && !desc[desc.length - 1].some((s) => s.text.trim())) desc.pop();
  const topRows = (props.readiness ? 1 : 0) + intent.length + rrRows;
  const restRows =
    (watchShown.length ? watchShown.length + 2 + (watch.length > watchShown.length ? 1 : 0) : 0) +
    (desc.length ? desc.length + 2 : 0) +
    (reviews.length ? reviews.length + 2 : 0) +
    (blast.length ? blast.length + 2 : 0) +
    (tour.existingThreads.length ? 1 : 0);
  // The chapters get what the other blocks leave, and never fewer than five rows.
  const chapterRoom = Math.max(5, bodyH - topRows - 2 - restRows);
  const windowed = rows.length > chapterRoom;
  const shownCount = windowed ? chapterRoom - 1 : rows.length;
  const chStart = windowed ? Math.max(0, Math.min(selRow - Math.floor(shownCount / 2), rows.length - shownCount)) : 0;
  // The marks' legend under the chapters, while there is a spare row for it.
  const legendRow = bodyH - (topRows + 2 + shownCount + (windowed ? 1 : 0) + restRows) > 1;
  const usedRows = topRows + 2 + shownCount + (windowed ? 1 : 0) + restRows + (legendRow ? 1 : 0);
  const diagramBelowH = wide ? 0 : Math.max(0, Math.min(16, bodyH - usedRows - 1));
  const numW = String(rows.length).length;
  const labelW = Math.min(30, Math.max(0, ...watchShown.map((w) => w.label.length)) + 2);

  const left = (
    <Box flexDirection="column" width={leftW}>
      {props.readiness ? <ReadinessLine readiness={props.readiness} width={leftW} hint={!!props.onMerge} /> : null}
      {intent.map((l, i) => (
        <MdLineView key={i} line={l} />
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
          {rrComments.map((c, i) => (
            <Text key={i} wrap="truncate">
              <Text color={c.addressed ? 'green' : 'yellow'}>{c.addressed ? `${G.done} addressed ` : `${G.untested} open      `}</Text>
              {safe(`${c.path ? `${c.path}:${c.line ?? ''} ` : ''}${c.body.replace(/\s+/g, ' ')}`)}
              <Text dimColor> — {safe(c.reason)}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
      {descAll.length ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <SectionHeading title="From the author" width={leftW}>
            {descAll.length > desc.length ? (
              <>
                <Text dimColor>{` · ${plural(descAll.length - desc.length, 'more line')} · `}</Text>
                <Key k="r" />
                <Text dimColor> read all</Text>
              </>
            ) : null}
          </SectionHeading>
          {desc.map((l, i) => (
            <MdLineView key={i} line={l} />
          ))}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1} flexShrink={0}>
        <SectionHeading title="Chapters" width={leftW}>
          <Text bold color="cyan">
            {' '}
            · {ORDER_LABEL[props.order]} order
          </Text>
          <Text bold dimColor>
            {' '}
            · {prog.read + prog.skipped}/{prog.total} hunks done ·{' '}
          </Text>
          <Key k="f" />
        </SectionHeading>
        {rows.slice(chStart, chStart + shownCount).map(({ chapter: c, ci }, k) => {
          const unchanged = ci < 0;
          const st = stateMark(chapterState(tour, c, states));
          const p = progress(tour, states, c.hunkIds);
          const m = meter(p.read + p.skipped, p.total, 4);
          const risk = Math.max(0, ...c.hunkIds.map((id) => tour.hunks[id]?.risk ?? 0));
          const rk = risk >= 2 ? riskMark(risk) : undefined;
          const count = c.optional ? 'optional' : !delta ? `${p.read + p.skipped}/${p.total}` : unchanged ? 'unchanged' : `${c.hunkIds.length} of ${fullCount(c.id)} changed`;
          const tail = `  ${c.optional || unchanged ? '' : `${m.filled}${m.rest} `}${count.padStart(5)} ${rk ? rk.mark : ' '}`;
          const selected = !unchanged && ci === sel;
          const quiet = unchanged || (c.collapsed && !selected);
          const n = String(chStart + k + 1).padStart(numW);
          return (
            <Text key={c.id} {...selectedRow(selected)} dimColor={quiet} wrap="truncate">
              <Text color={selected ? 'cyan' : undefined} dimColor={!selected}>{` ${n} `}</Text>
              <Text color={unchanged ? undefined : st.color}>{st.mark}</Text>{' '}
              <Text color={quiet || selected ? undefined : ROLES.title}>{pad(safe(c.title), Math.max(12, leftW - tail.length - numW - 5))}</Text>
              {c.optional || unchanged ? null : (
                <>
                  {'  '}
                  <Text color="green">{m.filled}</Text>
                  <Text dimColor>{m.rest}</Text>
                </>
              )}
              <Text dimColor>{` ${count.padStart(5)} `}</Text>
              {rk ? <Text color={rk.color}>{rk.mark}</Text> : ' '}
            </Text>
          );
        })}
        {windowed ? <Text dimColor>{`  ${chStart ? `… ${chStart} above · ` : ''}${rows.length - chStart - shownCount} more below`}</Text> : null}
        {/* Where the marks first appear, what they mean; ? then Tab has them all. */}
        {legendRow ? (
          <Text dimColor wrap="truncate">
            {`  ${G.read} read  ${G.skipped} skipped  ${G.deferred} deferred  ${G.unread} unread  ${G.risk} risky  · ? then tab for every mark`}
          </Text>
        ) : null}
      </Box>
      {watchShown.length ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <SectionHeading title="Watch for" width={leftW} />
          {watchShown.map((w, i) => (
            <Text key={i} wrap="truncate">
              {' '}
              <Text color={w.color} dimColor={!w.color}>{`${w.mark} `}</Text>
              <Text color={w.color} dimColor={!w.color}>
                {pad(w.label, labelW)}
              </Text>
              <Text dimColor>{safe(w.detail)}</Text>
            </Text>
          ))}
          {watch.length > watchShown.length ? <Text dimColor>{`   +${watch.length - watchShown.length} more`}</Text> : null}
        </Box>
      ) : null}
      {reviews.length ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <SectionHeading title="Other reviewers" width={leftW}>
            <Text dimColor> · </Text>
            <Key k="V" />
            <Text dimColor> to read all {plural(otherReviews.length, 'review')}</Text>
          </SectionHeading>
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
      {blast.length ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <SectionHeading title="Blast radius" width={leftW} />
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
      <TitleBar
        repo={tour.repo}
        title={`#${tour.pr} ${tour.title}`}
        note={`@${tour.author} · ${tour.headSha.slice(0, 8)} · ${tour.mode === 'agent' ? 'guided' : 'plain mode'}`}
        busy={props.analyzing}
        where="briefing"
        progress={{ done: prog.readLines, total: prog.totalLines, hunks: `${prog.read + prog.skipped}/${prog.total} hunks` }}
        width={width - 2}
      />
      <Box flexDirection="row" height={bodyH} overflow="hidden" marginTop={1}>
        {left}
        {wide && tour.overview ? (
          <Box flexDirection="column" marginLeft={2} width={rightW} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor="gray" paddingLeft={1}>
            <SectionHeading title="Overview" width={rightW - 2}>
              <Text dimColor> · </Text>
              <Key k="d" />
              <Text dimColor> to explore</Text>
            </SectionHeading>
            <DiagramView graph={tour.overview} width={rightW - 2} height={bodyH - 2} interactive={false} />
          </Box>
        ) : null}
      </Box>
      {overlay === 'ask' ? <AskOverlay target="the whole PR" agent={props.agent} aiOff={props.aiOff} width={width - 2} height={askHeight} onClose={() => setOverlay('none')} /> : null}
      {flash ? (
        <Text color={TONE_COLOR[flash.tone]} dimColor={flash.tone === 'quiet'} wrap="truncate">
          {flash.text}
        </Text>
      ) : notice ? (
        <Text color="green" wrap="truncate">
          {safe(notice)}
        </Text>
      ) : (
        <Text> </Text>
      )}
      <KeyBar
        width={width}
        accent
        // Keys hinted where they apply on screen (D, f, d beside the overview, r under a cut-off
        // description) stay off the bar.
        keys={reviewBriefingBar({
          start: props.resume ?? 'start',
          agent: !!props.agent,
          readDescription: descAll.length <= BUDGET.description,
          diagram: !(wide && tour.overview),
          feedback: !!props.onFeedback,
          checks: !!props.onChecks,
          theme: !!props.onTheme,
        })}
        extraEnd={[PALETTE_HINT]}
        end={[
          ['?', 'keys'],
          ['q', props.onBack ? 'PR list' : 'quit'],
        ]}
      />
    </Box>
  );
  // The palette: the briefing's commands, then every chapter to open.
  if (overlay === 'palette' && props.active !== false) {
    const items: PaletteItem[] = [
      { label: props.resume ? `Resume (${props.resume.replace(/^resume · /, '')})` : 'Start reading', key: 'n', run: () => props.onStart() },
      ...(props.agent ? [{ label: 'Ask the model about the whole PR', key: 'a', run: () => setOverlay('ask') }] : []),
      ...(tour.description?.trim() ? [{ label: 'Read the PR description', key: 'r', run: () => setOverlay('read') }] : []),
      ...(tour.overview ? [{ label: 'Explore the overview diagram', key: 'd', run: () => setOverlay('diagram') }] : []),
      { label: 'Change the chapter order', key: 'f', run: () => props.cycleOrder() },
      { label: 'Submit the review', key: 's', run: () => props.onSubmit() },
      ...(props.onMerge ? [{ label: 'Merge the PR', key: 'M', run: () => props.onMerge?.() }] : []),
      ...(props.onChecks ? [{ label: 'Checks and their logs', key: 'c', run: () => props.onChecks?.() }] : []),
      ...(props.onTheme ? [{ label: 'Color theme', key: 'L', run: () => props.onTheme?.() }] : []),
      ...chapters.map((c, i) => ({ label: `Go to chapter ${i + 1}: ${c.title}`, detail: plural(c.hunkIds.length, 'hunk'), run: () => props.onStart(i) })),
    ];
    return (
      <ReviewPopup background={screen} width={width} height={height} maxWidth={Math.min(90, width - 4)} maxHeight={Math.min(height - 4, 22)} tone="input">
        {(w, h) => <CommandPalette items={items} width={w} height={h} onClose={() => setOverlay('none')} />}
      </ReviewPopup>
    );
  }
  // The overview diagram floats over the briefing, which stays in view around it.
  if (overlay === 'diagram' && tour.overview && props.active !== false) {
    const graph = tour.overview;
    return (
      <ReviewPopup background={screen} width={width} height={height} maxWidth={Math.max(40, Math.floor(width * 0.85))} maxHeight={Math.max(10, Math.floor(height * 0.85))}>
        {(w, h) => (
          <DiagramView
            graph={graph}
            width={w}
            height={h}
            onClose={() => setOverlay('none')}
            onJump={(hid) => {
              const c = chapters.findIndex((ch) => ch.hunkIds.includes(hid));
              props.onStart(c >= 0 ? c : undefined);
            }}
          />
        )}
      </ReviewPopup>
    );
  }
  if (overlay === 'help' && props.active !== false)
    return <HelpPopup background={screen} width={width} height={height} title="briefing" sections={helpOf(REVIEW_BRIEFING_KEYS)} legend={reviewLegend()} onClose={() => setOverlay('none')} />;
  return screen;
}

// A section heading: its title in the theme's heading color (bold with the terminal's colors),
// what follows it (counts, a key to press), then a quiet rule to the column's edge, so the eye
// finds where each section starts.
export function SectionHeading(props: { title: string; width: number; children?: ReactNode }) {
  const { heading } = useTheme();
  return (
    <Box width={props.width} flexShrink={0} overflow="hidden">
      <Box flexShrink={0}>
        <Text wrap="truncate">
          <Text bold color={heading}>
            {props.title}
          </Text>
          {props.children}
        </Text>
      </Box>
      {/* One row high and wrapping, so the rule is cut at the edge without an ellipsis. */}
      <Box flexGrow={1} flexShrink={1} minWidth={0} marginLeft={1} height={1} overflow="hidden">
        <Text dimColor>{'─'.repeat(Math.max(0, props.width))}</Text>
      </Box>
    </Box>
  );
}
