import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { fetchPRPreview, listReviewRequests, type PRPreview, type ReviewRequest } from '../github/gh.js';
import type { Store } from '../store/db.js';
import { KeyBar } from './ChapterScreen.js';
import { TextInput } from './TextInput.js';
import { pad, truncate, wrap } from './nav.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';
import { openExternal } from '../util/openExternal.js';
import { MdLineView, line, renderMarkdown } from './markdown.js';

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

type Row = { kind: 'repo'; repo: string; count: number } | { kind: 'pr'; pr: ReviewRequest; index: number };

// PRs grouped by repo (repos with the most recent activity first), filtered by text.
export function pickerRows(prs: ReviewRequest[], filter: string): { rows: Row[]; items: ReviewRequest[] } {
  const f = filter.trim().toLowerCase();
  const matching = prs.filter((p) => !f || `${p.repo}#${p.number} ${p.title} ${p.author} ${p.labels.join(' ')}`.toLowerCase().includes(f));
  const groups = new Map<string, ReviewRequest[]>();
  for (const p of matching) {
    const list = groups.get(p.repo);
    if (list) list.push(p);
    else groups.set(p.repo, [p]);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1][0].updatedAt.localeCompare(a[1][0].updatedAt));
  const rows: Row[] = [];
  const items: ReviewRequest[] = [];
  for (const [repo, list] of ordered) {
    rows.push({ kind: 'repo', repo, count: list.length });
    for (const pr of list) {
      rows.push({ kind: 'pr', pr, index: items.length });
      items.push(pr);
    }
  }
  return { rows, items };
}

interface PickerProps {
  store: Store;
  width: number;
  height: number;
  notice?: string;
  onPick: (t: Target) => void;
  onQuit: () => void;
  downloads: Record<string, DownloadJob>;
  onDownload: (targets: Target[]) => void; // queues tours; progress arrives through `downloads`
}

export function PickerScreen(props: PickerProps) {
  const { width, height } = props;
  const [prs, setPrs] = useState<ReviewRequest[] | undefined>();
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
  const inflight = useRef(new Set<string>());

  const load = () => {
    setPrs(undefined);
    setErr('');
    setSelected(new Set());
    listReviewRequests().then(
      (p) => {
        setPrs(p);
        setLoadedAt(Date.now());
      },
      (e) => setErr((e as Error).message),
    );
  };
  useEffect(load, []);

  const { rows, items } = useMemo(() => pickerRows(prs ?? [], filter), [prs, filter]);
  // What's already on this machine for each PR: cheap queries, computed once per list.
  const local = useMemo(() => {
    const out: Record<string, Local> = {};
    for (const p of prs ?? []) {
      // listTours is newest first.
      const latest = props.store.listTours(p.repo, p.number)[0];
      out[`${p.repo}#${p.number}`] = { tourHead: latest?.headSha, drafts: props.store.listDrafts(p.repo, p.number).filter((d) => !d.posted).length };
    }
    return out;
    // localVersion is a cache buster: finished downloads write to the store behind this memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prs, localVersion, props.store]);
  const current = items[Math.min(sel, items.length - 1)];
  const key = current ? `${current.repo}#${current.number}` : '';

  // Downloads since the queue was last empty, summarized once they all finish.
  const { downloads } = props;
  const activeKeys = Object.keys(downloads).filter((k) => isActive(downloads[k]));
  const active = activeKeys.length > 0;
  const wave = useRef({ keys: new Set(activeKeys), startedAt: Date.now() });
  const wasActive = useRef(false);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setFrame((f) => f + 1), FRAME_MS);
    return () => clearInterval(t);
  }, [active]);
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

  useInput(
    (input, key) => {
      setHint('');
      if (key.escape || input === 'q') return props.onQuit();
      if (input === '/') {
        setDownloadNotice('');
        return setFiltering(true);
      }
      if (input === 'r') return load();
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
      if (key.return && current) {
        // Opening a PR mid-download would build its tour twice; others open as usual.
        if (isActive(downloads[keyFor(current)])) return setHint(`${keyFor(current)} is still downloading · it opens instantly once ready`);
        props.onPick({ repo: current.repo, number: current.number });
      }
      if (input === 'o' && current) openExternal(current.url).catch((e: unknown) => setHint(`Could not open ${current.url}: ${(e as Error).message}`));
    },
    { isActive: !filtering },
  );
  useInput(
    (_input, key) => {
      if (key.escape) {
        setFilter('');
        setFiltering(false);
      }
    },
    { isActive: filtering },
  );

  const wide = width >= 110;
  const listW = wide ? Math.min(70, Math.max(48, Math.floor(width * 0.42))) : width - 2;
  const previewW = wide ? width - listW - 5 : 0;
  const bodyH = height - 4; // title, key bar, filter line, spacing

  // Keep the selection in view; each PR takes two rows.
  const selRow = rows.findIndex((r) => r.kind === 'pr' && r.index === sel);
  const rowH = (r: Row) => (r.kind === 'repo' ? 1 : 2);
  let start = 0;
  let used = rows.slice(0, selRow + 1).reduce((n, r) => n + rowH(r), 0);
  while (used > bodyH - 1 && start < selRow) used -= rowH(rows[start++]);
  if (start > 0 && rows[start - 1]?.kind === 'repo') start--; // keep the repo header with its first PR
  const visible: Row[] = [];
  let h = 0;
  for (let i = start; i < rows.length && h + rowH(rows[i]) <= bodyH; i++) {
    visible.push(rows[i]);
    h += rowH(rows[i]);
  }

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Text wrap="truncate">
        <Text bold>Review requests</Text>
        <Text dimColor>{prs ? `  ${items.length}${filter ? ` of ${prs.length}` : ''} waiting on you · updated ${age(new Date(loadedAt).toISOString())}` : ''}</Text>
      </Text>
      <KeyBar
        width={width - 2}
        keys={[
          ['d', 'download'],
          ['space', 'select'],
          ['a', 'select all'],
          ['enter', 'open tour'],
          ['j/k', 'move'],
          ['/', 'filter'],
          ['o', 'open in browser'],
          ['r', 'refresh'],
          ['q', 'quit'],
        ]}
      />
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
          {err ? <Text color="red">{safe(err)}</Text> : null}
          {!prs && !err ? <Text dimColor>Loading your review requests…</Text> : null}
          {prs && !items.length ? <Text dimColor>{filter ? 'Nothing matches the filter.' : 'Nothing is waiting on you. gr review <number or URL> opens a specific PR.'}</Text> : null}
          {visible.map((r) =>
            r.kind === 'repo' ? (
              <Text key={`repo:${r.repo}`} color="cyan" bold wrap="truncate">
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
            ),
          )}
        </Box>
        {wide ? (
          <Box flexDirection="column" width={previewW} marginLeft={2} paddingLeft={1} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor="gray" flexShrink={0}>
            {current ? <Preview pr={current} preview={previews[key]} local={local[key]} width={previewW - 2} height={bodyH} /> : null}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

export function keyFor(pr: Target): string {
  return `${pr.repo}#${pr.number}`;
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

const PRRow = React.memo(function PRRow(props: { pr: ReviewRequest; selected: boolean; marked: boolean; width: number; local?: Local; job?: DownloadJob; spin?: string }) {
  const { pr, selected, marked, width, job } = props;
  const drafts = props.local?.drafts ?? 0;
  const toured = !!props.local?.tourHead;
  const meta = [`@${pr.author}`, age(pr.updatedAt), pr.isDraft ? 'draft' : '', ...pr.labels.slice(0, 2), toured ? 'toured' : '', drafts ? `${drafts} draft comment(s)` : '']
    .filter(Boolean)
    .join(' · ');
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
        {status ? <Text color={status.color}>{truncate(`   ${safe(status.text)}`, width - 1)}</Text> : <Text dimColor>{truncate(`   ${meta}`, width - 1)}</Text>}
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
const Preview = React.memo(function Preview(props: { pr: ReviewRequest; preview?: PRPreview | { error: string }; local?: Local; width: number; height: number }) {
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
      </Text>,
    );
    const c = p.checks;
    if (c.passed + c.failed + c.pending) {
      push(
        <Text wrap="truncate">
          <Text dimColor>checks </Text>
          {c.failed ? <Text color="red">✗ {c.failed} failing </Text> : null}
          {c.pending ? <Text color="yellow">◷ {c.pending} running </Text> : null}
          {c.passed ? <Text color="green">✓ {c.passed} passed</Text> : null}
          {c.failedNames.length ? <Text dimColor> ({safe(c.failedNames.slice(0, 3).join(', '))})</Text> : null}
        </Text>,
      );
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
