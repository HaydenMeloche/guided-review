import React, { useState } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { TextInput, referenceTrigger, type Completer, type CompletionItem, type PreviewProps } from '../src/tui/TextInput.js';
import { fencedRows, fieldSegments, findCompletion, mentionCompleter, mentionHighlight, rowSegments, type TokenRule } from '../src/tui/completion.js';
import { CommentEditor } from '../src/tui/CommentEditor.js';
import type { Draft } from '../src/types.js';
import { waitFor } from './helpers/waitFor.js';

const UP = '\u001B[A';
const DOWN = '\u001B[B';
const LEFT = '\u001B[D';
const ESC = '\u001b';

const item = (name: string, onPick?: () => void): CompletionItem => ({ key: name, label: name, detail: `src/${name}.ts`, insert: `\`${name}\``, onPick });
const codeRefs = (names: string[], extra: Partial<Completer> = {}): Completer => ({
  trigger: referenceTrigger,
  items: (q) => names.filter((n) => n.startsWith(q)).map((n) => item(n)),
  hint: 'refs hint',
  ...extra,
});

function Harness(props: {
  initial?: string;
  completers?: Completer[];
  mentions?: string[];
  controlled?: boolean;
  onSubmit?: (v: string) => void;
  onCompleting?: (open: boolean) => void;
  highlightTokens?: TokenRule[];
  renderPreview?: (p: PreviewProps) => React.ReactNode;
  width?: number;
  listHeight?: number;
}) {
  const [value, setValue] = useState(props.initial ?? '');
  const [cursor, setCursor] = useState(props.initial?.length ?? 0);
  return (
    <>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={props.onSubmit}
        width={props.width ?? 60}
        listHeight={props.listHeight}
        completers={props.completers}
        mentions={props.mentions}
        onCompleting={props.onCompleting}
        highlightTokens={props.highlightTokens}
        renderPreview={props.renderPreview}
        {...(props.controlled ? { cursor, onCursor: setCursor } : {})}
      />
      <Text>{`value=[${value}] cursor=${props.controlled ? cursor : '-'}`}</Text>
    </>
  );
}

const SPAN: TokenRule[] = [{ kind: 'ref', pattern: /`[^`\s]+`/g }];

// Strips the field so assertions can read the value line alone.
const valueOf = (frame: string | undefined) => /value=\[([\s\S]*?)\] cursor=(\S+)/.exec(frame ?? '')?.slice(1) ?? [];

describe('TextInput completion', () => {
  it('opens no list on a token the cursor moves onto or starts after, until its text changes; ← and → belong to an open list', async () => {
    const ui = render(<Harness initial="see @rel and @res x" completers={[codeRefs(['releaseInventory', 'reserve'])]} controlled />);
    await waitFor(() => true);
    for (let i = 0; i < 2; i++) {
      ui.stdin.write(LEFT);
      await waitFor(() => true);
    }
    await waitFor(() => expect(valueOf(ui.lastFrame())[1]).toBe('17'));
    expect(ui.lastFrame()).not.toContain('▸ reserve');
    ui.stdin.write('e');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ reserve'));
    ui.stdin.write(LEFT);
    await waitFor(() => true);
    expect(valueOf(ui.lastFrame())).toEqual(['see @rel and @rese x', '18']);
    ui.unmount();
  });

  it('inserts at the end and leaves the cursor after the insertion', async () => {
    const ui = render(<Harness completers={[codeRefs(['releaseInventory', 'reserve'])]} controlled />);
    await waitFor(() => true);
    ui.stdin.write('see @rel');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ releaseInventory'));
    expect(ui.lastFrame()).toContain('refs hint');
    ui.stdin.write('\t');
    await waitFor(() => expect(valueOf(ui.lastFrame())).toEqual(['see `releaseInventory`', '22']));
    expect(ui.lastFrame()).not.toContain('refs hint');
    ui.unmount();
  });

  it('inserts at the start and in the middle, keeping the text after the cursor', async () => {
    const ui = render(<Harness initial=" tail" completers={[codeRefs(['alpha'])]} controlled />);
    await waitFor(() => true);
    ui.stdin.write('\u0001'); // Ctrl+A
    await waitFor(() => expect(valueOf(ui.lastFrame())[1]).toBe('0'));
    ui.stdin.write('@al');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ alpha'));
    ui.stdin.write('\t');
    await waitFor(() => expect(valueOf(ui.lastFrame())).toEqual(['`alpha` tail', '7']));

    ui.stdin.write(' x (@a');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ alpha'));
    ui.stdin.write('\r');
    await waitFor(() => expect(valueOf(ui.lastFrame())).toEqual(['`alpha` x (`alpha` tail', '18']));
    ui.unmount();
  });

  it('works with an uncontrolled cursor', async () => {
    const ui = render(<Harness initial="ab" completers={[codeRefs(['alpha'])]} />);
    await waitFor(() => true);
    ui.stdin.write(LEFT);
    await waitFor(() => true);
    ui.stdin.write(' @');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ alpha'));
    ui.stdin.write('\t');
    await waitFor(() => expect(valueOf(ui.lastFrame())[0]).toBe('a `alpha`b'));
    ui.stdin.write('!');
    await waitFor(() => expect(valueOf(ui.lastFrame())[0]).toBe('a `alpha`!b'));
    ui.unmount();
  });

  it('takes the cursor from the parent and reports moves', async () => {
    function Parent() {
      const [value, setValue] = useState('hello world');
      const [cursor, setCursor] = useState(5);
      const [active, setActive] = useState(true);
      return (
        <>
          <TextInput value={value} onChange={setValue} width={40} cursor={cursor} onCursor={setCursor} active={active} onSubmit={() => setActive(false)} />
          {active ? null : <TextInput value="" onChange={() => {}} width={10} onSubmit={() => setActive(true)} />}
          <Text>{`value=[${value}] cursor=${cursor} ${active ? 'editing' : 'away'}`}</Text>
        </>
      );
    }
    const ui = render(<Parent />);
    await waitFor(() => true);
    ui.stdin.write(',');
    await waitFor(() => expect(valueOf(ui.lastFrame())).toEqual(['hello, world', '6']));
    ui.stdin.write(LEFT);
    await waitFor(() => expect(valueOf(ui.lastFrame())[1]).toBe('5'));
    // Leave and come back: the cursor stays where the parent kept it.
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('away'));
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('editing'));
    ui.stdin.write('X');
    await waitFor(() => expect(valueOf(ui.lastFrame())).toEqual(['helloX, world', '6']));
    ui.unmount();
  });

  it('moves the selection with up and down and inserts the chosen row', async () => {
    const pick = vi.fn();
    const completer: Completer = { trigger: referenceTrigger, items: () => [item('one'), item('two', pick), item('three')] };
    const ui = render(<Harness completers={[completer]} />);
    await waitFor(() => true);
    ui.stdin.write('@');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ one'));
    ui.stdin.write(DOWN);
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ two'));
    ui.stdin.write(DOWN);
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ three'));
    ui.stdin.write(DOWN); // stays on the last row
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ three'));
    ui.stdin.write(UP);
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ two'));
    ui.stdin.write('\r');
    await waitFor(() => expect(valueOf(ui.lastFrame())[0]).toBe('`two`'));
    expect(pick).toHaveBeenCalledOnce();
    ui.unmount();
  });

  it('shows at most six rows and scrolls to keep the selection visible', async () => {
    const names = Array.from({ length: 9 }, (_, i) => `n${i}`);
    const ui = render(<Harness completers={[codeRefs(names)]} />);
    await waitFor(() => true);
    ui.stdin.write('@n');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ n0'));
    expect(ui.lastFrame()).toContain('n5');
    expect(ui.lastFrame()).not.toContain('n6');
    for (let i = 1; i <= 7; i++) {
      ui.stdin.write(DOWN);
      await waitFor(() => expect(ui.lastFrame()).toContain(`▸ n${i}`));
    }
    expect(ui.lastFrame()).not.toContain('n1 ');
    ui.unmount();
  });

  it('Enter inserts instead of submitting while the list is open, then submits', async () => {
    const onSubmit = vi.fn();
    const ui = render(<Harness completers={[codeRefs(['alpha'])]} onSubmit={onSubmit} />);
    await waitFor(() => true);
    ui.stdin.write('@a');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ alpha'));
    ui.stdin.write('\r');
    await waitFor(() => expect(valueOf(ui.lastFrame())[0]).toBe('`alpha`'));
    expect(onSubmit).not.toHaveBeenCalled();
    ui.stdin.write(' ok');
    await waitFor(() => expect(valueOf(ui.lastFrame())[0]).toBe('`alpha` ok'));
    ui.stdin.write('\r');
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('`alpha` ok'));
    ui.unmount();
  });

  it('Esc closes only the list, and it stays closed for that token', async () => {
    const onCompleting = vi.fn();
    const onSubmit = vi.fn();
    const ui = render(<Harness completers={[codeRefs(['alpha', 'alps'])]} onCompleting={onCompleting} onSubmit={onSubmit} />);
    await waitFor(() => true);
    ui.stdin.write('@al');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ alpha'));
    expect(onCompleting).toHaveBeenLastCalledWith(true);
    ui.stdin.write(ESC);
    await waitFor(() => expect(ui.lastFrame()).not.toContain('alpha'));
    expect(onCompleting).toHaveBeenLastCalledWith(false);
    ui.stdin.write('p');
    await waitFor(() => expect(valueOf(ui.lastFrame())[0]).toBe('@alp'));
    expect(ui.lastFrame()).not.toContain('alps');
    ui.stdin.write('\r');
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('@alp'));
    ui.unmount();
  });

  it('debounces an async completer and drops stale results', async () => {
    const resolvers = new Map<string, (items: CompletionItem[]) => void>();
    const calls: string[] = [];
    const completer: Completer = {
      trigger: referenceTrigger,
      items: (q) => {
        calls.push(q);
        return new Promise((resolve) => resolvers.set(q, resolve));
      },
    };
    const ui = render(<Harness completers={[completer]} />);
    await waitFor(() => true);
    ui.stdin.write('@r');
    await waitFor(() => expect(ui.lastFrame()).toContain('searching…'));
    expect(calls).toEqual(['r']);
    // Fast typing: only the last query is asked for once typing pauses.
    ui.stdin.write('e');
    await waitFor(() => expect(valueOf(ui.lastFrame())[0]).toBe('@re'));
    ui.stdin.write('l');
    await waitFor(() => expect(calls).toEqual(['r', 'rel']));
    resolvers.get('rel')!([item('release')]);
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ release'));
    expect(ui.lastFrame()).not.toContain('searching…');
    // The answer for "r" arrives late and must not replace the list.
    resolvers.get('r')!([item('reserve')]);
    await new Promise((r) => setTimeout(r, 20));
    expect(ui.lastFrame()).toContain('▸ release');
    expect(ui.lastFrame()).not.toContain('reserve');
    ui.unmount();
  });

  it('sanitizes item text', async () => {
    const completer: Completer = { trigger: referenceTrigger, items: () => [{ key: 'x', label: 'evil\u001b]52;c;aGk=\u0007name', detail: 'd\u009b2J', insert: '`x`' }] };
    const ui = render(<Harness completers={[completer]} />);
    await waitFor(() => true);
    ui.stdin.write('@');
    await waitFor(() => expect(ui.lastFrame()).toContain('evil]52;c;aGk=name'));
    expect(ui.lastFrame()).not.toMatch(/\u001b\]52|\u009b/);
    ui.unmount();
  });

  it('cuts rows into token and cursor runs', () => {
    const plain = (row: string) => rowSegments(row, SPAN).map((g) => `${g.cursor ? '|' : ''}${g.token ? '{' : ''}${g.text}${g.token ? '}' : ''}`);
    expect(plain('see `alpha` and `beta`')).toEqual(['see ', '{`alpha`}', ' and ', '{`beta`}']);
    expect(plain('see `al\u0000pha`!')).toEqual(['see ', '{`al}', '|{p}', '{ha`}', '!']);
    expect(plain('\u0000`x`')).toEqual(['|{`}', '{x`}']);
    expect(plain('`x`\u0000')).toEqual(['{`x`}', '| ']);
    expect(plain('no tokens')).toEqual(['no tokens']);
    expect(rowSegments('ab\u0000c').map((g) => [g.text, g.cursor])).toEqual([
      ['ab', false],
      ['c', true],
    ]);
  });

  it('marks known mentions and reference spans as their own kinds, never in code or an email', () => {
    const rules = [...SPAN, mentionHighlight(['alice', 'bob', 'acme/core'])!];
    const kinds = (row: string) => rowSegments(row, rules).map((g) => `${g.cursor ? '|' : ''}${g.token ? `${g.token}{` : ''}${g.text}${g.token ? '}' : ''}`);
    expect(kinds('hi @Alice, see `two()` (@bob)')).toEqual(['hi ', 'mention{@Alice}', ', see ', 'ref{`two()`}', ' (', 'mention{@bob}', ')']);
    expect(kinds('@carol and foo@alice and @alice-x and @alicex')).toEqual(['@carol and foo@alice and @alice-x and @alicex']);
    expect(kinds('ask @acme/core or @acme/other')).toEqual(['ask ', 'mention{@acme/core}', ' or @acme/other']);
    const mentionOnly = (row: string) => rowSegments(row, [rules[1]]).filter((g) => g.token);
    expect(mentionOnly('not `@alice here` nor ``@bob`` nor `x` @bob')).toEqual([expect.objectContaining({ text: '@bob', token: 'mention' })]);
    expect(kinds('@al\u0000ice')).toEqual(['mention{@al}', '|mention{i}', 'mention{ce}']);
    expect(mentionHighlight([])).toBeUndefined();
  });

  it('marks nothing in a fenced block', () => {
    const rules = [...SPAN, mentionHighlight(['alice'])!];
    const marked = fieldSegments(['hi @alice `x`', '```', '@alice `x`', '```', '@alice'], rules).map((row) => row.filter((g) => g.token).map((g) => g.token));
    expect(marked).toEqual([['mention', 'ref'], [], [], [], ['mention']]);
  });

  it('keeps the text with the cursor in a mention', async () => {
    const rules = [mentionHighlight(['alice'])!];
    const ui = render(<Harness initial={'hi @alice\n```\n@alice\n```'} highlightTokens={rules} controlled />);
    await waitFor(() => expect(ui.lastFrame()).toContain('hi @alice'));
    const frame = ui.lastFrame()!;
    expect(frame).toContain('@alice');
    for (let i = 23; i >= 6; i--) {
      ui.stdin.write(LEFT);
      await waitFor(() => expect(valueOf(ui.lastFrame())[1]).toBe(String(i)));
    }
    expect(ui.lastFrame()).toContain('hi @alice');
    ui.unmount();
  });

  it('renders highlighted text unchanged', async () => {
    const ui = render(<Harness initial="see `alpha` and `beta`" highlightTokens={SPAN} controlled />);
    await waitFor(() => expect(ui.lastFrame()).toContain('see `alpha` and `beta`'));
    for (let i = 21; i >= 18; i--) {
      ui.stdin.write(LEFT);
      await waitFor(() => expect(valueOf(ui.lastFrame())[1]).toBe(String(i)));
    }
    expect(ui.lastFrame()).toContain('see `alpha` and `beta`');
    ui.unmount();
  });

  it('marks no code span inside a fenced block', () => {
    expect(fencedRows(['`alpha`', '```ts', '`al\u0000pha`', '  ```', '`alpha`'])).toEqual([false, true, true, true, false]);
  });
});

describe('mention completion', () => {
  it('Tab completes the first match with a trailing space', async () => {
    const ui = render(<Harness mentions={['alice', 'alex', 'bob', 'alice']} />);
    await waitFor(() => true);
    ui.stdin.write('cc @al');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ @alice'));
    expect(ui.lastFrame()).toContain('@alex');
    expect(ui.lastFrame()).not.toContain('@bob');
    expect(ui.lastFrame()!.match(/@alice/g)).toHaveLength(1);
    ui.stdin.write('\t');
    await waitFor(() => expect(valueOf(ui.lastFrame())[0]).toBe('cc @alice '));
    ui.unmount();
  });

  it('Tab still reaches onTab when no mention matches', async () => {
    const onTab = vi.fn();
    const ui = render(<TextInput value="hi @zed" onChange={() => {}} width={40} mentions={['alice']} onTab={onTab} />);
    await waitFor(() => true);
    ui.stdin.write('\t');
    await waitFor(() => expect(onTab).toHaveBeenCalledWith(false));
    ui.unmount();
  });

  it('@@ never opens the mention list', async () => {
    const ui = render(<Harness mentions={['alice']} />);
    await waitFor(() => true);
    ui.stdin.write('see @');
    await waitFor(() => expect(ui.lastFrame()).toContain('@alice'));
    ui.stdin.write('@');
    await waitFor(() => expect(valueOf(ui.lastFrame())[0]).toBe('see @@'));
    expect(ui.lastFrame()).not.toContain('@alice');
    ui.stdin.write('a');
    await waitFor(() => expect(valueOf(ui.lastFrame())[0]).toBe('see @@a'));
    expect(ui.lastFrame()).not.toContain('@alice');
    ui.unmount();
  });

  it('a mention-only field takes usernames, not paths or filters, after a boundary', () => {
    const completers = [mentionCompleter(['alice'])];
    expect(findCompletion(completers, 'x @al')).toEqual({ index: 0, start: 2, query: 'al' });
    expect(findCompletion(completers, '(@')).toEqual({ index: 0, start: 1, query: '' });
    expect(findCompletion(completers, 'x @src/a.ts')).toBeUndefined();
    expect(findCompletion(completers, 'x @f:')).toBeUndefined();
    expect(findCompletion(completers, 'foo@bar')).toBeUndefined();
  });

  it('@ followed by a space closes the list, and an email or diff header never opens it', async () => {
    const ui = render(<Harness completers={[codeRefs(['alpha'])]} />);
    await waitFor(() => true);
    ui.stdin.write('@');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ alpha'));
    ui.stdin.write(' ');
    await waitFor(() => expect(valueOf(ui.lastFrame())[0]).toBe('@ '));
    expect(ui.lastFrame()).not.toContain('alpha');
    ui.stdin.write('foo@');
    await waitFor(() => expect(valueOf(ui.lastFrame())[0]).toBe('@ foo@'));
    await new Promise((r) => setTimeout(r, 20));
    expect(ui.lastFrame()).not.toContain('alpha');
    expect(referenceTrigger.test('@@ -38,6 +38,9 @@')).toBe(false);
    expect(referenceTrigger.test('x @@')).toBe(false);
    // A sentence ending in a mention closes the list; typing past the dot reopens it.
    expect(referenceTrigger.test('thanks @alice.')).toBe(false);
    expect(referenceTrigger.exec('see @stock.t')?.[2]).toBe('stock.t');
    expect(referenceTrigger.exec('see @f:')?.[2]).toBe('f:');
    ui.unmount();
  });

  it('a pasted diff header does not open the list', async () => {
    const ui = render(<Harness completers={[codeRefs(['alpha'])]} />);
    await waitFor(() => true);
    ui.stdin.write('\u001b[200~@@ -38,6 +38,9 @@\u001b[201~');
    await waitFor(() => expect(valueOf(ui.lastFrame())[0]).toBe('@@ -38,6 +38,9 @@'));
    await new Promise((r) => setTimeout(r, 20));
    expect(ui.lastFrame()).not.toContain('alpha');
    ui.unmount();
  });
});

describe('a list of people and code', () => {
  const person = (name: string): CompletionItem => ({ key: `@${name}`, label: `@${name}`, insert: `@${name} `, group: 'People' });
  const code = (name: string): CompletionItem => ({ ...item(name), group: 'Code', preview: { path: `src/${name}.ts` } });
  // People answer at once; code waits on `release` so a test can hold it back.
  const mixed = (people: string[]) => {
    let release: (items: CompletionItem[]) => void = () => {};
    const completer: Completer = {
      trigger: referenceTrigger,
      pendingGroup: 'Code',
      instant: (q) => (/^[\w-]*$/.test(q) ? people.filter((p) => p.startsWith(q)).map(person) : []),
      items: () => new Promise((resolve) => (release = resolve)),
    };
    return { completer, release: (items: CompletionItem[]) => release(items) };
  };
  const preview = (p: PreviewProps) => <Text>{`PREVIEW ${p.path}`}</Text>;
  const lines = (frame: string | undefined) => (frame ?? '').split('\n').map((l) => l.trim());

  it('shows people before code arrives, then code under its own header, and the selection skips headers', async () => {
    const { completer, release } = mixed(['alice', 'albert']);
    const ui = render(<Harness completers={[completer]} renderPreview={preview} />);
    await waitFor(() => true);
    ui.stdin.write('@al');
    await waitFor(() => expect(ui.lastFrame()).toContain('searching…'));
    expect(lines(ui.lastFrame()).slice(1, 6)).toEqual(['People', '▸ @alice', '@albert', 'Code', 'searching…']);
    release([code('alpha'), code('alps')]);
    await waitFor(() => expect(ui.lastFrame()).toContain('alpha'));
    expect(ui.lastFrame()).not.toContain('searching…');
    const rows = lines(ui.lastFrame());
    expect(rows.indexOf('People')).toBeLessThan(rows.indexOf('▸ @alice'));
    expect(rows.findIndex((r) => r.startsWith('Code'))).toBeGreaterThan(rows.indexOf('@albert'));
    ui.stdin.write(UP); // stays on the first row
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ @alice'));
    ui.stdin.write(DOWN);
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ @albert'));
    ui.stdin.write(DOWN);
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ alpha'));
    ui.stdin.write('\t');
    await waitFor(() => expect(valueOf(ui.lastFrame())[0]).toBe('`alpha`'));
    ui.unmount();
  });

  it('a lines pick never runs the highlighted row’s own pick, such as a range already referenced', async () => {
    const rowPick = vi.fn();
    const linesPick = vi.fn();
    const make = (onPick?: () => void) => {
      let release: (items: CompletionItem[]) => void = () => {};
      const completer: Completer = {
        trigger: referenceTrigger,
        items: () => new Promise((resolve) => (release = resolve)),
        lineCount: () => 10,
        // A range the draft already references comes back without an onPick of its own.
        pickLines: (_it, s, e) => ({ insert: `\`alpha.ts:${s}-${e}\` `, ...(onPick ? { onPick } : {}) }),
      };
      return { completer, release: (items: CompletionItem[]) => release(items) };
    };
    for (const [onPick, calls] of [
      [undefined, 0],
      [linesPick, 1],
    ] as const) {
      const { completer, release } = make(onPick);
      const ui = render(<Harness completers={[completer]} renderPreview={preview} />);
      await waitFor(() => true);
      ui.stdin.write('@al');
      await waitFor(() => true);
      release([{ ...code('alpha'), onPick: rowPick }]);
      await waitFor(() => expect(ui.lastFrame()).toContain('▸ alpha'));
      ui.stdin.write('\u001b[C');
      await new Promise((r) => setTimeout(r, 20));
      ui.stdin.write('\r');
      await waitFor(() => expect(valueOf(ui.lastFrame())[0]).toBe('`alpha.ts:1-1` '));
      expect(rowPick).not.toHaveBeenCalled();
      expect(linesPick).toHaveBeenCalledTimes(calls);
      ui.unmount();
    }
  });

  it('previews only a code row', async () => {
    const { completer, release } = mixed(['alice']);
    const ui = render(<Harness completers={[completer]} renderPreview={preview} />);
    await waitFor(() => true);
    ui.stdin.write('@');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ @alice'));
    release([code('alpha')]);
    await waitFor(() => expect(ui.lastFrame()).toContain('alpha'));
    expect(ui.lastFrame()).not.toContain('PREVIEW');
    ui.stdin.write(DOWN);
    await waitFor(() => expect(ui.lastFrame()).toContain('PREVIEW src/alpha.ts'));
    ui.stdin.write(UP);
    await waitFor(() => expect(ui.lastFrame()).not.toContain('PREVIEW'));
    ui.stdin.write('\r');
    await waitFor(() => expect(valueOf(ui.lastFrame())[0]).toBe('@alice '));
    ui.unmount();
  });

  it('gives the preview the rows its owner allows, beside or under the list', async () => {
    const sized = (p: PreviewProps) => <Text>{`PREVIEW h=${p.height}`}</Text>;
    const withPreview: Completer = { trigger: referenceTrigger, items: () => [{ ...item('alpha'), preview: { path: 'src/alpha.ts' } }] };
    const heightFor = async (props: { width: number; listHeight?: number }) => {
      const ui = render(<Harness completers={[withPreview]} renderPreview={sized} {...props} />);
      await waitFor(() => true);
      ui.stdin.write('@al');
      await waitFor(() => expect(ui.lastFrame()).toContain('PREVIEW h='));
      const h = Number(/PREVIEW h=(\d+)/.exec(ui.lastFrame()!)![1]);
      ui.unmount();
      return h;
    };
    expect(await heightFor({ width: 100 })).toBe(7); // the list's rows plus one, as before
    expect(await heightFor({ width: 100, listHeight: 24 })).toBe(23); // all but the hint line
    expect(await heightFor({ width: 60 })).toBe(5);
    expect(await heightFor({ width: 60, listHeight: 24 })).toBe(17); // under the six list rows
  });

  it('a keepOpen row replaces the query and leaves the list open on the new one', async () => {
    const onPick = vi.fn();
    const completer: Completer = {
      trigger: referenceTrigger,
      items: (q) => (q === 'th' ? [{ key: 'f', label: 'threads:', insert: '@threads:', keepOpen: true, onPick }] : q === 'threads:' ? [item('thread1')] : []),
    };
    const ui = render(<Harness completers={[completer]} />);
    await waitFor(() => true);
    ui.stdin.write('see @th');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ threads:'));
    ui.stdin.write('\t');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ thread1'));
    expect(valueOf(ui.lastFrame())[0]).toBe('see @threads:');
    expect(onPick).toHaveBeenCalledOnce();
    ui.stdin.write('\r');
    await waitFor(() => expect(valueOf(ui.lastFrame())[0]).toBe('see `thread1`'));
    ui.unmount();
  });

  it('draws two hint lines, the second styled and cut to the width, and gives the list a row for it', async () => {
    const names = Array.from({ length: 9 }, (_, i) => `n${i}`);
    const help = [{ text: 'narrow with  ' }, { text: 'callers:', accent: true }, { text: ' ' + 'x'.repeat(80) }];
    const ui = render(<Harness completers={[codeRefs(names, { hint: (_it, q) => ({ actions: `acts for ${q}`, help }) })]} />);
    await waitFor(() => true);
    ui.stdin.write('@n');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ n0'));
    const rows = lines(ui.lastFrame());
    expect(rows).toContain('acts for n');
    const second = rows.find((r) => r.startsWith('narrow with  callers:'))!;
    expect(second.length).toBeLessThanOrEqual(60);
    expect(ui.lastFrame()).toContain('n4');
    expect(ui.lastFrame()).not.toContain('n5');
    ui.unmount();
  });

  it('shows a row’s text preview as it is, sanitized, with no lines to pick', async () => {
    const pickLines = vi.fn();
    const completer: Completer = {
      trigger: referenceTrigger,
      items: () => [{ key: 't', label: '¶ thread', insert: '`t`', preview: { path: 'src/a.ts:3', text: '@al: why\u001b[2J twice?' } }],
      lineCount: () => 10,
      pickLines,
    };
    const ui = render(<Harness completers={[completer]} renderPreview={preview} />);
    await waitFor(() => true);
    ui.stdin.write('@');
    await waitFor(() => expect(ui.lastFrame()).toContain('@al: why[2J twice?'));
    expect(ui.lastFrame()).not.toContain('PREVIEW');
    expect(ui.lastFrame()).not.toContain('\u001b');
    ui.stdin.write('\u001b[C');
    await new Promise((r) => setTimeout(r, 20));
    expect(ui.lastFrame()).not.toContain('enter insert lines');
    ui.unmount();
  });

  it('lists no people for a filter or a path', async () => {
    const { completer, release } = mixed(['f', 'src']);
    const ui = render(<Harness completers={[completer]} />);
    await waitFor(() => true);
    ui.stdin.write('@f:');
    await waitFor(() => expect(ui.lastFrame()).toContain('searching…'));
    expect(ui.lastFrame()).not.toContain('People');
    release([code('alpha')]);
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ alpha'));
    expect(ui.lastFrame()).not.toContain('People');
    ui.unmount();
  });
});

describe('CommentEditor with a completion list', () => {
  const draft: Draft = {
    id: 'd1',
    repo: 'o/r',
    pr: 1,
    headSha: 'abc',
    anchor: { type: 'chapter', chapterId: 'c1' },
    label: 'question',
    body: '',
    posted: false,
    createdAt: '2026-01-01T00:00:00Z',
  };

  it('Esc closes the list first, then asks, and discards the typed draft only on the third press', async () => {
    const onCancel = vi.fn();
    const onSave = vi.fn();
    const ui = render(<CommentEditor draft={draft} target="chapter" width={60} mentions={['alice']} onSave={onSave} onCancel={onCancel} />);
    await waitFor(() => true);
    ui.stdin.write('ask @al');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ @alice'));
    ui.stdin.write(ESC);
    await waitFor(() => expect(ui.lastFrame()).not.toContain('▸ @alice'));
    expect(onCancel).not.toHaveBeenCalled();
    expect(ui.lastFrame()).toContain('ask @al');
    ui.stdin.write(ESC);
    await waitFor(() => expect(ui.lastFrame()).toContain('esc again to discard · enter to save'));
    expect(onCancel).not.toHaveBeenCalled();
    ui.stdin.write(ESC);
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
    ui.unmount();
  });

  it('Enter completes a mention instead of saving', async () => {
    const onSave = vi.fn();
    const ui = render(<CommentEditor draft={draft} target="chapter" width={60} mentions={['alice']} onSave={onSave} onCancel={() => {}} />);
    await waitFor(() => true);
    ui.stdin.write('ask @al');
    await waitFor(() => expect(ui.lastFrame()).toContain('▸ @alice'));
    ui.stdin.write('\r');
    await waitFor(() => expect(ui.lastFrame()).toContain('ask @alice'));
    expect(onSave).not.toHaveBeenCalled();
    ui.stdin.write('\r');
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ body: 'ask @alice' })));
    ui.unmount();
  });
});
