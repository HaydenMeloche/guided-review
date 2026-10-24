import type { MdLine } from './markdown.js';
import { riskMark, stateMark } from './nav.js';
import { COVERAGE } from './chapter/parts.js';
import { G } from './glyphs.js';

// The marks the review screens use, explained: the help's second page. Built from the same
// functions that draw them, so the legend can't drift from the screen.
export function reviewLegend(): MdLine[] {
  const mark = (m: { mark: string; color: string }, text: string): MdLine => [{ text: m.mark, color: m.color }, { text: ` ${text}   ` }];
  const row = (label: string, ...items: MdLine[]): MdLine => [{ text: label.padEnd(11), dim: true, bold: true }, ...items.flat()];
  return [
    row('Reading', mark(stateMark('read'), 'read'), mark(stateMark('skipped'), 'skipped'), mark(stateMark('deferred'), 'deferred'), mark(stateMark('unread'), 'unread')),
    row('Risk', mark(riskMark(3), 'high'), mark(riskMark(2), 'medium'), mark(riskMark(1), 'low')),
    row('Tests', mark(COVERAGE.tested, 'tested'), mark(COVERAGE.partial, 'partly tested'), mark(COVERAGE.untested, 'untested')),
    [],
    row('On a line', mark({ mark: G.draft, color: 'cyan' }, 'your draft'), mark({ mark: G.thread, color: 'cyan' }, 'review thread'), mark({ mark: G.moved, color: 'magenta' }, 'moved code')),
    row('', mark({ mark: G.cursor, color: 'cyan' }, 'cursor'), mark({ mark: G.range, color: 'blue' }, 'range')),
    row('Hunks', [{ text: 'NEW', color: 'yellow', bold: true }, { text: ' changed since your last review' }]),
  ];
}
