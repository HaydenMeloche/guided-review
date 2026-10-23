import { describe, expect, it } from 'vitest';
import { latestChecks, rollupState, summarizeChecks, type CheckItem } from '../src/github/gh.js';
import { checkLabel, duration, logFocus, outcomeText, parseJobLog, sortChecks } from '../src/review/checks.js';

const check = (over: Partial<CheckItem>): CheckItem => ({ name: 'test', state: 'passed', outcome: 'SUCCESS', required: false, ...over });

describe('summarizeChecks items', () => {
  it('lists each check with its workflow, job, page and state', () => {
    const { items } = summarizeChecks([
      {
        name: 'test',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        isRequired: true,
        databaseId: 42,
        detailsUrl: 'https://github.com/o/r/actions/runs/1/job/42',
        startedAt: '2026-10-15T13:33:25Z',
        completedAt: '2026-10-15T13:34:20Z',
        checkSuite: { app: { name: 'GitHub Actions' }, workflowRun: { event: 'pull_request', workflow: { name: 'CI' } } },
      },
      { name: 'lint', status: 'IN_PROGRESS', conclusion: null, checkSuite: { workflowRun: { workflow: { name: 'CI' } } }, databaseId: 43 },
      { name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { context: 'deploy/preview', state: 'SUCCESS', targetUrl: 'https://example.com/d', description: 'Deployed' },
      { name: 'gh-view', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'Release' },
    ]);
    expect(items[0]).toEqual({
      name: 'test',
      state: 'failed',
      outcome: 'FAILURE',
      required: true,
      workflow: 'CI',
      event: 'pull_request',
      app: 'GitHub Actions',
      jobId: 42,
      url: 'https://github.com/o/r/actions/runs/1/job/42',
      startedAt: '2026-10-15T13:33:25Z',
      completedAt: '2026-10-15T13:34:20Z',
    });
    expect(items[1]).toMatchObject({ state: 'pending', outcome: 'IN_PROGRESS', jobId: 43 });
    expect(items[2]).toMatchObject({ state: 'skipped' });
    expect(items[3]).toMatchObject({ name: 'deploy/preview', state: 'passed', url: 'https://example.com/d', description: 'Deployed' });
    expect(items[3].jobId).toBeUndefined();
    expect(items[4]).toMatchObject({ workflow: 'Release' });
  });
});

describe('the latest run of each check', () => {
  const labels = (event: string, startedAt: string, conclusion: string) => ({
    name: 'label',
    status: 'COMPLETED',
    conclusion,
    startedAt,
    checkSuite: { workflowRun: { event, workflow: { name: 'Require PR Labels' } } },
  });
  it('counts only the newest, so a failure a later run replaced is gone', () => {
    // pinecorpca/evergreen#4290: the label check failed, then passed once the label was added.
    const contexts = [
      labels('pull_request', '2026-10-20T16:05:23Z', 'FAILURE'),
      { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-10-20T16:05:06Z', checkSuite: { workflowRun: { event: 'push', workflow: { name: 'commit' } } } },
      labels('pull_request', '2026-10-20T16:05:54Z', 'SUCCESS'),
    ];
    const s = summarizeChecks(contexts);
    expect(s).toMatchObject({ passed: 2, failed: 0, failedNames: [] });
    expect(s.items.map((c) => c.name)).toEqual(['build', 'label']);
    expect(rollupState(s)).toBe('SUCCESS');
  });
  it('keeps a run per event, as GitHub lists push and pull_request apart', () => {
    expect(latestChecks([labels('push', '2026-10-20T16:05:23Z', 'FAILURE'), labels('pull_request', '2026-10-20T16:05:54Z', 'SUCCESS')])).toHaveLength(2);
  });
  it('takes a queued re-run, not yet started, over the run it replaces', () => {
    const queued = { name: 'label', status: 'QUEUED', conclusion: null, checkSuite: { workflowRun: { event: 'pull_request', workflow: { name: 'Require PR Labels' } } } };
    const s = summarizeChecks([labels('pull_request', '2026-10-20T16:05:23Z', 'FAILURE'), queued]);
    expect(s).toMatchObject({ failed: 0, pending: 1 });
    expect(rollupState(s)).toBe('PENDING');
  });
  it('says FAILURE over PENDING, and nothing with no checks', () => {
    expect(rollupState({ passed: 1, failed: 1, pending: 1 })).toBe('FAILURE');
    expect(rollupState({ passed: 0, failed: 0, pending: 0 })).toBe('');
  });
});

describe('the checks list', () => {
  it('puts failures first, then running, required before optional', () => {
    const sorted = sortChecks([check({ name: 'a' }), check({ name: 'b', state: 'pending' }), check({ name: 'c', state: 'failed' }), check({ name: 'd', state: 'failed', required: true })]);
    expect(sorted.map((c) => c.name)).toEqual(['d', 'c', 'b', 'a']);
    expect(sortChecks([check({ name: 'x', state: 'failed', outcome: 'CANCELLED', required: true }), check({ name: 'y', state: 'failed', outcome: 'FAILURE' })]).map((c) => c.name)).toEqual(['y', 'x']);
  });
  it('names the workflow, and the event when a job ran twice', () => {
    const push = check({ workflow: 'CI', event: 'push' });
    const pr = check({ workflow: 'CI', event: 'pull_request' });
    expect(checkLabel(push)).toBe('CI / test');
    expect(checkLabel(push, [push, pr])).toBe('CI / test (push)');
    expect(checkLabel(check({ name: 'deploy' }), [push])).toBe('deploy');
  });
  it('says what a state means and how long the check ran', () => {
    expect(outcomeText(check({ state: 'failed', outcome: 'TIMED_OUT' }))).toBe('timed out');
    expect(outcomeText(check({ state: 'failed', outcome: 'FAILURE' }))).toBe('failed');
    expect(outcomeText(check({ state: 'pending', outcome: 'IN_PROGRESS' }))).toBe('running');
    expect(outcomeText(check({ state: 'pending', outcome: 'QUEUED' }))).toBe('queued');
    expect(duration(check({ startedAt: '2026-10-15T13:33:25Z', completedAt: '2026-10-15T13:34:37Z' }))).toBe('1m 12s');
    expect(duration(check({ startedAt: '2026-10-15T13:33:25Z' }), Date.parse('2026-10-15T13:33:35Z'))).toBe('10s');
    expect(duration(check({}))).toBe('');
  });
});

describe('parseJobLog', () => {
  const log = [
    '﻿2026-10-15T13:33:26.6289736Z ##[group]Run actions/checkout@v4',
    '2026-10-15T13:33:26.6302001Z with: repo',
    '2026-10-15T13:33:26.6302001Z ##[endgroup]',
    '2026-10-15T13:33:58.5031788Z ##[group]Run pnpm test',
    '2026-10-15T13:34:18.2232168Z \x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m',
    '2026-10-15T13:34:18.2313838Z ##[error]AssertionError: expected 1 to be 2',
    'continued without a timestamp',
    '2026-10-15T13:34:18.2741656Z ##[warning]Node 20 is deprecated',
    '2026-10-15T13:34:18.2741656Z ##[command]/usr/bin/git version',
    '',
    '',
  ].join('\r\n');
  it('drops timestamps, colours and group ends, and marks steps, errors and warnings', () => {
    expect(parseJobLog(log)).toEqual([
      { kind: 'step', text: 'Run actions/checkout@v4' },
      { kind: 'line', text: 'with: repo' },
      { kind: 'step', text: 'Run pnpm test' },
      { kind: 'line', text: ' Test Files  1 failed' },
      { kind: 'error', text: 'AssertionError: expected 1 to be 2' },
      { kind: 'line', text: 'continued without a timestamp' },
      { kind: 'warning', text: 'Node 20 is deprecated' },
      { kind: 'command', text: '/usr/bin/git version' },
    ]);
  });
  it('opens at the first error, or at the end of a log without one', () => {
    expect(logFocus(parseJobLog(log))).toBe(4);
    expect(logFocus(parseJobLog('a\nb\nc'))).toBe(2);
    expect(logFocus([])).toBe(-1);
  });
  it('removes OSC sequences whole', () => {
    expect(parseJobLog('see \x1b]8;;https://x\x07link\x1b]8;;\x07 here')[0].text).toBe('see link here');
  });
});
