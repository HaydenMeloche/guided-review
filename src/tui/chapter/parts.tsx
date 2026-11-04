import React from 'react';
import { Box, Text, useSelected } from '../themed.js';
import type { Chapter, ChapterOrder, DiffFile, Draft, Hunk, Tour } from '../../types.js';
import { asideHunkIds, changedLineCount, chapterState, hunkPosition, meter, ORDER_LABEL, pad, progress, riskMark, stateMark, stateOf, summaryHunkIds, truncate, type States } from '../nav.js';
import { safe } from './text.js';
import { ROLES } from '../theme.js';
import { TONE_COLOR, type Flash } from '../flash.js';
import { draftsAt } from './lineNotes.js';
import { MdLineView, type MdLine } from '../markdown.js';
import { plural } from '../plural.js';
import { Hints, KeyBar } from '../KeyBar.js';
import { G } from '../glyphs.js';
import { LabelChip } from '../CommentEditor.js';
import { TitleBar } from '../TitleBar.js';
import { fileIcon } from '../icons.js';

export const COVERAGE = {
  get tested() {
    return { mark: G.tested, color: 'green', text: 'tested' };
  },
  get partial() {
    return { mark: G.partial, color: 'yellow', text: 'partly tested' };
  },
  get untested() {
    return { mark: G.untested, color: 'red', text: 'untested' };
  },
  'n/a': { mark: ' ', color: 'gray', text: '' },
};

// The chapter screen's title bar. `busy`: background work, shown quietly at the right; `pushed`: a
// folded new-head notice; `where`: the chapter and hunk.
export const Header = React.memo(function Header(props: {
  tour: Tour;
  prog: ReturnType<typeof progress>;
  order: ChapterOrder;
  deltaOnly: boolean;
  width: number;
  busy?: string;
  pushed?: boolean;
  where?: string;
}) {
  const { tour, prog } = props;
  // A re-review says which hunks it is showing, so the hidden ones are never a surprise.
  const badge = !tour.rereview ? '' : props.deltaOnly ? 'changes only' : 'full review';
  return (
    <TitleBar
      repo={tour.repo}
      title={`#${tour.pr} ${tour.title}`}
      busy={props.busy}
      tags={
        badge || props.pushed ? (
          <>
            {props.pushed ? <Text color="yellow">{`${G.up} new head · R `}</Text> : null}
            {badge ? (
              <Text color={props.deltaOnly ? 'yellow' : 'cyan'} bold>
                {badge}
              </Text>
            ) : null}
          </>
        ) : undefined
      }
      where={props.where}
      progress={{ done: prog.readLines, total: prog.totalLines, hunks: `${prog.read + prog.skipped}/${prog.total} hunks · ${ORDER_LABEL[props.order]}` }}
      width={props.width}
    />
  );
});

// `listed` is every chapter to show; one not in `chapters` (left out of a re-review) is greyed.
// Each row reads like the briefing's: its number, reading state, title, a small meter, the
// count done, and a ▲ when it is risky.
export const ChapterList = React.memo(function ChapterList(props: {
  tour: Tour;
  chapters: Chapter[];
  listed: Chapter[];
  states: States;
  current: string;
  focusedRow?: number; // the list has focus (Tab): this row is selected for Enter
  width: number;
  height: number;
}) {
  const { tour, chapters, listed, states, current, width } = props;
  const at = props.focusedRow ?? listed.findIndex((c) => c.id === current);
  const start = Math.max(0, Math.min(at - Math.floor(props.height / 2), listed.length - props.height));
  const numW = String(listed.length).length;
  const selectedRow = useSelected();
  return (
    <Box flexDirection="column" width={width}>
      {listed.slice(start, start + props.height).map((full, k) => {
        const shown = chapters.find((d) => d.id === full.id);
        const unchanged = !shown;
        const c = shown ?? full;
        const here = c.id === current;
        const st = stateMark(chapterState(tour, c, states));
        const risk = Math.max(0, ...c.hunkIds.map((id) => tour.hunks[id]?.risk ?? 0));
        const rk = risk >= 2 ? riskMark(risk) : undefined;
        const p = progress(tour, states, c.hunkIds);
        const m = meter(p.read + p.skipped, p.total, 4);
        const count = c.optional ? ' opt' : `${p.read + p.skipped}/${p.total}`.padStart(5);
        const titleW = Math.max(4, width - numW - 3 - (c.optional ? 5 : 10) - 2);
        return (
          <Text key={c.id} inverse={here && props.focusedRow === undefined} {...selectedRow(props.focusedRow === start + k)} dimColor={unchanged || (c.collapsed && !here)} wrap="truncate">
            <Text dimColor={!here}>{String(start + k + 1).padStart(numW)}</Text> <Text color={unchanged ? undefined : st.color}>{st.mark}</Text> {pad(safe(c.title), titleW)}
            {c.optional ? null : (
              <>
                {' '}
                <Text color="green">{m.filled}</Text>
                <Text dimColor>{m.rest}</Text>
              </>
            )}
            <Text dimColor>{count}</Text> {rk ? <Text color={rk.color}>{rk.mark}</Text> : ' '}
          </Text>
        );
      })}
    </Box>
  );
});

// The tab for linked tests that are not on screen: what is there, then t as a keycap, in the key
// bar's style.
function TestDrawer(props: { label: string }) {
  return (
    <Box flexShrink={0} marginLeft={1}>
      <Hints keys={[['t', props.label]]} />
    </Box>
  );
}

// One row: the chapter, and where the hunk is in it. The hunk's own state and where it is in the
// code go right above the diff (HunkLocation).
export const ChapterTitle = React.memo(function ChapterTitle(props: { chapter: Chapter; hunk?: Hunk; hi: number; unchanged?: number; width: number }) {
  const { chapter, hunk, hi } = props;
  const at = hunkPosition(chapter, hi);
  return (
    <Box width={props.width} flexShrink={0}>
      <Text wrap="truncate">
        <Text bold color={ROLES.heading}>
          {truncate(safe(chapter.title), Math.floor(props.width * 0.45))}
        </Text>
        {hunk ? (
          <>
            <Text dimColor>
              {' '}
              · hunk {at.n}/{at.total}
            </Text>
            {hunk.importOnly ? <Text dimColor> · imports only · optional</Text> : null}
          </>
        ) : chapter.collapsed ? (
          <Text dimColor>{` · ${plural(chapter.hunkIds.length, 'hunk')}, collapsed${chapter.optional ? ' · optional: not counted toward progress' : ''}`}</Text>
        ) : chapter.folded?.length ? (
          <Text dimColor>{` · summary of ${plural(summaryHunkIds(chapter).length, 'lockfile hunk')} · n for the other ${plural(pageCount(chapter), 'hunk')}`}</Text>
        ) : null}
        {props.unchanged ? <Text dimColor> · {props.unchanged} unchanged hidden</Text> : null}
        {chapter.entryPoint ? <Text dimColor> · entry {safe(chapter.entryPoint)}</Text> : null}
      </Text>
    </Box>
  );
});

// Where a hunk is in the code, in `width` columns: the declaration it changes, then its file and
// line. The declaration leads, so a run of hunks in one function reads as one; when the row is
// short the path loses its leading directories first, then is cut at the end.
export function hunkLocation(hunk: Hunk, width: number): { symbol: string; path: string } {
  const name = hunk.symbols[0]?.split('.').pop() ?? '';
  const symbol = name ? `${name}${hunk.symbols.length > 1 ? ` +${hunk.symbols.length - 1}` : ''}` : '';
  // A deleted file's hunk has no new lines: point at where it was.
  const line = `:${hunk.newStart || hunk.oldStart}`;
  const icon = fileIcon(hunk.file);
  const room = Math.max(0, width - (symbol ? symbol.length + 3 : 0)); // " · "
  const dirs = hunk.file.split('/');
  let path = `${icon}${hunk.file}${line}`;
  for (let i = 1; path.length > room && i < dirs.length; i++) path = `${icon}…/${dirs.slice(i).join('/')}${line}`;
  return { symbol: truncate(safe(symbol), width), path: truncate(safe(path), room) };
}

// The hunk's read mark, NEW when it changed since your last review, and where it is in the code.
export function HunkLocation(props: { hunk: Hunk; states: States; isNew: boolean; width: number }) {
  const st = stateMark(stateOf(props.states, props.hunk));
  const lead = st.mark.length + 1 + (props.isNew ? 6 : 0); // "✓ ", " NEW "
  const { symbol, path } = hunkLocation(props.hunk, props.width - lead);
  return (
    <Text wrap="truncate">
      <Text color={st.color}>{st.mark} </Text>
      {props.isNew ? (
        <>
          <Text color="black" backgroundColor="yellow">
            {' NEW '}
          </Text>{' '}
        </>
      ) : null}
      {symbol ? <Text bold>{symbol}</Text> : null}
      {symbol && path ? <Text dimColor> · </Text> : null}
      {path ? <Text dimColor>{path}</Text> : null}
    </Text>
  );
}

// The hunks of a chapter with a page of their own (not read on its summary or a manifest's page).
function pageCount(chapter: Chapter): number {
  const aside = asideHunkIds(chapter);
  return chapter.hunkIds.filter((id) => !aside.has(id)).length;
}

// A lockfile pair's package changes, under its manifest's diff (lockListLines).
export function LockfileChanges(props: { lines: MdLine[]; width: number; height: number }) {
  return (
    <Box flexDirection="column" width={props.width} height={props.height + 1} flexShrink={0} overflow="hidden">
      <Text> </Text>
      {props.lines.map((l, i) => (
        <MdLineView key={i} line={l} />
      ))}
    </Box>
  );
}

// Renders only the visible window of a collapsed chapter, which can hold thousands of generated hunks.
// A file's first row carries its summary; a file with more hunks than one gets a row per hunk,
// marked with its line and its own counts.
export const CollapsedSummary = React.memo(function CollapsedSummary(props: {
  hunks: Tour['hunks'];
  files: Map<string, DiffFile>;
  ids: string[]; // summaryHunkIds of the chapter
  states: States;
  sel: number;
  width: number;
  height: number;
}) {
  const { hunks, files, ids, states, width } = props;
  const { firstOfFile, rowsOfFile } = React.useMemo(() => {
    const first = new Set<string>();
    const count = new Map<string, number>();
    for (const id of ids) {
      const file = hunks[id]?.file ?? id;
      if (!count.has(file)) first.add(id);
      count.set(file, (count.get(file) ?? 0) + 1);
    }
    return { firstOfFile: first, rowsOfFile: count };
  }, [hunks, ids]);
  const total = ids.length;
  const pathWidth = Math.floor(width * 0.45);
  const top = Math.max(0, Math.min(props.sel - Math.floor(props.height / 2), total - props.height));
  const rows = ids.slice(top, top + Math.max(0, props.height)).map((id, k) => {
    const i = top + k;
    const h = hunks[id];
    const file = h?.file ?? id;
    const f = h ? files.get(h.file) : undefined;
    const st = stateMark(stateOf(states, h));
    const at = h && (rowsOfFile.get(file) ?? 0) > 1 ? `:${h.newStart || h.oldStart}` : '';
    let detail: string;
    if (!firstOfFile.has(id) && h) {
      const add = h.lines.filter((l) => l.kind === 'add').length;
      detail = `+${add} −${changedLineCount(h) - add}`;
    } else detail = f?.summary ?? `${f?.kindReason ? `${f.kindReason} · ` : ''}+${f?.additions ?? 0} −${f?.deletions ?? 0}`;
    return (
      <Text key={id} inverse={i === props.sel}>
        <Text color={st.color}>{st.mark}</Text> {pad(truncate(file, pathWidth - at.length) + at, pathWidth)} <Text dimColor>{truncate(detail, Math.floor(width * 0.5))}</Text>
      </Text>
    );
  });
  return (
    <Box flexDirection="column" height={props.height} overflow="hidden">
      {rows}
    </Box>
  );
});

// The row above the key bar: a message after a key press when there is one, else an open range
// (yellow, with what it is for), else your drafts on the cursor line, else where you are: the
// hunk, the line, the drafts waiting, how the hunk is tested.
export function StatusRow(props: { drafts: Draft[]; hunk?: Hunk; cursor: number; flash?: Flash; range?: string; position?: string; width: number }) {
  const pending = props.drafts.filter((d) => !d.posted);
  if (props.flash)
    return (
      <Text color={TONE_COLOR[props.flash.tone]} dimColor={props.flash.tone === 'quiet'} wrap="truncate">
        {truncate(props.flash.text, props.width)}
      </Text>
    );
  if (props.range)
    return (
      <Text wrap="truncate">
        <Text color="yellow" bold>
          {`RANGE ${safe(props.range)}`}
        </Text>
        <Text dimColor> · c comment · a ask · esc clear</Text>
      </Text>
    );
  const l = props.hunk?.lines[props.cursor];
  const here = props.hunk && l ? draftsAt(props.drafts, props.hunk, l.kind === 'del' ? l.oldLine : l.newLine, l.kind === 'del' ? 'LEFT' : 'RIGHT') : [];
  if (here.length)
    return (
      <Text wrap="truncate">
        {`${G.draft} `}
        {here.map((d) => (
          <Text key={d.id}>
            <LabelChip label={d.label} />
            {` ${safe(d.body.replace(/\s+/g, ' '))}  `}
          </Text>
        ))}
      </Text>
    );
  const cov = props.hunk ? COVERAGE[props.hunk.coverage] : undefined;
  return (
    <Text wrap="truncate">
      {props.position ? <Text>{props.position}</Text> : null}
      <Text dimColor>{`${props.position ? ' · ' : ''}${G.draft} ${plural(pending.length, 'draft')}`}</Text>
      {cov?.text ? <Text color={cov.color}>{` · ${cov.mark} ${cov.text}`}</Text> : null}
    </Text>
  );
}

// Below the sidebar's width, one line says where you are and what comes next, in place of the
// chapter list: "1/7 Order API: route → pricing · hunk 4/8 · next: Supporting changes (2) · ]".
export const ChapterStrip = React.memo(function ChapterStrip(props: { tour: Tour; chapters: Chapter[]; ci: number; hi: number; order: ChapterOrder; width: number }) {
  const { chapters, ci } = props;
  const c = chapters[ci];
  const nextChapter = chapters.slice(ci + 1).find((x) => !x.optional) ?? chapters[ci + 1];
  const hunkAt = props.hi >= 0 && c ? ` · hunk ${hunkPosition(c, props.hi).n}/${hunkPosition(c, props.hi).total}` : '';
  const tail = nextChapter ? ` · next: ${safe(nextChapter.title)} (${nextChapter.hunkIds.length}) · ` : ` · last chapter · ${ORDER_LABEL[props.order]} order`;
  return (
    <Text wrap="truncate">
      <Text color="cyan" bold>{`${ci + 1}/${chapters.length} `}</Text>
      <Text bold>{truncate(safe(c?.title ?? ''), Math.max(10, Math.floor(props.width * 0.45)))}</Text>
      <Text dimColor>{hunkAt}</Text>
      <Text dimColor>{tail}</Text>
      {nextChapter ? (
        <Text color="cyan" bold>
          ]
        </Text>
      ) : null}
    </Text>
  );
});

// The explanation above the code, already cut to fit (chapterLayout).
// An in-flow block with a left rule, not a box: it is always in the same place, so a frame and a
// title would only cost rows. The rule is quiet, magenta for narration that is the model's
// inference, and green for a moment when the explanation has just arrived.
// Under it, right above the code, a row with where the hunk is (HunkLocation) on the left and
// `drawer`, the tab for linked tests not on screen, on the right.
export function Explanation(props: {
  lines: MdLine[];
  inferred: boolean;
  collapsed: boolean;
  updated?: boolean;
  focused?: boolean;
  width: number;
  hunk?: Hunk;
  states?: States;
  isNew?: boolean;
  drawer?: string;
}) {
  if (!props.lines.length && !props.hunk) return null;
  const rule = props.focused ? 'cyan' : props.updated ? 'green' : props.inferred ? 'magenta' : 'gray';
  const drawerWidth = props.drawer ? props.drawer.length + 4 : 0; // margin, "t ", label
  return (
    <Box flexDirection="column" flexShrink={0} width={props.width}>
      {props.lines.map((l, i) => (
        <Box key={i}>
          <Text color={rule}>{'▎ '}</Text>
          <Box flexGrow={1}>
            <MdLineView line={l} />
          </Box>
          {i === 0 && props.updated ? <Text color="green"> updated</Text> : null}
        </Box>
      ))}
      <Box height={1}>
        <Box flexGrow={1} flexShrink={1}>
          {props.hunk ? <HunkLocation hunk={props.hunk} states={props.states ?? {}} isNew={!!props.isNew} width={props.width - drawerWidth} /> : null}
        </Box>
        {props.drawer ? <TestDrawer label={props.drawer} /> : null}
      </Box>
    </Box>
  );
}

export function MoveList(props: { chapters: Chapter[]; sel: number; width: number }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Move this hunk to…</Text>
      {props.chapters.map((c, i) => (
        <Text key={c.id} inverse={i === props.sel}>
          {truncate(`${c.title}`, props.width - 6)}
        </Text>
      ))}
      <Hints
        keys={[
          ['j/k', 'choose'],
          ['enter', 'move'],
          ['esc', 'cancel'],
        ]}
      />
    </Box>
  );
}

// A tour, or a re-review's changes, with nothing to show.
export function EmptyChapter(props: { deltaOnly: boolean; width: number }) {
  return (
    <Box flexDirection="column">
      <Text>{props.deltaOnly ? 'Nothing changed since your last review. Press D to show the whole tour.' : 'This PR has no changes to review.'}</Text>
      <KeyBar
        width={props.width}
        keys={[
          ['D', 'whole tour'],
          ['s', 'submit'],
          ['q', 'briefing'],
          ['Q', 'quit'],
        ]}
      />
    </Box>
  );
}
