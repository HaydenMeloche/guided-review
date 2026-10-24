import React from 'react';
import { Box, Text } from '../themed.js';
import type { Chapter, ChapterOrder, DiffFile, Draft, Hunk, Tour } from '../../types.js';
import { changedLineCount, chapterState, meter, ORDER_LABEL, pad, progress, riskMark, stateMark, stateOf, truncate, type States } from '../nav.js';
import { safe } from './text.js';
import { ROLES } from '../theme.js';
import { TONE_COLOR, type Flash } from '../flash.js';
import { draftsAt } from './lineNotes.js';
import { MdLineView, type MdLine } from '../markdown.js';
import { plural } from '../plural.js';
import { Hints, KeyBar } from '../KeyBar.js';
import { Busy } from '../Spinner.js';
import { G } from '../glyphs.js';
import { LabelChip } from '../CommentEditor.js';

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

// `busy`: background work, shown quietly at the right; `pushed`: a folded new-head notice.
export const Header = React.memo(function Header(props: { tour: Tour; prog: ReturnType<typeof progress>; order: ChapterOrder; deltaOnly: boolean; width: number; busy?: string; pushed?: boolean }) {
  const { tour, prog, width } = props;
  const m = meter(prog.readLines, prog.totalLines, 12);
  const tail = ` ${m.percent}% · ${prog.read + prog.skipped}/${prog.total} hunks · ${ORDER_LABEL[props.order]}`;
  const right = m.filled + m.rest + tail;
  // A re-review says which hunks it is showing, so the hidden ones are never a surprise.
  const badge = !tour.rereview ? '' : props.deltaOnly ? 'changes only' : 'full review';
  const repo = `${safe(tour.repo)} `;
  const left = `#${tour.pr} ${safe(tour.title)}`;
  const busy = props.busy ? ` ⠿ ${props.busy} ` : '';
  const pushed = props.pushed ? '↑ new head · R ' : '';
  return (
    <Text wrap="truncate">
      <Text dimColor>{repo}</Text>
      <Text bold>{pad(left, Math.max(10, width - right.length - repo.length - (badge ? badge.length + 1 : 0) - busy.length - pushed.length - 1))}</Text>
      {props.busy ? <Busy text={`${props.busy} `} /> : null}
      {pushed ? <Text color="yellow">{pushed}</Text> : null}{' '}
      {badge ? (
        <>
          <Text color={props.deltaOnly ? 'yellow' : 'cyan'} bold>
            {badge}
          </Text>{' '}
        </>
      ) : null}
      <Text color="green">{m.filled}</Text>
      <Text dimColor>{m.rest}</Text>
      <Text bold>{` ${m.percent}%`}</Text>
      <Text dimColor>{tail.slice(` ${m.percent}%`.length)}</Text>
    </Text>
  );
});

// `listed` is every chapter to show; one not in `chapters` (left out of a re-review) is greyed.
export const ChapterList = React.memo(function ChapterList(props: { tour: Tour; chapters: Chapter[]; listed: Chapter[]; states: States; current: string; width: number; height: number }) {
  const { tour, chapters, listed, states, current, width } = props;
  const at = listed.findIndex((c) => c.id === current);
  const start = Math.max(0, Math.min(at - Math.floor(props.height / 2), listed.length - props.height));
  return (
    <Box flexDirection="column" width={width}>
      {listed.slice(start, start + props.height).map((full) => {
        const shown = chapters.find((d) => d.id === full.id);
        const unchanged = !shown;
        const c = shown ?? full;
        const here = c.id === current;
        const st = stateMark(chapterState(tour, c, states));
        const rk = riskMark(Math.max(0, ...c.hunkIds.map((id) => tour.hunks[id]?.risk ?? 0)));
        const p = progress(tour, states, c.hunkIds);
        return (
          <Text key={c.id} inverse={here} dimColor={unchanged || (c.collapsed && !here)}>
            <Text color={unchanged ? undefined : st.color}>{st.mark}</Text>
            <Text color={unchanged ? undefined : rk.color}>{rk.mark}</Text> {pad(safe(c.title), width - 9)}
            <Text dimColor>{c.optional ? ' opt ' : `${String(p.read + p.skipped).padStart(2)}/${String(p.total).padEnd(2)}`}</Text>
          </Text>
        );
      })}
    </Box>
  );
});

// One row: the chapter, where the hunk is in it and in the code, and how it is tested.
// `drawer`: a hint at the right end for linked tests that are not on screen.
export const ChapterTitle = React.memo(function ChapterTitle(props: { chapter: Chapter; hunk?: Hunk; hi: number; isNew: boolean; unchanged?: number; width: number; states: States; drawer?: string }) {
  const { chapter, hunk, hi } = props;
  const cov = hunk ? COVERAGE[hunk.coverage] : undefined;
  const st = hunk ? stateMark(stateOf(props.states, hunk)) : undefined;
  // A deleted file's hunk has no new lines: point at where it was.
  const location = hunk ? `${hunk.file}:${hunk.newStart || hunk.oldStart}` : '';
  return (
    <Box width={props.width} flexShrink={0}>
      <Box flexShrink={1} flexGrow={1}>
        <Text wrap="truncate">
          <Text bold color={ROLES.heading}>
            {truncate(safe(chapter.title), Math.floor(props.width * 0.45))}
          </Text>
          {hunk ? (
            <>
              <Text dimColor>
                {' '}
                · hunk {hi + 1}/{chapter.hunkIds.length} ·{' '}
              </Text>
              {st ? <Text color={st.color}>{st.mark} </Text> : null}
              {props.isNew ? (
                <>
                  <Text color="black" backgroundColor="yellow">
                    {' NEW '}
                  </Text>{' '}
                </>
              ) : null}
              <Text>{safe(location)}</Text>
              {cov && cov.text ? <Text color={cov.color}>{`  ${cov.mark} ${cov.text}`}</Text> : null}
              {hunk.importOnly ? <Text dimColor> · imports only · optional</Text> : null}
            </>
          ) : chapter.collapsed ? (
            <Text dimColor>{` · ${plural(chapter.hunkIds.length, 'hunk')}, collapsed${chapter.optional ? ' · optional: not counted toward progress' : ''}`}</Text>
          ) : null}
          {props.unchanged ? <Text dimColor> · {props.unchanged} unchanged hidden</Text> : null}
          {chapter.entryPoint ? <Text dimColor> · entry {safe(chapter.entryPoint)}</Text> : null}
        </Text>
      </Box>
      {props.drawer ? (
        <Box flexShrink={0}>
          <Text color="cyan">
            {` ${props.drawer} · `}
            <Text bold>t</Text>
          </Text>
        </Box>
      ) : null}
    </Box>
  );
});

// Renders only the visible window of a collapsed chapter, which can hold thousands of generated hunks.
export const CollapsedSummary = React.memo(function CollapsedSummary(props: {
  hunks: Tour['hunks'];
  files: Map<string, DiffFile>;
  chapter: Chapter;
  states: States;
  sel: number;
  width: number;
  height: number;
}) {
  const { hunks, files, chapter, states, width } = props;
  const total = chapter.hunkIds.length;
  const top = Math.max(0, Math.min(props.sel - Math.floor(props.height / 2), total - props.height));
  const rows = chapter.hunkIds.slice(top, top + Math.max(0, props.height)).map((id, k) => {
    const i = top + k;
    const h = hunks[id];
    const f = h ? files.get(h.file) : undefined;
    const st = stateMark(stateOf(states, h));
    const summary = f?.summary ?? f?.kindReason ?? '';
    return (
      <Text key={id} inverse={i === props.sel}>
        <Text color={st.color}>{st.mark}</Text> {pad(h?.file ?? id, Math.floor(width * 0.45))}{' '}
        <Text dimColor>{truncate(`${summary} (+${f?.additions ?? 0}/-${f?.deletions ?? 0}, ${h ? changedLineCount(h) : 0} lines)`, Math.floor(width * 0.5))}</Text>
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

// Narrow terminals show the chapters as one line of state marks instead of the list.
export const ChapterStrip = React.memo(function ChapterStrip(props: {
  tour: Tour;
  chapters: Chapter[];
  listed: Chapter[];
  states: States;
  current: string;
  order: ChapterOrder;
  ci: number;
  width: number;
}) {
  const { tour, chapters, states } = props;
  const strip = props.listed
    .map((c) => {
      const shown = chapters.find((d) => d.id === c.id);
      return c.id === props.current ? `[${c.title}]` : shown ? stateMark(chapterState(tour, shown, states)).mark : '·';
    })
    .join(' ');
  return (
    <Text dimColor wrap="truncate">
      {truncate(`${ORDER_LABEL[props.order]} order · Chapter ${props.ci + 1}/${chapters.length}: ${strip}`, props.width)}
    </Text>
  );
});

// The explanation above the code, already cut to fit (chapterLayout).
// An in-flow block with a left rule, not a box: it is always in the same place, so a frame and a
// title would only cost rows. The rule is quiet, magenta for narration that is the model's
// inference, and green for a moment when the explanation has just arrived.
export function Explanation(props: { lines: MdLine[]; inferred: boolean; collapsed: boolean; updated?: boolean; width: number }) {
  if (!props.lines.length) return null;
  const rule = props.updated ? 'green' : props.inferred ? 'magenta' : 'gray';
  return (
    <Box flexDirection="column" flexShrink={0} width={props.width} marginBottom={1}>
      {props.lines.map((l, i) => (
        <Box key={i}>
          <Text color={rule}>{'▎ '}</Text>
          <Box flexGrow={1}>
            <MdLineView line={l} />
          </Box>
          {i === 0 && props.updated ? <Text color="green"> updated</Text> : null}
        </Box>
      ))}
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
