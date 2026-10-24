import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInput } from 'ink';
import { Box, Text, useSelected } from './themed.js';
import { fetchJobLog, fetchMergeStatus, type CheckItem, type MergeStatus } from '../github/gh.js';
import { CHECK_MARK, checkLabel, duration, logFocus, outcomeText, parseJobLog, sortChecks, type LogLine } from '../review/checks.js';
import { openExternal } from '../util/openExternal.js';
import { Spinner } from './Spinner.js';
import { KeyBar } from './KeyBar.js';
import { Help } from './Help.js';
import { helpOf } from './keys.js';
import { CHECK_LOG_KEYS, CHECKS_KEYS, checkLogBar, checksBar } from './screenKeys.js';
import { pad, truncate } from './nav.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';

// While checks are running, how often their state is read again.
export const CHECK_POLL_MS = 20_000;

// The checks popup for a PR no screen has loaded: it reads the PR's checks itself, and again
// while any is running.
export function ChecksLoader(props: { repo: string; number: number; width: number; height: number; onClose: () => void; onQuit?: () => void }) {
  const [status, setStatus] = useState<MergeStatus>();
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(true);
  const read = useCallback(() => {
    setRefreshing(true);
    fetchMergeStatus(props.repo, props.number)
      .then(
        (st) => {
          setStatus(st);
          setError('');
        },
        (e: unknown) => setError((e as Error).message),
      )
      .finally(() => setRefreshing(false));
  }, [props.repo, props.number]);
  useEffect(read, [read]);
  const running = !!status?.checks.pending;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(read, CHECK_POLL_MS);
    return () => clearInterval(t);
  }, [running, read]);
  useInput(
    (input, key) => {
      if (key.escape || input === 'q' || input === 'c') props.onClose();
      if (input === 'Q') props.onQuit?.();
      if (input === 'R') read();
    },
    { isActive: !status },
  );
  if (!status)
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>{`Checks on ${safe(props.repo)}#${props.number}`}</Text>
        {error ? (
          <Text color="red">Couldn't read the checks: {safe(error)}</Text>
        ) : (
          <Text>
            <Spinner /> Reading the checks…
          </Text>
        )}
        <Text dimColor>{error ? 'R: retry · ' : ''}esc: close</Text>
      </Box>
    );
  return (
    <ChecksScreen repo={props.repo} headSha={status.headSha} checks={status.checks.items} refreshing={refreshing} width={props.width} height={props.height} onRefresh={read} onClose={props.onClose} />
  );
}

const LOG_STYLE: Record<LogLine['kind'], { color?: string; bold?: boolean; dimColor?: boolean; mark: string }> = {
  step: { color: 'cyan', bold: true, mark: '▸ ' },
  error: { color: 'red', bold: true, mark: '✗ ' },
  warning: { color: 'yellow', mark: '⚠ ' },
  command: { dimColor: true, mark: '$ ' },
  line: { mark: '  ' },
};

// The PR's checks, failures first, and a GitHub Actions job's log, opened at its first error.
// Other checks (apps, commit statuses) open in the browser.
export function ChecksScreen(props: {
  repo: string;
  headSha: string;
  checks: CheckItem[];
  refreshing?: boolean;
  width: number;
  height: number;
  onRefresh: () => void;
  onClose: () => void;
  onQuit?: () => void; // Q
  open?: (url: string) => Promise<void>; // tests stub the browser
}) {
  const { width, height } = props;
  const selectedRow = useSelected();
  const checks = useMemo(() => sortChecks(props.checks), [props.checks]);
  const [sel, setSel] = useState(0);
  const [log, setLog] = useState<{ check: CheckItem; lines?: LogLine[]; error?: string; top: number }>();
  const [flash, setFlash] = useState('');
  const [help, setHelp] = useState(false);
  useEffect(() => setSel((s) => Math.min(s, Math.max(0, checks.length - 1))), [checks.length]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(''), 3000);
    return () => clearTimeout(t);
  }, [flash]);

  const viewH = Math.max(3, height - 4); // title, summary or status, gap, key bar
  const openUrl = (c: CheckItem) => {
    if (!c.url) return setFlash('This check has no page to open.');
    void (props.open ?? openExternal)(c.url).then(
      () => setFlash('Opened in your browser.'),
      () => setFlash(`Couldn't open a browser: ${c.url}`),
    );
  };
  const readLog = (c: CheckItem) => {
    setLog({ check: c, top: 0 });
    void fetchJobLog(props.repo, c.jobId!).then(
      (text) => {
        const lines = parseJobLog(text);
        const focus = logFocus(lines);
        // The error a third of the way up from the bottom, with the output that led to it above.
        const top = Math.max(0, Math.min(focus - Math.floor((viewH * 2) / 3), lines.length - viewH));
        setLog((l) => (l?.check === c ? { check: c, lines, top } : l));
      },
      (e: unknown) => setLog((l) => (l?.check === c ? { check: c, error: (e as Error).message, top: 0 } : l)),
    );
  };

  useInput((input, key) => {
    if (help) return;
    if (input === 'Q') return props.onQuit?.();
    if (input === '?' || input === 'h') return setHelp(true);
    if (log) {
      const lines = log.lines ?? [];
      const max = Math.max(0, lines.length - viewH);
      const to = (top: number) => setLog({ ...log, top: Math.max(0, Math.min(max, top)) });
      if (key.escape || input === 'q') return setLog(undefined);
      if (input === 'j' || key.downArrow) return to(log.top + 1);
      if (input === 'k' || key.upArrow) return to(log.top - 1);
      if (input === ' ' || key.pageDown) return to(log.top + viewH - 1);
      if (key.pageUp) return to(log.top - viewH + 1);
      if (input === 'd') return to(log.top + Math.floor(viewH / 2));
      if (input === 'u') return to(log.top - Math.floor(viewH / 2));
      if (input === 'g') return to(0);
      if (input === 'G') return to(max);
      if (input === 'n' || input === 'N') {
        // The next error below the view's top third, or the previous one above it.
        const from = log.top + Math.floor((viewH * 2) / 3);
        const idx = input === 'n' ? lines.findIndex((l, i) => i > from && l.kind === 'error') : lines.findLastIndex((l, i) => i < from && l.kind === 'error');
        if (idx < 0) return setFlash(input === 'n' ? 'No more errors below.' : 'No errors above.');
        return to(idx - Math.floor((viewH * 2) / 3));
      }
      if (input === 'o') return openUrl(log.check);
      if (input === 'R') return readLog(log.check);
      return;
    }
    if (key.escape || input === 'q' || input === 'c') return props.onClose();
    if (input === 'j' || key.downArrow) return setSel((s) => Math.min(checks.length - 1, s + 1));
    if (input === 'k' || key.upArrow) return setSel((s) => Math.max(0, s - 1));
    const c = checks[sel];
    if (key.return && c) return c.jobId ? readLog(c) : openUrl(c);
    if (input === 'o' && c) return openUrl(c);
    if (input === 'R') return props.onRefresh();
  });

  if (help) return <Help title={log ? 'job log' : 'checks'} sections={helpOf(log ? CHECK_LOG_KEYS : CHECKS_KEYS)} width={width} height={height} onClose={() => setHelp(false)} />;
  if (log) {
    const c = log.check;
    const m = CHECK_MARK[c.state];
    const lines = log.lines ?? [];
    const errors = lines.filter((l) => l.kind === 'error').length;
    // The step the top of the view is in, named above the log: its header has often scrolled off.
    const step = lines.slice(0, log.top + 1).findLast((l) => l.kind === 'step');
    return (
      <Box flexDirection="column" width={width} height={height} paddingX={1}>
        <Text wrap="truncate">
          <Text color={m.color}>{`${m.mark} `}</Text>
          <Text bold>{safe(checkLabel(c, props.checks))}</Text>
          <Text dimColor>{` · ${outcomeText(c)}${duration(c) ? ` · ${duration(c)}` : ''}`}</Text>
        </Text>
        <Text dimColor wrap="truncate">
          {step && !flash ? <Text color="cyan">{`▸ ${safe(step.text)} · `}</Text> : null}
          {flash ||
            (log.lines
              ? `${lines.length ? `lines ${log.top + 1}–${Math.min(lines.length, log.top + viewH)} of ${lines.length}` : 'The log is empty.'}${errors ? ` · ${errors} error(s)` : ''}${c.state === 'pending' ? ' · still running: R reads it again' : ''}`
              : '')}
        </Text>
        <Box flexDirection="column" height={viewH} overflow="hidden">
          {log.error ? (
            <Text color="red">Couldn't read the log: {safe(log.error)}</Text>
          ) : !log.lines ? (
            <Text>
              <Spinner /> Reading the log…
            </Text>
          ) : (
            lines.slice(log.top, log.top + viewH).map((l, i) => {
              const st = LOG_STYLE[l.kind];
              return (
                <Text key={log.top + i} wrap="truncate" color={st.color} bold={st.bold} dimColor={st.dimColor}>
                  {truncate(`${st.mark}${safe(l.text.replace(/\t/g, '  '))}`, width - 2)}
                </Text>
              );
            })
          )}
        </Box>
        <KeyBar
          width={width - 2}
          keys={checkLogBar()}
          end={[
            ['esc', 'checks'],
            ['?', 'keys'],
          ]}
        />
      </Box>
    );
  }

  const counts = { failed: 0, pending: 0, passed: 0, skipped: 0 };
  for (const c of checks) counts[c.state]++;
  const listH = Math.max(1, height - 4);
  const start = Math.max(0, Math.min(sel - Math.floor(listH / 2), checks.length - listH));
  const labelW = Math.max(12, width - 30);
  const cur = checks[sel];
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Text wrap="truncate">
        <Text bold>Checks</Text>
        <Text dimColor>{` on ${safe(props.headSha.slice(0, 8))} · `}</Text>
        {(['failed', 'pending', 'passed', 'skipped'] as const)
          .filter((s) => counts[s])
          .map((s, i) => (
            <Text key={s}>
              {i ? <Text dimColor> · </Text> : null}
              <Text color={CHECK_MARK[s].color}>{`${counts[s]} ${CHECK_MARK[s].text}`}</Text>
            </Text>
          ))}
        {props.refreshing ? (
          <Text>
            {'  '}
            <Spinner />
          </Text>
        ) : null}
      </Text>
      <Text dimColor wrap="truncate">
        {flash || (checks.length ? (cur?.description ? safe(cur.description) : ' ') : 'No checks have reported on this commit.')}
      </Text>
      <Box flexDirection="column" height={listH} overflow="hidden">
        {checks.slice(start, start + listH).map((c, k) => {
          const i = start + k;
          const m = CHECK_MARK[c.state];
          const meta = `${outcomeText(c)}${duration(c) ? ` · ${duration(c)}` : ''}${c.required ? ' · required' : ''}`;
          return (
            <Text key={`${i}:${c.url ?? c.name}`} {...selectedRow(i === sel)} wrap="truncate">
              <Text color={m.color}>{`${m.mark} `}</Text>
              {pad(truncate(safe(checkLabel(c, props.checks)), labelW), labelW)}
              <Text dimColor>{` ${meta}`}</Text>
            </Text>
          );
        })}
      </Box>
      <KeyBar
        width={width - 2}
        keys={checksBar({ log: !!cur?.jobId, url: !!cur?.url })}
        end={[
          ['esc', 'close'],
          ['?', 'keys'],
        ]}
      />
    </Box>
  );
}
