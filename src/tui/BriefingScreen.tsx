import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useInput } from './input.js';
import { Box, Text, useSelected, useTheme } from './themed.js';
import { ROLES } from './theme.js';
import type { Chapter, ChapterOrder, Draft, ExistingThread, Tour } from '../types.js';
import { chapterState, meter, ORDER_LABEL, pad, progress, stateMark, type States } from './nav.js';
import { chapterNotes, chapterSize } from './chapter/lineNotes.js';
import { DiagramView } from './DiagramView.js';
import { renderGraph } from '../diagram/text.js';
import { MdLineView, renderMarkdown } from './markdown.js';
import { Reader } from './Panels.js';
import { AskOverlay } from './AskOverlay.js';
import { hasSummary, SummaryPanel } from './SummaryPanel.js';
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
import { Confirm } from './Confirm.js';

// Rows each block may take. The chapters take their own rows, and the description, last on the
// screen, gets what is left; when it is long, it is cut with a note at the bottom and r reads it.
const BUDGET = { reviews: 2, descriptionMin: 5 };
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

// One screen: the goal, an overview diagram, the chapter list with reading state
// and size, and anything flagged up front.
// "3 open review threads and 2 resolved", or just the one kind when the PR has only that.
function threadCounts(threads: ExistingThread[]): string {
  const resolved = threads.filter((t) => t.isResolved).length;
  const open = threads.length - resolved;
  if (!resolved) return plural(open, 'open review thread');
  if (!open) return plural(resolved, 'resolved review thread');
  return `${plural(open, 'open review thread')} and ${resolved} resolved`;
}

export function BriefingScreen(props: {
  tour: Tour;
  chapters: Chapter[];
  allChapters?: Chapter[]; // the whole tour; a re-review greys the chapters `chapters` leaves out
  order: ChapterOrder;
  cycleOrder: () => void;
  deltaOnly?: boolean;
  toggleDelta?: () => void;
  states: States;
  drafts?: Draft[]; // your drafts, counted on each chapter's row
  analyzing?: string; // chapters still being narrated, shown at the header's right end
  writingBriefing?: boolean; // the model's briefing is still being written over this static tour
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
  onTheme?: () => void; // the color theme picker, from the palette (L is the PR list's)
  onRestart?: () => void; // restart the tour: every hunk unread again, from the start
  onBack?: () => void; // esc, q: back to the PR list; unset (a preview), q quits
  onQuit: () => void;
}) {
  const { tour, chapters, states, width, height } = props;
  const selectedRow = useSelected();
  const [sel, setSel] = useState(0);
  const { flash, show: showFlash, dismiss: dismissFlash } = useFlash();
  const [noticeSeen, setNoticeSeen] = useState<string>();
  const notice = props.notice && props.notice !== noticeSeen ? props.notice : undefined;
  const [overlay, setOverlay] = useState<'none' | 'diagram' | 'ask' | 'read' | 'summary' | 'reviews' | 'help' | 'palette' | 'restart'>('none');
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
  // The briefing reorders flow chapters when it lands; the selection stays on its chapter.
  const [plainChapters, setPlainChapters] = useState<Chapter[]>();
  if (tour.mode === 'plain' && plainChapters !== chapters) setPlainChapters(chapters);
  if (tour.mode === 'agent' && plainChapters) {
    setPlainChapters(undefined);
    const i = chapters.findIndex((c) => c.id === plainChapters[sel]?.id);
    if (i >= 0 && i !== sel) setSel(i);
  }

  // Per-render work over the whole tour is memoized, so j/k only re-renders the list.
  const prog = useMemo(() => progress(tour, states), [tour, states]);
  const natural = useMemo(() => (tour.overview ? Math.max(0, ...renderGraph(tour.overview, Math.floor(width * 0.6)).lines.map((l) => l.length)) : 0), [tour.overview, width]);
  const wide = !!tour.overview && hasSidePanel(width);
  const rightW = wide ? Math.min(natural + 2, Math.floor(width * 0.6)) : 0;
  const leftW = wide ? width - rightW - 4 : width - 2;
  // Prose beside a list reads best at a briefing's measure, narrower than a reader's.
  const proseW = Math.min(leftW, BRIEFING_PROSE);
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
      if (input === 'r' && tour.description?.trim()) return setOverlay('read');
      if (input === 'i' && tour.intent.trim()) return setOverlay('summary');
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
  // Restarting asks first, where the key bar was: y or Enter restarts, any other key keeps reading.
  const reviewed = useMemo(() => {
    const p = progress(tour, states);
    return p.read + p.skipped + p.deferred;
  }, [tour, states]);
  useInput(
    (input, key) => {
      setOverlay('none');
      if (input !== 'y' && !key.return) return;
      props.onRestart?.();
      showFlash(`Tour restarted: ${plural(reviewed, 'hunk')} unread again. n starts from the beginning.`, 'info');
    },
    { isActive: props.active !== false && overlay === 'restart' },
  );

  if (overlay === 'read') {
    return <Reader title={`#${tour.pr} — from the author`} markdown={tour.description ?? ''} width={width} height={height} onClose={() => setOverlay('none')} />;
  }
  // With a model, the summary is written when first opened; without one, the briefing's intent stands in.
  if (overlay === 'summary') {
    if (props.agent) return <SummaryPanel tour={tour} agent={props.agent} width={width} height={height} onClose={() => setOverlay('none')} />;
    return <Reader title={`#${tour.pr} — summary`} markdown={tour.intent} width={width} height={height} closeKey="i" onClose={() => setOverlay('none')} />;
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
  const askHeight = overlay === 'ask' ? Math.min(Math.max(5, height - 10), Math.max(16, Math.floor(height * 0.6))) : 0;
  const bodyH = height - 4 - askHeight; // title, margin, status line, key bar

  // The briefing is a dashboard with a text budget: the chapters (the one thing the keys act on)
  // come first, then the author's description, and the model's summary last; every block but the
  // chapters gets a few rows, with the way to read the rest beside it.
  const otherReviews = (tour.existingReviews ?? []).filter((r) => r.author !== tour.author && r.author !== tour.viewer);
  const reviews = otherReviews.slice(-BUDGET.reviews).reverse();
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
  const topRows = (props.readiness ? 1 : 0) + rrRows;
  // The blocks between the chapters and the description.
  const midRows = (reviews.length ? reviews.length + 2 : 0) + (tour.existingThreads.length ? 1 : 0) + (props.writingBriefing ? 2 : 0);
  // The chapter block: its heading, and a blank row above it when something is above.
  const chapterHead = topRows ? 2 : 1;
  // The chapters keep the description to a few rows at least, and never drop under five rows.
  const descMin = descAll.length ? Math.min(descAll.length + 2, BUDGET.descriptionMin) : 0;
  const chapterRoom = Math.max(5, bodyH - topRows - chapterHead - midRows - descMin);
  const windowed = rows.length > chapterRoom;
  const shownCount = windowed ? chapterRoom - 1 : rows.length;
  const chStart = windowed ? Math.max(0, Math.min(selRow - Math.floor(shownCount / 2), rows.length - shownCount)) : 0;
  const chapterRows = chapterHead + shownCount + (windowed ? 1 : 0);
  // The marks' legend under the chapters, while the description still gets a few rows after it.
  const legendRow = bodyH - topRows - chapterRows - midRows - descMin > 1;
  const fixedRows = topRows + chapterRows + (legendRow ? 1 : 0) + midRows;
  // The description: a blank row, its heading, then its lines; a cut one ends with the note.
  const descRoom = descAll.length ? Math.max(0, bodyH - fixedRows - 2) : 0;
  const descCut = descAll.length > descRoom;
  const desc = descAll.slice(0, descCut ? Math.max(0, descRoom - 1) : descRoom);
  // A cut between paragraphs would end on a blank row.
  while (desc.length && !desc[desc.length - 1].some((s) => s.text.trim())) desc.pop();
  const usedRows = fixedRows + (descAll.length && descRoom ? 2 + desc.length + (descCut ? 1 : 0) : 0);
  const diagramBelowH = wide ? 0 : Math.max(0, Math.min(16, bodyH - usedRows - 1));
  const numW = String(rows.length).length;
  // Each chapter's size, +added −removed, in columns that line up down the list.
  const sizes = new Map(rows.map(({ chapter: c, ci }) => [c.id, ci < 0 ? undefined : chapterSize(tour, c)]));
  const addW = Math.max(0, ...[...sizes.values()].map((z) => (z ? String(z.added).length : 0))) + 1;
  const delW = Math.max(0, ...[...sizes.values()].map((z) => (z ? String(z.removed).length : 0))) + 1;

  const left = (
    <Box flexDirection="column" width={leftW}>
      {props.readiness ? <ReadinessLine readiness={props.readiness} width={leftW} hint={!!props.onMerge} /> : null}
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
      <Box flexDirection="column" marginTop={topRows ? 1 : 0} flexShrink={0}>
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
          const count = c.optional ? 'optional' : !delta ? `${p.read + p.skipped}/${p.total}` : unchanged ? 'unchanged' : `${c.hunkIds.length} of ${fullCount(c.id)} changed`;
          // Where the discussion is: open threads (or resolved ones, when none is open) and your drafts.
          const said = chapterNotes(tour, c, props.drafts ?? []);
          const threadNote = said.open ? `${said.open} open` : said.resolved ? `${said.resolved} resolved` : '';
          const draftNote = said.drafts ? `${G.draft} ${said.drafts}` : '';
          const notes = [threadNote, draftNote].filter(Boolean).join(' · ');
          const size = sizes.get(c.id);
          const added = size ? `+${size.added}`.padStart(addW) : ' '.repeat(addW);
          const removed = size ? `−${size.removed}`.padEnd(delW) : ' '.repeat(delW);
          const tail = `  ${c.optional || unchanged ? '' : `${m.filled}${m.rest} `}${count.padStart(5)}  ${added} ${removed}${notes ? `  ${notes}` : ''}`;
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
              <Text dimColor>{` ${count.padStart(5)}  `}</Text>
              <Text color={quiet || !size?.added ? undefined : 'green'} dimColor={!size?.added}>
                {added}
              </Text>{' '}
              <Text color={quiet || !size?.removed ? undefined : 'red'} dimColor={!size?.removed}>
                {removed}
              </Text>
              {threadNote ? <Text color={said.open ? 'yellow' : undefined} dimColor={!said.open}>{`  ${threadNote}`}</Text> : null}
              {draftNote ? <Text dimColor>{`${threadNote ? ' · ' : '  '}${draftNote}`}</Text> : null}
            </Text>
          );
        })}
        {windowed ? <Text dimColor>{`  ${chStart ? `… ${chStart} above · ` : ''}${rows.length - chStart - shownCount} more below`}</Text> : null}
        {/* Where the marks first appear, what they mean; ? then Tab has them all. */}
        {legendRow ? (
          <Text dimColor wrap="truncate">
            {`  ${G.read} read  ${G.skipped} skipped  ${G.deferred} deferred  ${G.unread} unread  · ? then tab for every mark`}
          </Text>
        ) : null}
      </Box>
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
      {tour.existingThreads.length ? <Text dimColor>{threadCounts(tour.existingThreads)} shown inline.</Text> : null}
      {props.writingBriefing ? (
        <Box marginTop={1} flexShrink={0}>
          <Text dimColor wrap="truncate">
            The model is writing the briefing: its summary (i), chapter titles and order arrive here.
          </Text>
        </Box>
      ) : null}
      {descAll.length > 0 && descRoom > 0 ? (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <SectionHeading title="From the author" width={leftW}>
            {props.agent ? (
              <>
                <Text dimColor> · </Text>
                <Key k="i" />
                <Text dimColor>{hasSummary(tour) ? ' read AI description' : ' generate AI description'}</Text>
              </>
            ) : null}
          </SectionHeading>
          {desc.map((l, i) => (
            <MdLineView key={i} line={l} />
          ))}
          {descCut ? (
            <Text wrap="truncate">
              <Text dimColor>{`… ${plural(descAll.length - desc.length, 'more line')} · `}</Text>
              <Key k="r" />
              <Text dimColor> read all</Text>
            </Text>
          ) : null}
        </Box>
      ) : null}
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
        note={`@${tour.author} · ${tour.headSha.slice(0, 8)} · ${tour.mode === 'agent' || props.writingBriefing ? 'guided' : 'plain mode'}`}
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
      {overlay === 'restart' ? (
        <Confirm yes="restart">Mark the {plural(reviewed, 'hunk')} you went through unread and start the tour over? Drafts stay.</Confirm>
      ) : (
        <KeyBar
          width={width}
          accent
          // Keys hinted where they apply on screen (D, f, d beside the overview, r under a cut-off
          // description, i on its heading) stay off the bar.
          keys={reviewBriefingBar({
            start: props.resume ?? 'start',
            agent: !!props.agent,
            readDescription: !descCut,
            summary: !!props.agent && !descAll.length, // otherwise hinted on the description's heading
            diagram: !(wide && tour.overview),
            feedback: !!props.onFeedback,
            checks: !!props.onChecks,
          })}
          extraEnd={[PALETTE_HINT]}
          end={[
            ['?', 'keys'],
            ['q', props.onBack ? 'PR list' : 'quit'],
          ]}
        />
      )}
    </Box>
  );
  // The palette: the briefing's commands, then every chapter to open.
  if (overlay === 'palette' && props.active !== false) {
    const items: PaletteItem[] = [
      { label: props.resume ? `Resume (${props.resume.replace(/^resume · /, '')})` : 'Start reading', key: 'n', run: () => props.onStart() },
      ...(props.agent ? [{ label: 'Ask the model about the whole PR', key: 'a', run: () => setOverlay('ask') }] : []),
      ...(tour.description?.trim() ? [{ label: 'Read the PR description', key: 'r', run: () => setOverlay('read') }] : []),
      ...(tour.intent.trim()
        ? [{ label: props.agent ? (hasSummary(tour) ? 'Read the AI description' : 'Generate an AI description') : 'Read the summary', key: 'i', run: () => setOverlay('summary') }]
        : []),
      ...(tour.overview ? [{ label: 'Explore the overview diagram', key: 'd', run: () => setOverlay('diagram') }] : []),
      { label: 'Change the chapter order', key: 'f', run: () => props.cycleOrder() },
      { label: 'Submit the review', key: 's', run: () => props.onSubmit() },
      ...(props.onMerge ? [{ label: 'Merge the PR', key: 'M', run: () => props.onMerge?.() }] : []),
      ...(props.onChecks ? [{ label: 'Checks and their logs', key: 'c', run: () => props.onChecks?.() }] : []),
      ...(props.onTheme ? [{ label: 'Color theme', run: () => props.onTheme?.() }] : []),
      ...(props.onRestart && reviewed ? [{ label: 'Restart the tour: mark every hunk unread', run: () => setOverlay('restart') }] : []),
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
