import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { useInput as useInkInput } from 'ink';
import { Box, Dimmed, Text } from '../themed.js';
import { BORDER, SURFACES } from '../theme.js';
import type { TutorRecord } from '../../store/db.js';
import { G } from '../glyphs.js';
import { MdLineView, type MdLine, type Span } from '../markdown.js';
import { Hints, type Hint } from '../KeyBar.js';
import type { PaletteItem } from '../CommandPalette.js';
import { AnchorContext, EmphasizedKey, sameRect, type AnchorId, type AnchorRegistry, type Rect } from './anchors.js';
import { TutorContext, type ScreenState, type TutorBridge, type TutorEvent, type TutorRequest } from './bridge.js';
import { LESSONS, isRead, pressOf, textSpans, tokenKey, type Place, type Step, type TutorView } from './lessons.js';
import { backward, forward, homeName, homeOf, isLast, offPath, placeOf, progressOf, satisfied, START, stepAt, travels, type Home, type TutorPos } from './engine.js';

// The tutor (`gr tutor`): a callout over the demo tour that explains one part of the screen at a
// time and then asks for the real key. A read step dims the screen but what it points at and takes
// enter and backspace itself; a do step leaves every key to the screen and waits for what the
// step asks for to happen. App renders it above the screens, next to the quit question.

// The tutor's progress, as the store keeps it.
export type TutorProgress = TutorRecord;

// How the tutor moves the reader. App resolves a lesson's place against the tour's chapters.
export interface TutorNav {
  go: (place: Place) => { hunkId?: string; line?: number };
  back: (home: Home) => void;
}

// The moment a done step shows its check before the next one. GR_DEMO_INSTANT=1 skips it, for
// the end-to-end tests and golden screens.
const DONE_MS = process.env.GR_DEMO_INSTANT === '1' ? 0 : 700;

// Below this, the callout docks as a strip above the key bar rather than floating.
export const DOCK_WIDTH = 100;
export const DOCK_HEIGHT = 30;

export interface Tutor {
  on: boolean; // showing a step
  captures: boolean; // the callout has the keys; the screens are quiet
  lesson: number; // 1-based, for "pick up at lesson N"
  bridge: TutorBridge;
  layer: (screen: ReactNode, width: number, height: number) => ReactNode;
}

export function useTutor(o: {
  session: boolean; // the demo: the layer is mounted the whole time, the tutor on or not
  start: number; // each new number runs the lessons from the welcome, once the tour is in; 0: not
  ready: boolean; // the tour is in
  view: Omit<TutorView, keyof ScreenState>;
  saved: () => TutorProgress | undefined; // read as a run starts
  save: (p: TutorProgress) => void;
  nav: TutorNav;
  paused: boolean; // a question over everything (quit) has the keys
  offer?: () => void; // outside a run, the palette's way in
  onQuit: () => void; // Q while the callout has the keys: App asks before leaving
  // The last step's ways out: quit now, and (from gr tutor) close for gr config. `returning`: the tutor
  // was opened from a tour, which enter goes back to.
  finale: { quit: () => void; config?: () => void; returning: boolean };
  onLeave: () => void; // finished, left, or dismissed: App goes back to where : Tutor was started, if anywhere
}): Tutor {
  const [pos, setPos] = useState<TutorPos | undefined>();
  const started = useRef(0);
  // A run left partway: the welcome offers to pick it up there.
  const [resumeAt, setResumeAt] = useState<number | undefined>();
  const [done, setDone] = useState(false);
  const [home, setHome] = useState<Home>();
  const [wander, setWander] = useState(false);
  const [request, setRequest] = useState<TutorRequest>({ seq: 0 });
  const [screen, setScreen] = useState<ScreenState>({ overlay: 'none', testFocus: false });
  const view: TutorView = { ...o.view, ...screen };
  const step = pos ? stepAt(pos) : undefined;
  const latest = useRef({ pos, step, view, done, nav: o.nav, save: o.save, onLeave: o.onLeave });
  latest.current = { pos, step, view, done, nav: o.nav, save: o.save, onLeave: o.onLeave };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const enter = (to: TutorPos) => {
    const from = latest.current.pos;
    clearTimeout(timer.current);
    setPos(to);
    setDone(false);
    setHome(undefined);
    setWander(false);
    if (travels(from, to)) {
      const at = latest.current.nav.go(placeOf(to));
      setRequest((r) => ({ seq: r.seq + 1, ...at }));
    }
    if (!from || from.lesson !== to.lesson) latest.current.save({ lesson: LESSONS[to.lesson].id, state: 'started' });
  };
  const finish = () => {
    clearTimeout(timer.current);
    setPos(undefined);
    latest.current.save({ lesson: LESSONS.at(-1)!.id, state: 'finished' });
    latest.current.onLeave();
  };
  const advance = () => {
    const cur = latest.current.pos;
    const next = cur && forward(cur);
    if (next) enter(next);
    else finish();
  };
  const complete = () => {
    if (latest.current.done) return;
    setDone(true);
    latest.current.done = true;
    timer.current = setTimeout(advance, DONE_MS);
  };
  const leave = () => {
    clearTimeout(timer.current);
    setPos(undefined);
    latest.current.onLeave();
  };

  // The first step, once the tour is in.
  useEffect(() => {
    if (!o.start || !o.ready || started.current === o.start) return;
    started.current = o.start;
    const saved = o.saved();
    const at = saved?.state === 'started' ? LESSONS.findIndex((l) => l.id === saved.lesson) : -1;
    setResumeAt(at > 0 ? at : undefined);
    latest.current.pos = undefined;
    enter(START);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.start, o.ready]);

  const read = !!step && isRead(step);
  // A do step's place is where it began; leaving it (another chapter, the briefing) is off the path.
  const needsHome = !!pos && !!step && !read && !home;
  useEffect(() => {
    if (needsHome) setHome(homeOf(latest.current.view));
  }, [needsHome]);
  const away = !!home && !done && !!step && !read && offPath(home, view) && !satisfied(step, view);
  // Back on the path, after wandering: the step shows again.
  if (wander && !away) setWander(false);

  // A step waiting on a state, done once the screens reach it.
  useEffect(() => {
    if (step && !done && 'when' in step.until && satisfied(step, view)) complete();
  });

  const event = (e: TutorEvent) => {
    const { step: s, view: v, done: d } = latest.current;
    if (s && !d && satisfied(s, v, e)) complete();
  };

  const captures = !!pos && (read || (away && !wander));
  useInkInput(
    (input, key) => {
      // The last step: keep exploring (or back to the tour), set gr up, or quit, all done.
      if (pos && !away && isLast(pos)) {
        if (key.return || key.escape) return finish();
        if (input === 'c' && o.finale.config) {
          latest.current.save({ lesson: LESSONS.at(-1)!.id, state: 'finished' });
          return o.finale.config();
        }
        if (input === 'q' || input === 'Q') {
          latest.current.save({ lesson: LESSONS.at(-1)!.id, state: 'finished' });
          return o.finale.quit();
        }
      }
      // Q works everywhere, as it does on the screens: App asks first.
      if (input === 'Q') return o.onQuit();
      if (away) {
        if (key.return && home) return latest.current.nav.back(home);
        if (key.escape) return setWander(true);
        return;
      }
      if (!pos) return;
      const welcome = pos.lesson === 0 && pos.step === 0;
      if (key.return) {
        if (welcome && resumeAt !== undefined) {
          setResumeAt(undefined);
          return enter({ lesson: resumeAt, step: 0 });
        }
        return isLast(pos) ? finish() : advance();
      }
      if (welcome && input === 'r' && resumeAt !== undefined) {
        setResumeAt(undefined);
        return advance();
      }
      if (welcome && key.escape) {
        clearTimeout(timer.current);
        setPos(undefined);
        latest.current.save({ state: 'dismissed' });
        return latest.current.onLeave();
      }
      if (key.backspace || key.delete) {
        const back = backward(pos);
        if (back) enter(back);
      }
    },
    { isActive: captures && !o.paused },
  );

  // ---------- anchors ----------
  const rects = useRef(new Map<AnchorId, Rect>());
  const columns = useRef(new Map<AnchorId, number>());
  const [, remeasured] = useReducer((n: number) => n + 1, 0);
  const point = away ? undefined : step?.point;
  const spot = read ? point : undefined;
  const pointRef = useRef(point);
  pointRef.current = point;
  const registry = useMemo<AnchorRegistry>(
    () => ({
      report: (id, rect) => {
        if (sameRect(rects.current.get(id), rect)) return;
        if (rect) rects.current.set(id, rect);
        else rects.current.delete(id);
        if (id === pointRef.current || id === 'keybar') remeasured();
      },
      column: (id, x) => {
        if (columns.current.get(id) === x) return;
        if (x === undefined) columns.current.delete(id);
        else columns.current.set(id, x);
        if (id === pointRef.current) remeasured();
      },
    }),
    [],
  );
  const anchors = useMemo<AnchorRegistry>(() => ({ ...registry, spot }), [registry, spot]);

  // ---------- the palette ----------
  const palette: PaletteItem[] = [];
  if (pos) {
    if (away && wander && home) palette.push({ label: `Tutor: back to the lesson (${homeName(home)})`, run: () => latest.current.nav.back(home) });
    const nextLesson = LESSONS[pos.lesson + 1];
    if (nextLesson) palette.push({ label: `Tutor: skip to lesson ${pos.lesson + 2}, ${nextLesson.title}`, run: () => enter({ lesson: pos.lesson + 1, step: 0 }) });
    palette.push({ label: 'Tutor: leave the tutor', run: leave });
  } else if (o.offer) palette.push({ label: 'Tutor: learn Guided Review in a sample tour', run: o.offer });
  // Stable, so a screen's effect that reports its state runs only when that state changes.
  const session = useRef(o.session);
  session.current = o.session;
  const reportScreen = useMemo(
    () => (s: ScreenState) => {
      if (session.current) setScreen((cur) => (cur.overlay === s.overlay && cur.testFocus === s.testFocus ? cur : s));
    },
    [],
  );
  const bridge: TutorBridge = { event, screen: reportScreen, request, palette };

  const emphasized = pos && step && !read && !away && !done ? pressOf(step) : undefined;
  const layer = (content: ReactNode, width: number, height: number): ReactNode => {
    const callout =
      pos && step && !(away && wander)
        ? calloutFor({
            pos,
            step,
            away: away ? home : undefined,
            done,
            resumeAt,
            width,
            height,
            rect: point ? rects.current.get(point) : undefined,
            column: point ? columns.current.get(point) : undefined,
            bar: rects.current.get('keybar')?.y,
            finale: { config: !!o.finale.config, returning: o.finale.returning },
          })
        : undefined;
    // Outside the demo, the screens get the palette's way in and nothing else.
    if (!o.session) return <TutorContext value={bridge}>{content}</TutorContext>;
    return (
      <TutorContext value={bridge}>
        <AnchorContext value={anchors}>
          <EmphasizedKey value={emphasized ? tokenKey(emphasized) : undefined}>
            <Box position="relative" width={width} height={height} overflow="hidden" flexDirection="column">
              {/* A read step dims all but what it points at; a do step leaves the screen as it is. */}
              <Dimmed value={!!pos && (read || (away && !wander))}>{content}</Dimmed>
              {callout}
            </Box>
          </EmphasizedKey>
        </AnchorContext>
      </TutorContext>
    );
  };
  return { on: !!pos, captures, lesson: (pos?.lesson ?? 0) + 1, bridge, layer };
}

// ---------- the callout ----------

const SPREAD = 20; // how far into a wide anchor the arrow points

interface CalloutInput {
  pos: TutorPos;
  step: Step;
  away?: Home; // off the path: the way back instead of the step
  done: boolean;
  resumeAt?: number;
  width: number;
  height: number;
  rect?: Rect;
  column?: number;
  bar?: number; // the key bar's row, which a docked callout sits above
  finale: { config: boolean; returning: boolean };
}

// The step's text, wrapped at spaces only, so a key keeps the punctuation after it. Paragraphs
// split on a blank line and lines on a newline; keys are accented, a line starting `$ ` is a
// command to type (a note after two spaces stays dim), and a link can be opened.
export function body(text: string, width: number): MdLine[] {
  const out: MdLine[] = [];
  for (const [i, para] of text.split('\n\n').entries()) {
    if (i) out.push([]);
    for (const row of para.split('\n')) {
      if (row.startsWith('$ ')) {
        const [command, note] = row.slice(2).split(/ {2,}/);
        out.push([{ text: '  $ ', dim: true }, { text: command, bold: true }, ...(note ? [{ text: `  ${note}`, dim: true }] : [])]);
        continue;
      }
      out.push(...wrapRow(row, width));
    }
  }
  return out;
}

function wrapRow(row: string, width: number): MdLine[] {
  const out: MdLine[] = [];
  // Words, each the spans between spaces.
  const words: Span[][] = [[]];
  for (const s of textSpans(row)) {
    const style = s.key ? { color: 'cyan', bold: true } : {};
    for (const [j, piece] of s.text.split(/ +/).entries()) {
      if (j) words.push([]);
      if (!piece) continue;
      const link = /^https?:\/\//.test(piece);
      words.at(-1)!.push(link ? { text: piece, href: piece, underline: true, color: 'cyan' } : { text: piece, ...style });
    }
  }
  let line: Span[] = [];
  let used = 0;
  for (const w of words.filter((x) => x.length)) {
    const n = w.reduce((k, s) => k + [...s.text].length, 0);
    if (used && used + 1 + n > width) {
      out.push(line);
      line = [];
      used = 0;
    }
    if (used) line.push({ text: ' ' });
    line.push(...w);
    used += (used ? 1 : 0) + n;
  }
  if (line.length) out.push(line);
  return out;
}

function footer(c: CalloutInput): { hints: Hint[]; note?: string } {
  if (c.away)
    return {
      hints: [
        ['enter', 'take me back'],
        ['esc', 'explore here'],
      ],
    };
  if (c.done) return { hints: [], note: `${G.done} done` };
  const welcome = c.pos.lesson === 0 && c.pos.step === 0;
  if (welcome && c.resumeAt !== undefined)
    return {
      hints: [
        ['enter', `continue at lesson ${c.resumeAt + 1}`],
        ['r', 'start over'],
        ['esc', 'explore on my own'],
      ],
    };
  if (welcome)
    return {
      hints: [
        ['enter', 'start'],
        ['esc', 'explore on my own'],
      ],
    };
  if (!isRead(c.step)) {
    const k = pressOf(c.step);
    return { hints: [], note: k ? `waiting for ${tokenKey(k)} …` : 'waiting …' };
  }
  if (isLast(c.pos))
    return {
      hints: [['enter', c.finale.returning ? 'back to your tour' : 'keep exploring'], ...(c.finale.config ? ([['c', 'set up Guided Review']] as Hint[]) : []), ['q', 'quit']],
    };
  return {
    hints: [
      ['enter', 'next'],
      ['backspace', 'back'],
    ],
  };
}

function calloutFor(c: CalloutInput): ReactNode {
  const { width: W, height: H } = c;
  const p = progressOf(c.pos);
  const lesson = LESSONS[c.pos.lesson];
  const small = W < DOCK_WIDTH || H < DOCK_HEIGHT;
  const welcome = c.pos.lesson === 0 && c.pos.step === 0;
  const text = c.away
    ? `This lesson is on ${homeName(c.away)}. enter takes you back, or esc lets you look around first (: has the way back).`
    : welcome && c.resumeAt !== undefined
      ? `Welcome back. You left the tutor at lesson ${c.resumeAt + 1}, ${LESSONS[c.resumeAt].title}. Pick it up there, or start over.`
      : c.step.text;
  const centered = !c.away && !c.step.point && !c.step.dock && isRead(c.step) && !small;
  const dock = centered ? undefined : c.away ? 'bottom' : c.step.dock === 'top' ? 'top' : small || !c.step.point || !c.rect ? 'bottom' : undefined;
  const boxWidth = dock ? W : Math.min(centered ? 68 : 58, W - 4);
  const inner = Math.max(10, boxWidth - 4);
  const lines = body(text, inner);
  const foot = footer(c);
  const title = small ? `Tutor ${p.lesson}/${p.lessons} · ${lesson.title}` : `Tutor · lesson ${p.lesson} of ${p.lessons} · ${lesson.title} · ${p.step}/${p.steps}`;
  // Border, title, text, and the footer; a blank row before the footer when there is room.
  const roomy = !dock && !small;
  const boxHeight = Math.min(H, 2 + 1 + lines.length + (roomy ? 1 : 0) + 1);

  let left = 0;
  let top = 0;
  let arrow: { x: number; y: number; up: boolean } | undefined;
  if (centered) {
    left = Math.floor((W - boxWidth) / 2);
    top = Math.max(0, Math.floor((H - boxHeight) / 2));
  } else if (dock === 'top') {
    top = Math.min(1, Math.max(0, H - boxHeight));
  } else if (dock === 'bottom') {
    // Above the key bar, which a do step needs in view.
    top = Math.max(0, (c.bar ?? H - 1) - boxHeight);
  } else if (c.rect) {
    const r = c.rect;
    // The header's readout of where you are is at its right end.
    const focus = c.step.point === 'header' ? r.x + r.width - SPREAD : r.x + Math.min(Math.floor(r.width / 2), SPREAD);
    const ax = Math.max(0, Math.min(W - 1, c.column ?? focus));
    const place = (t: number) => ({ left: Math.max(0, Math.min(W - boxWidth, ax - Math.floor(boxWidth / 3))), top: t });
    // Right under the anchor, with the arrow on the callout's border pointing at it.
    const below = r.y + r.height;
    // A tall anchor (the code) keeps the callout inside it, rather than over what is around it.
    const tall = r.height > H / 2 && r.width >= boxWidth + SPREAD;
    if (tall) {
      left = r.x + r.width - boxWidth;
      top = Math.max(0, Math.min(H - 1 - boxHeight, r.y + r.height - boxHeight));
    } else if (below + boxHeight <= H) {
      ({ left, top } = place(below));
      arrow = { x: ax, y: top, up: true };
    } else if (r.y - boxHeight >= 0) {
      ({ left, top } = place(r.y - boxHeight));
      arrow = { x: ax, y: top + boxHeight - 1, up: false };
    } else if (r.width >= boxWidth + SPREAD) {
      // A big anchor (the code): inside it, at its bottom right, over the ends of the lines.
      left = r.x + r.width - boxWidth;
      top = Math.max(0, Math.min(H - 1 - boxHeight, r.y + r.height - boxHeight));
    } else {
      top = Math.max(0, (c.bar ?? H - 1) - boxHeight);
    }
  }
  const node = (
    <Box
      position="absolute"
      left={left}
      top={top}
      width={boxWidth}
      height={boxHeight}
      flexDirection="column"
      overflow="hidden"
      borderStyle="round"
      borderColor={BORDER.tutor}
      backgroundColor={SURFACES.popup}
      paddingX={1}
    >
      <Text bold color={BORDER.tutor} wrap="truncate">
        {title}
      </Text>
      {lines.map((l, i) => (
        <MdLineView key={i} line={l} />
      ))}
      {roomy ? <Text> </Text> : null}
      {foot.hints.length ? (
        <Hints keys={foot.hints} note={foot.note} />
      ) : (
        <Text color={c.done ? 'green' : undefined} dimColor={!c.done}>
          {foot.note ?? ' '}
        </Text>
      )}
    </Box>
  );
  return (
    <>
      {node}
      {arrow ? (
        // On the border, clear of its corners.
        <Box position="absolute" left={Math.max(left + 1, Math.min(left + boxWidth - 2, arrow.x))} top={arrow.y} width={1} height={1} backgroundColor={SURFACES.popup}>
          <Text color={BORDER.tutor} bold>
            {arrow.up ? G.pointUp : G.pointDown}
          </Text>
        </Box>
      ) : null}
    </>
  );
}
