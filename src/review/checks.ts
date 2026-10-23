import type { CheckItem, CheckState } from '../github/gh.js';

// The PR's checks as the author reads them: what failed, what is still running, and each job's
// log, opened where it went wrong.

const ORDER: Record<CheckState, number> = { failed: 0, pending: 1, passed: 2, skipped: 3 };

// Failures first (a cancelled job after one that failed), then what is still running, then
// the rest; required before optional, then by name.
export function sortChecks(items: CheckItem[]): CheckItem[] {
  const cancelled = (c: CheckItem) => Number(c.outcome === 'CANCELLED');
  return [...items].sort((a, b) => ORDER[a.state] - ORDER[b.state] || cancelled(a) - cancelled(b) || Number(b.required) - Number(a.required) || checkLabel(a).localeCompare(checkLabel(b)));
}

// "CI / test (ubuntu, 22)". A workflow that runs on both push and pull_request lists each job
// twice; `all` names the event on those.
export function checkLabel(c: CheckItem, all?: CheckItem[]): string {
  const base = c.workflow ? `${c.workflow} / ${c.name}` : c.name;
  const twin = all?.some((o) => o !== c && o.name === c.name && o.workflow === c.workflow);
  return twin && c.event ? `${base} (${c.event})` : base;
}

export const CHECK_MARK: Record<CheckState, { mark: string; color: string; text: string }> = {
  failed: { mark: '✗', color: 'red', text: 'failed' },
  pending: { mark: '●', color: 'yellow', text: 'running' },
  passed: { mark: '✓', color: 'green', text: 'passed' },
  skipped: { mark: '–', color: 'gray', text: 'skipped' },
};

// What a check's state says beyond its mark: "cancelled", "queued", "timed out".
export function outcomeText(c: CheckItem): string {
  const o = c.outcome.toLowerCase().replace(/_/g, ' ');
  if (c.state === 'failed') return o === 'failure' || o === 'error' ? 'failed' : o;
  if (c.state === 'pending') return o === 'in progress' ? 'running' : o || 'pending';
  return o === 'success' ? 'passed' : o;
}

// How long a check ran, or has been running: "1m 12s".
export function duration(c: CheckItem, now = Date.now()): string {
  if (!c.startedAt) return '';
  const end = c.completedAt ? Date.parse(c.completedAt) : now;
  const s = Math.max(0, Math.round((end - Date.parse(c.startedAt)) / 1000));
  if (Number.isNaN(s)) return '';
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export interface LogLine {
  kind: 'step' | 'error' | 'warning' | 'command' | 'line';
  text: string;
}

// Escape sequences the tools in a job print, colours mostly: removed whole, as sanitizing
// would only drop their ESC and leave "[31m" behind.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

// An Actions log, line by line: timestamps and colours dropped, `##[group]` lines as the steps
// they start, and errors and warnings marked. The text still goes through sanitizeTerminal.
export function parseJobLog(log: string): LogLine[] {
  const out: LogLine[] = [];
  for (const raw of log.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(ANSI, '');
    const m = /^##\[(\w+)\](.*)$/.exec(line);
    if (!m) {
      out.push({ kind: 'line', text: line });
      continue;
    }
    const [, tag, text] = m;
    if (tag === 'endgroup') continue;
    if (tag === 'group') out.push({ kind: 'step', text });
    else if (tag === 'error') out.push({ kind: 'error', text });
    else if (tag === 'warning') out.push({ kind: 'warning', text });
    else if (tag === 'command') out.push({ kind: 'command', text });
    else out.push({ kind: 'line', text });
  }
  while (out.length && !out[out.length - 1].text.trim()) out.pop();
  return out;
}

// Where to open a log: at its first error, the failing command's output above it; else at
// the end, where a running job is. -1 for an empty log.
export function logFocus(lines: LogLine[]): number {
  const err = lines.findIndex((l) => l.kind === 'error');
  return err >= 0 ? err : lines.length - 1;
}
