import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInput } from 'ink';
import { Box, Text } from './themed.js';
import { fetchPRPreview, AUTHORED_LIMIT, listAuthoredPRs, listReviewRequests, parsePRArg, viewerLogin, type AuthoredPR, type PRPreview, type ReviewRequest } from '../github/gh.js';
import type { Store } from '../store/db.js';
import { KeyBar } from './ChapterScreen.js';
import { TextInput } from './TextInput.js';
import { pad, truncate, wrap } from './nav.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';
import { openExternal } from '../util/openExternal.js';
import { readClipboard } from '../util/clipboard.js';
import { CHECK_MARK, checkLabel, outcomeText, sortChecks } from '../review/checks.js';
import { MdLineView, line, renderMarkdown } from './markdown.js';
import { HelpPopup } from './Help.js';
import { helpOf } from './keys.js';
import { PICKER_KEYS, pickerBar } from './screenKeys.js';

export interface Target {
  repo: string;
  number: number;
}

interface Local {
  tourHead?: string;
  drafts: number;
}

const PREVIEW_DELAY_MS = 120; // wait for j/k to settle before calling gh
const FRAME_MS = 80;
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BAR_W = 20;
const REFRESH_MS = 2 * 60 * 1000; // the list refreshes itself this often
const CLIPBOARD_MS = 1500;

// Clipboard texts already opened or dismissed. Module-level, so returning to the picker
// after a tour doesn't offer the same link again.
const dismissedClips = new Set<string>();

// The PR a copied link (or owner/name#N) points to; undefined for anything else.
export function clipboardPR(text: string): Target | undefined {
  const s = text.trim();
  if (!s || s.length > 500 || /\s/.test(s) || dismissedClips.has(s)) return undefined;
  try {
    return parsePRArg(s);
  } catch {
    return undefined;
  }
}

// Your PRs as last loaded. Module-level, so returning to the picker after a tour shows them at
// once while they refresh: their search is the slow one (seconds, on GitHub's side).
let authoredCache: { prs: AuthoredPR[]; truncated: boolean } | undefined;
// w: your PRs waiting on reviewers shown too. Kept for the session, like the cache.
let showWaitingPref = false;

// One PR's tour download, as the app reports it.
export interface DownloadJob {
  state: 'queued' | 'running' | 'done' | 'failed';
  step?: string; // the pipeline step in progress
  error?: string;
}

const isActive = (job?: DownloadJob) => job?.state === 'queued' || job?.state === 'running';

// The download progress bar: finished tours fill it, and a comet sweeps the rest
// so it visibly moves even while a long agent call is running.
export function progressBar(finished: number, total: number, frame: number, width = BAR_W): { filled: string; rest: string } {
  const filled = total ? Math.round((finished / total) * width) : 0;
  const room = width - filled;
  const head = room ? frame % (room + 3) : -1;
  const rest = Array.from({ length: room }, (_, i) => (i === head ? '▓' : i === head - 1 ? '▒' : '░')).join('');
  return { filled: '█'.repeat(filled), rest };
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function age(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  if (s < 86400 * 365) return `${Math.round(s / (86400 * 30))}mo ago`;
  return `${Math.round(s / (86400 * 365))}y ago`;
}

type Row =
  | { kind: 'section'; title: string; count: number }
  | { kind: 'note'; text: string }
  | { kind: 'repo'; repo: string; count: number; own: boolean }
  | { kind: 'pr'; pr: ReviewRequest | AuthoredPR; index: number };

export const isAuthored = (pr: ReviewRequest | AuthoredPR): pr is AuthoredPR => 'openThreads' in pr;

const MERGEABLE = ['CLEAN', 'HAS_HOOKS', 'UNSTABLE'];
export const readyToMerge = (pr: AuthoredPR) => !pr.isDraft && MERGEABLE.includes(pr.mergeStateStatus);

const checksFailing = (pr: AuthoredPR) => pr.checks === 'FAILURE' || pr.checks === 'ERROR';

// Your PRs that need you: unresolved threads, a review since your last commit, changes
// requested, ready to merge, or nobody asked to review it. The rest wait on reviewers, and
// show only when asked for (w).
export function needsAuthor(pr: AuthoredPR): boolean {
  return pr.unresolvedThreads > 0 || pr.newReview || pr.reviewDecision === 'CHANGES_REQUESTED' || readyToMerge(pr) || pr.noReviewers;
}

// PRs grouped by repo (repos with the most recent activity first), filtered by text, under a
// Review requests heading and, when you have open PRs, a Your PRs one: the ones that need you,
// and the ones waiting on reviewers with `showWaiting`, else a line counting them.
export function pickerRows(prs: ReviewRequest[], filter: string, authored: AuthoredPR[] = [], showWaiting = false, authoredTruncated = false): { rows: Row[]; items: (ReviewRequest | AuthoredPR)[] } {
  const f = filter.trim().toLowerCase();
  const rows: Row[] = [];
  const items: (ReviewRequest | AuthoredPR)[] = [];
  // `own`: your PRs. A repo can head a group in both sections, so it is part of the row's key.
  const section = (list: (ReviewRequest | AuthoredPR)[], own = false) => {
    const matching = list.filter((p) => !f || `${p.repo}#${p.number} ${p.title} ${p.author} ${p.labels.join(' ')}`.toLowerCase().includes(f));
    const groups = new Map<string, (ReviewRequest | AuthoredPR)[]>();
    for (const p of matching) {
      const group = groups.get(p.repo);
      if (group) group.push(p);
      else groups.set(p.repo, [p]);
    }
    const ordered = [...groups.entries()].sort((a, b) => b[1][0].updatedAt.localeCompare(a[1][0].updatedAt));
    for (const [repo, group] of ordered) {
      rows.push({ kind: 'repo', repo, count: group.length, own });
      for (const pr of group) {
        rows.push({ kind: 'pr', pr, index: items.length });
        items.push(pr);
      }
    }
    return matching.length;
  };
  const reviewsAt = rows.push({ kind: 'section', title: 'Review requests', count: 0 }) - 1;
  rows[reviewsAt] = { kind: 'section', title: 'Review requests', count: section(prs) };
  if (!rows[reviewsAt + 1] && !f) rows.push({ kind: 'note', text: 'Nothing is waiting on your review. gr review <number or URL> opens a specific PR.' });
  if (!authored.length) return { rows, items };
  const waiting = authored.filter((p) => !needsAuthor(p)).length;
  const yoursAt = rows.push({ kind: 'section', title: 'Your PRs', count: 0 }) - 1;
  rows[yoursAt] = { kind: 'section', title: 'Your PRs', count: section(showWaiting ? authored : authored.filter(needsAuthor), true) };
  if (waiting && !f) {
    const are = `${waiting === 1 ? 'is' : 'are'} waiting on reviewers`;
    const none = rows.length - 1 === yoursAt ? 'None need you. ' : '';
    rows.push({ kind: 'note', text: showWaiting ? `${waiting} ${are} · w hides them` : `${none}${waiting} more ${are} · w shows them` });
  }
  if (authoredTruncated) rows.push({ kind: 'note', text: `Showing the first ${AUTHORED_LIMIT} of your open PRs.` });
  return { rows, items };
}

interface PickerProps {
  store: Store;
  width: number;
  height: number;
  notice?: string;
  onPick: (t: Target, mode?: 'author') => void; // your own PRs open their feedback
  onMerge?: (t: Target) => void; // M
  onChecks?: (t: Target) => void; // c: the PR's checks and their logs
  onReviewers?: (t: Target) => void; // A, on your own PR: who is asked to review, and asking more
  reload?: number; // a change bumps it: read the lists again
  merged?: ReadonlySet<string>; // PRs merged this session (keyFor), left off the list: GitHub's search lags
  onQuit: () => void;
  onTheme?: () => void; // L: the color theme picker
  active?: boolean; // false while a popup over the list takes the keys
  downloads: Record<string, DownloadJob>;
  onDownload: (targets: Target[]) => void; // queues tours; progress arrives through `downloads`
  readClipboard?: () => Promise<string | undefined>; // tests stub the system clipboard
  refreshMs?: number;
}

export function PickerScreen(props: PickerProps) {
  const { width, height } = props;
  const [prs, setPrs] = useState<ReviewRequest[] | undefined>();
  const [authored, setAuthored] = useState<AuthoredPR[]>(() => authoredCache?.prs ?? []);
  const [showWaiting, setShowWaiting] = useState(showWaitingPref);
  // 'loading' until the first answer arrives; a refresh after that keeps the list on screen.
  const [authoredState, setAuthoredState] = useState<'loading' | 'ready' | { error: string }>(() => (authoredCache ? 'ready' : 'loading'));
  const [authoredTruncated, setAuthoredTruncated] = useState(() => authoredCache?.truncated ?? false);
  const authoredInflight = useRef(false);
  const scrollTop = useRef(0); // the list's first row on screen
  const [err, setErr] = useState('');
  const [sel, setSel] = useState(0);
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [previews, setPreviews] = useState<Record<string, PRPreview | { error: string }>>({});
  const [loadedAt, setLoadedAt] = useState(Date.now());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [downloadNotice, setDownloadNotice] = useState('');
  const [hint, setHint] = useState('');
  const [localVersion, setLocalVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [clip, setClip] = useState<{ text: string; target: Target }>();
  const [help, setHelp] = useState(false);
  const inflight = useRef(new Set<string>());
  // load() runs from a timer too, so it reads the list and selection through refs.
  const prsRef = useRef(prs);
  prsRef.current = prs;
  const selKey = useRef('');
  const restoreKey = useRef<string | undefined>(undefined);
  const loading = useRef(false);

  // Refreshing keeps the current list on screen until the new one arrives.
  const load = () => {
    if (loading.current) return;
    loading.current = true;
    setRefreshing(true);
    setErr('');
    // Your own PRs load alongside the review requests; the list works without them.
    if (!authoredInflight.current) {
      authoredInflight.current = true;
      setAuthoredState((st) => (st === 'ready' ? st : 'loading'));
      Promise.resolve()
        .then(() => listAuthoredPRs())
        .then(
          (mine) => {
            authoredCache = mine;
            setAuthored(mine.prs);
            setAuthoredTruncated(mine.truncated);
            setAuthoredState('ready');
          },
          (e: unknown) => setAuthoredState((st) => (st === 'ready' ? st : { error: (e as Error).message })),
        )
        .finally(() => {
          authoredInflight.current = false;
        });
    }
    listReviewRequests()
      .then(
        (p) => {
          // PRs updated since the last fetch get a fresh preview.
          const before = new Map((prsRef.current ?? []).map((x) => [keyFor(x), x.updatedAt]));
          const stale = p.map(keyFor).filter((k, i) => before.has(k) && before.get(k) !== p[i].updatedAt);
          if (stale.length) {
            for (const k of stale) inflight.current.delete(k);
            setPreviews((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !stale.includes(k))));
          }
          const keys = new Set(p.map(keyFor));
          setSelected((prev) => new Set([...prev].filter((id) => keys.has(id))));
          restoreKey.current = selKey.current;
          setPrs(p);
          setLoadedAt(Date.now());
        },
        (e) => {
          const msg = (e as Error).message;
          if (prsRef.current) setHint(`Refresh failed: ${msg}`);
          else setErr(msg);
        },
      )
      .finally(() => {
        loading.current = false;
        setRefreshing(false);
      });
  };
  useEffect(load, []);
  useEffect(() => {
    if (props.reload) load();
  }, [props.reload]);
  const refreshMs = props.refreshMs ?? REFRESH_MS;
  useEffect(() => {
    const t = setInterval(load, refreshMs);
    // load only touches refs and state setters, so the first one stays good.
    return () => clearInterval(t);
  }, [refreshMs]);

  // Offer a PR link as soon as it lands on the clipboard.
  const readClip = props.readClipboard ?? readClipboard;
  useEffect(() => {
    let stopped = false;
    let busy = false;
    let last: string | undefined;
    const check = async () => {
      if (busy) return;
      busy = true;
      try {
        const text = await readClip();
        if (stopped) return;
        if (text === undefined) return clearInterval(t); // no clipboard reader on this machine
        if (text === last) return;
        last = text;
        const target = clipboardPR(text);
        setClip(target && { text: text.trim(), target });
      } finally {
        busy = false;
      }
    };
    const t = setInterval(() => void check(), CLIPBOARD_MS);
    void check();
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [readClip]);

  const { merged } = props;
  const { rows, items } = useMemo(() => {
    const open = <T extends Target>(list: T[]) => (merged?.size ? list.filter((p) => !merged.has(keyFor(p))) : list);
    return pickerRows(open(prs ?? []), filter, open(authored), showWaiting, authoredTruncated);
  }, [prs, filter, authored, merged, showWaiting, authoredTruncated]);
  // What's already on this machine for each PR: cheap queries, computed once per list.
  const local = useMemo(() => {
    const out: Record<string, Local> = {};
    for (const p of [...(prs ?? []), ...authored]) {
      // listTours is newest first.
      const latest = props.store.listTours(p.repo, p.number)[0];
      out[`${p.repo}#${p.number}`] = { tourHead: latest?.headSha, drafts: props.store.listDrafts(p.repo, p.number).filter((d) => !d.posted).length };
    }
    return out;
    // localVersion is a cache buster: finished downloads write to the store behind this memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prs, authored, localVersion, props.store]);
  const current = items[Math.min(sel, items.length - 1)];
  const waiting = items.filter((p) => !isAuthored(p)).length;
  const key = current ? `${current.repo}#${current.number}` : '';
  selKey.current = key;

  // After a refresh, stay on the PR that was highlighted, wherever it moved.
  useLayoutEffect(() => {
    const k = restoreKey.current;
    if (k === undefined) return;
    restoreKey.current = undefined;
    const i = items.findIndex((p) => keyFor(p) === k);
    setSel((s) => (i >= 0 ? i : Math.max(0, Math.min(s, items.length - 1))));
  }, [items]);

  // Downloads since the queue was last empty, summarized once they all finish.
  const { downloads } = props;
  const activeKeys = Object.keys(downloads).filter((k) => isActive(downloads[k]));
  const active = activeKeys.length > 0;
  const wave = useRef({ keys: new Set(activeKeys), startedAt: Date.now() });
  const wasActive = useRef(false);
  const [frame, setFrame] = useState(0);
  const authoredLoading = authoredState === 'loading';
  const ticking = active || refreshing || authoredLoading;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setFrame((f) => f + 1), FRAME_MS);
    return () => clearInterval(t);
  }, [ticking]);
  const doneCount = Object.values(downloads).filter((j) => j.state === 'done').length;
  useEffect(() => setLocalVersion((v) => v + 1), [doneCount]);
  useEffect(() => {
    if (active) {
      wasActive.current = true;
      return;
    }
    if (!wasActive.current) return;
    wasActive.current = false;
    const keys = [...wave.current.keys];
    if (!keys.length) return;
    const failed = keys.filter((k) => downloads[k]?.state === 'failed');
    setDownloadNotice(
      failed.length
        ? `Downloaded ${keys.length - failed.length}/${keys.length} tours. Failed: ${failed.map((k) => `${k} (${downloads[k].error})`).join('; ')}`
        : `Downloaded ${keys.length} tour(s). Ready to open.`,
    );
  }, [active, downloads]);

  const startDownload = () => {
    if (!current) return;
    const picked = selected.size ? (prs ?? []).filter((p) => selected.has(keyFor(p))) : [current];
    const targets = picked.filter((p) => !isActive(downloads[keyFor(p)]));
    if (!targets.length) return;
    if (!active) wave.current = { keys: new Set(), startedAt: Date.now() };
    for (const t of targets) wave.current.keys.add(keyFor(t));
    setDownloadNotice('');
    // Marks are spent on this batch, so the next one can be picked while it runs.
    setSelected((prev) => new Set([...prev].filter((id) => !targets.some((t) => keyFor(t) === id))));
    props.onDownload(targets.map(({ repo, number }) => ({ repo, number })));
  };

  // Fetch the preview for the highlighted PR once j/k settles; `inflight` keeps every key ever
  // requested, so each PR is fetched at most once.
  useEffect(() => {
    if (!current || inflight.current.has(key)) return;
    const t = setTimeout(() => {
      inflight.current.add(key);
      fetchPRPreview(current.repo, current.number).then(
        (p) => setPreviews((m) => ({ ...m, [key]: p })),
        (e) => setPreviews((m) => ({ ...m, [key]: { error: (e as Error).message } })),
      );
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(t);
  }, [key, current]);

  // Who you are, to tell a copied link to your own PR from one to review.
  const [viewer, setViewer] = useState<string>();
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => viewerLogin())
      .then(
        (v) => live && setViewer(v),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, []);

  // Your own PRs open their feedback; `mine` says so for one outside Your PRs (a copied link).
  const open = (t: Target, mine = false) => {
    // Opening a PR mid-download would build its tour twice; others open as usual.
    if (isActive(downloads[keyFor(t)])) {
      setHint(`${keyFor(t)} is still downloading · it opens instantly once ready`);
      return false;
    }
    const own = items.find((p) => keyFor(p) === keyFor(t));
    if (mine || (own && isAuthored(own))) props.onPick({ repo: t.repo, number: t.number }, 'author');
    else props.onPick({ repo: t.repo, number: t.number });
    return true;
  };

  // A copied PR outside the list needs its title from a preview fetch.
  const clipKey = clip ? keyFor(clip.target) : '';
  const clipListed = clip ? items.find((p) => keyFor(p) === clipKey) : undefined;
  const clipPreview = previews[clipKey];
  const clipAuthor = clipListed?.author ?? (clipPreview && !('error' in clipPreview) ? clipPreview.author : undefined);
  const clipMine = !!clip && ((!!clipListed && isAuthored(clipListed)) || (!!viewer && clipAuthor === viewer));
  useEffect(() => {
    if (!clip || clipListed || inflight.current.has(clipKey)) return;
    inflight.current.add(clipKey);
    fetchPRPreview(clip.target.repo, clip.target.number).then(
      (p) => setPreviews((m) => ({ ...m, [clipKey]: p })),
      (e) => setPreviews((m) => ({ ...m, [clipKey]: { error: (e as Error).message } })),
    );
  }, [clip, clipKey, clipListed]);

  useInput(
    (input, key) => {
      setHint('');
      if (input === 'q' || input === 'Q') return props.onQuit();
      if (input === '?' || input === 'h') return setHelp(true);
      // Esc closes what is open, and never quits: the filter, then the selection.
      if (key.escape) {
        if (filter) return setFilter('');
        if (selected.size) return setSelected(new Set());
        return setHint('q quits');
      }
      if (clip && (input === 'p' || input === 'x')) {
        if (input === 'p' && !open(clip.target, clipMine)) return;
        dismissedClips.add(clip.text);
        return setClip(undefined);
      }
      if (input === '/') {
        setDownloadNotice('');
        return setFiltering(true);
      }
      if (input === 'r') return load();
      if (input === 'L' && props.onTheme) return props.onTheme();
      if (!items.length) return;
      if (input === ' ' && current) {
        const next = new Set(selected);
        if (next.has(keyFor(current))) next.delete(keyFor(current));
        else next.add(keyFor(current));
        setSelected(next);
      }
      if (input === 'a') {
        const visible = items.map(keyFor);
        const next = new Set(selected);
        if (visible.every((id) => next.has(id))) visible.forEach((id) => next.delete(id));
        else visible.forEach((id) => next.add(id));
        setSelected(next);
      }
      if (input === 'd') startDownload();
      if (input === 'j' || key.downArrow) setSel((s) => Math.min(items.length - 1, s + 1));
      if (input === 'k' || key.upArrow) setSel((s) => Math.max(0, s - 1));
      if (input === 'g') setSel(0);
      if (input === 'G') setSel(items.length - 1);
      if (key.return && current) open(current);
      if (input === 'o' && current) openExternal(current.url).catch((e: unknown) => setHint(`Could not open ${current.url}: ${(e as Error).message}`));
      if (input === 'M' && current && props.onMerge) props.onMerge({ repo: current.repo, number: current.number });
      if (input === 'w' && authored.some((p) => !needsAuthor(p))) {
        showWaitingPref = !showWaiting;
        return setShowWaiting(showWaitingPref);
      }
      if (input === 'c' && current && props.onChecks) props.onChecks({ repo: current.repo, number: current.number });
      if (input === 'A' && current && isAuthored(current) && props.onReviewers) props.onReviewers({ repo: current.repo, number: current.number });
    },
    { isActive: !filtering && !help && props.active !== false },
  );
  useInput(
    (_input, key) => {
      if (key.escape) {
        setFilter('');
        setFiltering(false);
      }
    },
    { isActive: filtering && props.active !== false },
  );

  const wide = width >= 110;
  const listW = wide ? Math.min(70, Math.max(48, Math.floor(width * 0.42))) : width - 2;
  const previewW = wide ? width - listW - 5 : 0;
  const bodyH = height - 3; // title, key bar, filter or status line
  // The Your PRs status line (and its gap) while they load or after they failed.
  const authoredLine = authoredState !== 'ready' && !!prs;
  const listH = (clip ? bodyH - 4 : bodyH) - (authoredLine ? 2 : 0); // the pinned clipboard row and its gap

  // Keep the selection in view; each PR takes two rows. The window keeps its place and moves
  // only when the selection would leave it, so stepping within the view never jumps the list.
  const selRow = rows.findIndex((r) => r.kind === 'pr' && r.index === sel);
  const rowH = (r: Row) => (r.kind === 'pr' ? 2 : 1);
  const span = (from: number, to: number) => rows.slice(from, to + 1).reduce((n, r) => n + rowH(r), 0);
  let start = Math.max(0, Math.min(scrollTop.current, rows.length - 1));
  if (selRow >= 0) {
    if (selRow < start) {
      start = selRow;
      // Its repo and section headings come along while they fit.
      while (start > 0 && (rows[start - 1].kind === 'repo' || rows[start - 1].kind === 'section') && span(start - 1, selRow) <= listH) start--;
    }
    while (start < selRow && span(start, selRow) > listH) start++;
    // On the last PR, the lines under it (what is waiting, what was left out) scroll in too.
    if (!rows.slice(selRow + 1).some((r) => r.kind === 'pr')) while (start < selRow && span(start, rows.length - 1) > listH) start++;
  }
  // No blank rows under the list while earlier rows could fill them.
  while (start > 0 && span(start - 1, rows.length - 1) <= listH) start--;
  scrollTop.current = start;
  const visible: Row[] = [];
  let h = 0;
  // The last row may be cut off at the bottom rather than leave the space blank: a PR is two
  // rows, and its title alone says there is more below.
  for (let i = start; i < rows.length && h < listH; i++) {
    visible.push(rows[i]);
    h += rowH(rows[i]);
  }

  const screen = (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Text wrap="truncate">
        <Text bold>Pull requests</Text>
        <Text dimColor>{prs ? `  ${waiting}${filter ? ` of ${prs.length}` : ''} waiting on you · ` : ''}</Text>
        {prs && refreshing ? <Text color="cyan">{`${SPIN[frame % SPIN.length]} refreshing`}</Text> : null}
        {prs && !refreshing ? <Text dimColor>{`updated ${age(new Date(loadedAt).toISOString())}`}</Text> : null}
      </Text>
      {filtering ? (
        <Box>
          <Text color="cyan">/ </Text>
          <TextInput
            value={filter}
            onChange={(v) => {
              setFilter(v);
              setSel(0);
            }}
            onSubmit={() => setFiltering(false)}
            width={listW - 4}
            active={filtering}
            placeholder="filter by repo, title, author or label"
          />
        </Box>
      ) : hint ? (
        <Text color="yellow" wrap="truncate">
          {safe(hint)}
        </Text>
      ) : active ? (
        <DownloadStatus keys={[...wave.current.keys]} downloads={downloads} frame={frame} startedAt={wave.current.startedAt} />
      ) : downloadNotice ? (
        <Text color={downloadNotice.includes('Failed:') || downloadNotice.startsWith('Download failed') ? 'yellow' : 'green'} wrap="truncate">
          {safe(`${filter ? `/ ${filter} · ` : ''}${downloadNotice}`)}
        </Text>
      ) : filter ? (
        <Box>
          <Text color="cyan">/ </Text>
          <TextInput
            value={filter}
            onChange={(v) => {
              setFilter(v);
              setSel(0);
            }}
            onSubmit={() => setFiltering(false)}
            width={listW - 4}
            active={filtering}
            placeholder="filter by repo, title, author or label"
          />
        </Box>
      ) : props.notice ? (
        <Text color="green" wrap="truncate">
          {safe(props.notice)}
        </Text>
      ) : (
        <Text> </Text>
      )}
      <Box flexDirection="row" height={bodyH}>
        <Box flexDirection="column" width={listW} flexShrink={0}>
          {clip ? <ClipboardRow target={clip.target} listed={clipListed} preview={clipPreview} mine={clipMine} width={listW} /> : null}
          {err ? <Text color="red">{safe(err)}</Text> : null}
          {!prs && !err ? (
            <Text dimColor>
              <Text color="cyan">{SPIN[frame % SPIN.length]}</Text> Loading your review requests…
            </Text>
          ) : null}
          {prs && !items.length && filter ? <Text dimColor>Nothing matches the filter.</Text> : null}
          <Box flexDirection="column" height={Math.min(h, listH)} overflow="hidden" flexShrink={0}>
            {visible.map((r) => (
              // Rows keep their height: the box clips the last one rather than squeezing them all.
              <Box
                key={r.kind === 'pr' ? `pr:${keyFor(r.pr)}` : r.kind === 'repo' ? `repo:${r.own}:${r.repo}` : `${r.kind}:${r.kind === 'note' ? r.text : r.title}`}
                flexShrink={0}
                flexDirection="column"
              >
                {r.kind === 'note' ? (
                  <Text key={`note:${r.text}`} dimColor wrap="truncate">
                    {`  ${r.text}`}
                  </Text>
                ) : r.kind === 'section' ? (
                  <Text key={`section:${r.title}`} bold wrap="truncate">
                    {r.title} <Text dimColor>({r.count})</Text>
                  </Text>
                ) : r.kind === 'repo' ? (
                  <Text key={`repo:${r.own ? 'own' : 'review'}:${r.repo}`} color="cyan" bold wrap="truncate">
                    {safe(r.repo)} <Text dimColor>({r.count})</Text>
                  </Text>
                ) : (
                  <PRRow
                    key={r.pr.url}
                    pr={r.pr}
                    selected={r.index === sel}
                    marked={selected.has(keyFor(r.pr))}
                    width={listW}
                    local={local[`${r.pr.repo}#${r.pr.number}`]}
                    job={downloads[keyFor(r.pr)]}
                    // Only rows that are downloading take the frame, so the rest stay memoized.
                    spin={downloads[keyFor(r.pr)]?.state === 'running' ? SPIN[frame % SPIN.length] : undefined}
                  />
                )}
              </Box>
            ))}
          </Box>
          {authoredLine ? (
            <Box marginTop={1}>
              {authoredLoading ? (
                <Text wrap="truncate">
                  <Text bold>Your PRs </Text>
                  <Text color="cyan">{SPIN[frame % SPIN.length]}</Text>
                  <Text dimColor> loading…</Text>
                </Text>
              ) : (
                <Text dimColor wrap="truncate">
                  {truncate(`Your PRs couldn’t load (r to retry): ${safe(typeof authoredState === 'object' ? authoredState.error : '')}`, listW)}
                </Text>
              )}
            </Box>
          ) : null}
        </Box>
        {wide ? (
          <Box flexDirection="column" width={previewW} marginLeft={2} paddingLeft={1} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor="gray" flexShrink={0}>
            {current ? <Preview pr={current} preview={previews[key]} local={local[key]} width={previewW - 2} height={bodyH} /> : null}
          </Box>
        ) : null}
      </Box>
      <KeyBar
        width={width - 2}
        accent
        keys={pickerBar({ items: !!current, merge: !!props.onMerge, checks: !!props.onChecks, reviewers: !!props.onReviewers && !!current && isAuthored(current), theme: !!props.onTheme })}
        end={[
          ['?', 'keys'],
          ['q', 'quit'],
        ]}
      />
    </Box>
  );
  if (help && props.active !== false) return <HelpPopup background={screen} width={width} height={height} title="pull requests" sections={helpOf(PICKER_KEYS)} onClose={() => setHelp(false)} />;
  return screen;
}

export function keyFor(pr: Target): string {
  return `${pr.repo}#${pr.number}`;
}

// The copied PR, pinned above the list. Magenta, so it stands apart from the cyan list,
// green notices and yellow hints.
function ClipboardRow(props: { target: Target; listed?: ReviewRequest; preview?: PRPreview | { error: string }; mine: boolean; width: number }) {
  const { target, listed, preview, width } = props;
  const info = listed ?? (preview && !('error' in preview) ? preview : undefined);
  const meta = [target.repo, info ? (props.mine ? 'your PR' : `@${info.author}`) : '', preview && 'error' in preview ? `could not load: ${preview.error}` : ''].filter(Boolean).join(' · ');
  const action = props.mine ? 'open feedback' : 'open tour';
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="magenta" bold>
        {' ⎘ From clipboard'}
      </Text>
      <Text wrap="truncate">
        <Text color="magenta">▸</Text>
        <Text bold>{truncate(safe(` #${target.number} ${info?.title ?? ''}`), width - 2)}</Text>
      </Text>
      <Text wrap="truncate">
        <Text dimColor>{`     ${truncate(safe(meta), Math.max(1, width - 1 - 5 - ` · p ${action} · x dismiss`.length))} · `}</Text>
        <Text color="magenta" bold>
          p
        </Text>
        <Text dimColor> {action} · </Text>
        <Text color="magenta" bold>
          x
        </Text>
        <Text dimColor> dismiss</Text>
      </Text>
    </Box>
  );
}

function DownloadStatus(props: { keys: string[]; downloads: Record<string, DownloadJob>; frame: number; startedAt: number }) {
  const jobs = props.keys.map((k) => props.downloads[k]).filter(Boolean);
  const running = jobs.filter((j) => j.state === 'running').length;
  const queued = jobs.filter((j) => j.state === 'queued').length;
  const failed = jobs.filter((j) => j.state === 'failed').length;
  const finished = jobs.length - running - queued;
  const bar = progressBar(finished, jobs.length, props.frame);
  return (
    <Text wrap="truncate">
      <Text color="cyan">{`${SPIN[props.frame % SPIN.length]}   `}</Text>
      <Text color="cyan">{bar.filled}</Text>
      <Text dimColor>{bar.rest}</Text>
      <Text>
        {'   '}
        {finished}/{jobs.length}
      </Text>
      <Text dimColor>
        {` · ${running} downloading${queued ? ` · ${queued} queued` : ''}`}
        {failed ? <Text color="red">{` · ${failed} failed`}</Text> : null}
        {` · ${clock(Date.now() - props.startedAt)} · keep browsing`}
      </Text>
    </Text>
  );
}

// One piece of a row's subtitle. Plain pieces are dim; a colored one stands out.
interface Badge {
  text: string;
  color?: string;
  bold?: boolean;
}

// What one of your PRs needs from you, in place of its author.
export function authorBadges(pr: AuthoredPR): Badge[] {
  const more = pr.unresolvedThreadsAtLeast ? '+' : ''; // more threads than gr read
  const badges: (Badge | undefined)[] = [
    pr.openThreads ? { text: `${pr.openThreads}${more} open thread(s)`, color: 'yellow' } : pr.unresolvedThreads ? { text: `${pr.unresolvedThreads}${more} unresolved` } : undefined,
    pr.newReview ? { text: 'new review', color: 'cyan' } : undefined,
    pr.reviewDecision === 'CHANGES_REQUESTED' ? { text: 'changes requested', color: 'red' } : pr.reviewDecision === 'APPROVED' ? { text: 'approved', color: 'green' } : undefined,
    readyToMerge(pr) ? { text: '✓ ready to merge', color: 'green', bold: true } : undefined,
    // Once it can merge, a repository that needs no review has nothing to ask for.
    pr.noReviewers && !readyToMerge(pr) ? { text: 'no reviewers requested', color: 'yellow' } : undefined,
    // Passing checks go without saying; ready to merge says they passed.
    checksFailing(pr) ? { text: '✗ checks failing', color: 'red' } : pr.checks === 'PENDING' ? { text: '● checks running', color: 'yellow' } : undefined,
    !needsAuthor(pr) && !pr.isDraft ? { text: 'waiting on review' } : undefined,
  ];
  return badges.filter((b): b is Badge => !!b);
}

const PRRow = React.memo(function PRRow(props: { pr: ReviewRequest | AuthoredPR; selected: boolean; marked: boolean; width: number; local?: Local; job?: DownloadJob; spin?: string }) {
  const { pr, selected, marked, width, job } = props;
  const drafts = props.local?.drafts ?? 0;
  const toured = !!props.local?.tourHead;
  const who: Badge[] = isAuthored(pr) ? authorBadges(pr) : [{ text: `@${pr.author}` }];
  const meta: Badge[] = [
    ...who,
    ...[age(pr.updatedAt), pr.isDraft ? 'draft' : '', ...pr.labels.slice(0, 2), toured ? 'toured' : '', drafts ? `${drafts} draft comment(s)` : ''].filter(Boolean).map((text) => ({ text })),
  ];
  const bar = selected ? <Text color="cyan">▌</Text> : <Text> </Text>;
  // A mark wins over the download glyph: it's what the next `d` will act on.
  const glyph = marked
    ? { text: '☑' }
    : job?.state === 'running'
      ? { text: props.spin ?? SPIN[0], color: 'cyan' }
      : job?.state === 'queued'
        ? { text: '◌', color: 'gray' }
        : job?.state === 'done'
          ? { text: '✓', color: 'green' }
          : job?.state === 'failed'
            ? { text: '✗', color: 'red' }
            : { text: ' ' };
  const status =
    job?.state === 'running'
      ? { text: `${job.step ?? 'Downloading'}…`, color: 'cyan' }
      : job?.state === 'queued'
        ? { text: 'queued for download', color: 'gray' }
        : job?.state === 'failed'
          ? { text: `download failed: ${job.error ?? 'unknown error'}`, color: 'red' }
          : undefined;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        {bar}
        <Text color={glyph.color}>{glyph.text}</Text>
        <Text bold={selected} color={selected ? 'cyan' : undefined} dimColor={pr.isDraft && !selected}>
          {pad(` #${pr.number} ${pr.title}`, width - 2)}
        </Text>
      </Text>
      <Text wrap="truncate">
        {bar}
        {status ? (
          <Text color={status.color}>{truncate(`   ${safe(status.text)}`, width - 1)}</Text>
        ) : (
          <Text>
            {'   '}
            {meta.map((b, i) => (
              <Text key={i}>
                {i ? <Text dimColor> · </Text> : null}
                <Text color={b.color} bold={b.bold} dimColor={!b.color}>
                  {safe(b.text)}
                </Text>
              </Text>
            ))}
          </Text>
        )}
      </Text>
    </Box>
  );
});

const DECISION: Record<string, { text: string; color: string }> = {
  APPROVED: { text: 'approved', color: 'green' },
  CHANGES_REQUESTED: { text: 'changes requested', color: 'red' },
  REVIEW_REQUIRED: { text: 'review required', color: 'yellow' },
};

// Memoized: the description's Markdown is rendered once per PR, not on every j/k.
const Preview = React.memo(function Preview(props: { pr: ReviewRequest | AuthoredPR; preview?: PRPreview | { error: string }; local?: Local; width: number; height: number }) {
  const { pr, preview, width, height } = props;
  const lines: React.ReactNode[] = [];
  const push = (n: React.ReactNode) => lines.push(<React.Fragment key={lines.length}>{n}</React.Fragment>);

  for (const l of wrap(safe(pr.title), width).slice(0, 2)) push(<Text bold>{l}</Text>);
  push(
    <Text dimColor wrap="truncate">
      {safe(`${pr.repo}#${pr.number} · @${pr.author}`)} · updated {age(pr.updatedAt)}
    </Text>,
  );

  if (!preview) {
    push(<Text> </Text>);
    push(<Text dimColor>Loading preview…</Text>);
  } else if ('error' in preview) {
    push(<Text> </Text>);
    push(<Text color="red">{truncate(preview.error, width)}</Text>);
  } else {
    const p = preview;
    push(
      <Text wrap="truncate">
        <Text dimColor>{truncate(`${p.headRefName} → ${p.baseRefName}`, width)}</Text>
      </Text>,
    );
    push(<Text> </Text>);
    const decision = DECISION[p.reviewDecision];
    push(
      <Text wrap="truncate">
        <Text color="green">+{p.additions}</Text> <Text color="red">-{p.deletions}</Text>
        <Text dimColor> · {p.changedFiles} file(s)</Text>
        {p.isDraft ? <Text color="gray"> · draft</Text> : null}
        {decision ? <Text color={decision.color}> · {decision.text}</Text> : null}
        {p.mergeable === 'CONFLICTING' ? <Text color="red"> · merge conflicts</Text> : null}
        {!p.isDraft && MERGEABLE.includes(p.mergeStateStatus ?? '') ? <Text color="green"> · ready to merge (M)</Text> : null}
      </Text>,
    );
    const c = p.checks;
    if (c.passed + c.failed + c.pending) {
      push(
        <Text wrap="truncate">
          <Text dimColor>checks </Text>
          {c.failed ? <Text color="red">✗ {c.failed} failing </Text> : null}
          {c.pending ? <Text color="yellow">● {c.pending} running </Text> : null}
          {c.passed ? <Text color="green">✓ {c.passed} passed</Text> : null}
          {c.failed || c.pending ? <Text dimColor> · c to view</Text> : null}
        </Text>,
      );
      // What failed or is still running, by name, as author mode lists them.
      const loud = sortChecks(c.items ?? []).filter((i) => i.state === 'failed' || i.state === 'pending');
      for (const i of loud.slice(0, 4)) {
        const m = CHECK_MARK[i.state];
        push(
          <Text wrap="truncate">
            {'  '}
            <Text color={m.color}>{`${m.mark} `}</Text>
            {truncate(safe(checkLabel(i, c.items)), Math.max(8, width - 16))}
            <Text dimColor>{` ${outcomeText(i)}`}</Text>
          </Text>,
        );
      }
      if (loud.length > 4) push(<Text dimColor>{`  … ${loud.length - 4} more`}</Text>);
      else if (!c.items && c.failedNames.length) push(<Text dimColor wrap="truncate">{`  ${safe(c.failedNames.slice(0, 3).join(', '))}`}</Text>);
    }
    if (p.labels.length) push(<Text wrap="truncate">{safe(p.labels.map((l) => `[${l}]`).join(' '))}</Text>);

    const tourHead = props.local?.tourHead;
    const drafts = props.local?.drafts ?? 0;
    if (tourHead) {
      const fresh = tourHead === p.headSha;
      push(
        <Text color={fresh ? 'green' : 'yellow'} wrap="truncate">
          {fresh ? '● Tour ready: opens instantly' : `◐ The author pushed since your tour (${safe(tourHead.slice(0, 7))}): opens as a re-review`}
          {drafts ? <Text dimColor>{` · ${drafts} draft comment(s)`}</Text> : null}
        </Text>,
      );
    }

    // The files take what they need (up to 8); the description gets the rest.
    const fileRows = Math.min(8, p.files.length);
    const room = height - lines.length - (fileRows ? fileRows + 3 : 0) - 2;
    if (room >= 3) {
      push(<Text> </Text>);
      push(
        <Text bold dimColor>
          Description
        </Text>,
      );
      const body = p.body.trim() ? renderMarkdown(p.body, width) : [line('(no description)', { dim: true })];
      const shown = body.slice(0, room - 2);
      for (const l of shown) push(<MdLineView line={l} />);
      if (body.length > shown.length) push(<Text dimColor italic>{`… ${body.length - shown.length} more line(s)`}</Text>);
    }
    if (fileRows) {
      push(<Text> </Text>);
      push(
        <Text bold dimColor>
          Files
        </Text>,
      );
      const numW = 12;
      const files = [...p.files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions)).slice(0, fileRows);
      for (const f of files) {
        push(
          <Text wrap="truncate">
            <Text color="green">{`+${f.additions}`.padStart(5)}</Text>
            <Text color="red">{` -${f.deletions}`.padEnd(7)}</Text> {truncate(f.path, width - numW - 1)}
          </Text>,
        );
      }
      if (p.files.length > fileRows) push(<Text dimColor>{`      … ${p.files.length - fileRows} more`}</Text>);
    }
  }

  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {lines.slice(0, height)}
    </Box>
  );
});
