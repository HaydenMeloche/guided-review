import React from 'react';
import { EventEmitter } from 'node:events';
import { render, Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { progressSequence, supportsProgress, titleSequence, useTerminalStatus, type TerminalProgress } from '../src/tui/terminalStatus.js';

// A stdout Ink renders to, recording only the title and progress sequences it receives.
function fakeTerminal(isTTY: boolean) {
  const out = Object.assign(new EventEmitter(), {
    isTTY,
    columns: 80,
    rows: 24,
    writes: [] as string[],
    write(s: string) {
      out.writes.push(...(s.match(/\u001b\][09];[^\u0007]*\u0007|\u001b\[2[23];0t/g) ?? []));
      return true;
    },
  });
  return out;
}

function Status(props: { title: string; progress: TerminalProgress; env: NodeJS.ProcessEnv; onRewrite?: (rewrite: () => void) => void }) {
  const rewrite = useTerminalStatus(props.title, props.progress, props.env);
  props.onRewrite?.(rewrite);
  return <Text>tour</Text>;
}

const ghostty = { TERM_PROGRAM: 'ghostty' };

describe('terminal status sequences', () => {
  it('sanitizes the title so a repo name cannot inject sequences', () => {
    expect(titleSequence('gr · acme/app#42')).toBe('\u001b]0;gr · acme/app#42\u0007');
    expect(titleSequence('evil\u0007\u001b]52;c;eA==')).toBe('\u001b]0;evil]52;c;eA==\u0007');
  });

  it('writes OSC 9;4 states, clamping and rounding the percentage', () => {
    expect(progressSequence({ state: 'value', percent: 42.6 })).toBe('\u001b]9;4;1;43\u0007');
    expect(progressSequence({ state: 'value', percent: 140 })).toBe('\u001b]9;4;1;100\u0007');
    expect(progressSequence({ state: 'busy' })).toBe('\u001b]9;4;3;0\u0007');
    expect(progressSequence({ state: 'error' })).toBe('\u001b]9;4;2;0\u0007');
    expect(progressSequence({ state: 'none' })).toBe('\u001b]9;4;0;0\u0007');
  });

  it('sends progress only to terminals that read OSC 9;4 rather than notify on it', () => {
    expect(supportsProgress(ghostty)).toBe(true);
    expect(supportsProgress({ TERM_PROGRAM: 'WezTerm' })).toBe(true);
    expect(supportsProgress({ WT_SESSION: 'abc' })).toBe(true);
    expect(supportsProgress({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.2' })).toBe(true);
    expect(supportsProgress({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.14' })).toBe(false);
    expect(supportsProgress({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(false);
    expect(supportsProgress({ TERM_PROGRAM: 'tmux' })).toBe(false);
    // GNU screen leaves the outer terminal's TERM_PROGRAM in place.
    expect(supportsProgress({ TERM_PROGRAM: 'ghostty', STY: '1234.pts-0.host' })).toBe(false);
    expect(supportsProgress({ TERM_PROGRAM: 'ghostty', TERM: 'screen-256color' })).toBe(false);
    expect(supportsProgress({})).toBe(false);
  });
});

describe('useTerminalStatus', () => {
  it('saves the title, follows changes, then restores it and clears progress on exit', () => {
    const stdout = fakeTerminal(true);
    const app = render(<Status title="gr · reviews" progress={{ state: 'busy' }} env={ghostty} />, { stdout: stdout as never, patchConsole: false });
    app.rerender(<Status title="gr · acme/app#42 · briefing" progress={{ state: 'value', percent: 50 }} env={ghostty} />);
    // Same state and percent: nothing new is written.
    app.rerender(<Status title="gr · acme/app#42 · briefing" progress={{ state: 'value', percent: 50.2 }} env={ghostty} />);
    app.unmount();
    expect(stdout.writes).toEqual([
      '\u001b[22;0t',
      '\u001b]0;gr · reviews\u0007',
      '\u001b]9;4;3;0\u0007',
      '\u001b]0;gr · acme/app#42 · briefing\u0007',
      '\u001b]9;4;1;50\u0007',
      '\u001b[23;0t',
      '\u001b]9;4;0;0\u0007',
    ]);
  });

  it('writes the title and progress again on request, after another program had the terminal', () => {
    const stdout = fakeTerminal(true);
    let rewrite = () => {};
    const app = render(<Status title="gr · acme/app#42 · chapter 2/5" progress={{ state: 'value', percent: 40 }} env={ghostty} onRewrite={(r) => (rewrite = r)} />, {
      stdout: stdout as never,
      patchConsole: false,
    });
    stdout.writes.length = 0;
    rewrite();
    expect(stdout.writes).toEqual(['\u001b]0;gr · acme/app#42 · chapter 2/5\u0007', '\u001b]9;4;1;40\u0007']);
    app.unmount();
  });

  it('sets the title but no progress in a terminal that does not support it', () => {
    const stdout = fakeTerminal(true);
    const app = render(<Status title="gr · reviews" progress={{ state: 'busy' }} env={{ TERM_PROGRAM: 'Apple_Terminal' }} />, { stdout: stdout as never, patchConsole: false });
    app.unmount();
    expect(stdout.writes).toEqual(['\u001b[22;0t', '\u001b]0;gr · reviews\u0007', '\u001b[23;0t']);
  });

  it('writes nothing when stdout is not a terminal', () => {
    const stdout = fakeTerminal(false);
    const app = render(<Status title="gr · reviews" progress={{ state: 'busy' }} env={ghostty} />, { stdout: stdout as never, patchConsole: false });
    app.unmount();
    expect(stdout.writes).toEqual([]);
  });
});
