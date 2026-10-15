import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ReviewPopup } from '../src/tui/ReviewPopup.js';
import { SubmitScreen } from '../src/tui/SubmitScreen.js';
import { hunk, tour } from './fixtures/tour.js';
import { waitFor } from './helpers/waitFor.js';

describe('review popup', () => {
  it('keeps the review visible around an opaque centered dialog', () => {
    const ui = render(
      <ReviewPopup
        width={40}
        height={12}
        maxWidth={20}
        maxHeight={6}
        background={
          <Box flexDirection="column" width={40} height={12}>
            <Text>Review heading</Text>
            {Array.from({ length: 11 }, (_, i) => (
              <Text key={i}>{'background'.repeat(4)}</Text>
            ))}
          </Box>
        }
      >
        {(width) => <Text>{`Submit ${width}`}</Text>}
      </ReviewPopup>,
    );
    const rows = ui.lastFrame()!.split('\n');
    expect(rows[0]).toContain('Review heading');
    expect(rows.some((row) => row.includes('Submit 18'))).toBe(true);
    expect(rows.some((row) => row.includes('╭') && row.includes('╮'))).toBe(true);
    const dialogRow = rows.find((row) => row.includes('Submit 18'))!;
    expect(dialogRow.slice(dialogRow.indexOf('│') + 1, dialogRow.lastIndexOf('│'))).not.toContain('background');
    ui.unmount();
  });

  it('preserves background view state while the dialog opens and closes', async () => {
    function Background(props: { active: boolean; open: () => void }) {
      const [line, setLine] = useState(1);
      useInput(
        (input) => {
          if (input === 'j') setLine((value) => value + 1);
          if (input === 's') props.open();
        },
        { isActive: props.active },
      );
      return <Text>Selected line {line}</Text>;
    }
    function Harness() {
      const [open, setOpen] = useState(false);
      useInput(
        (_input, key) => {
          if (key.escape) setOpen(false);
        },
        { isActive: open },
      );
      return (
        <ReviewPopup width={60} height={16} maxWidth={30} maxHeight={8} background={<Background active={!open} open={() => setOpen(true)} />}>
          {open ? () => <Text>Submit review</Text> : undefined}
        </ReviewPopup>
      );
    }
    const ui = render(<Harness />);
    await waitFor(() => true); // let the background's input handler attach
    ui.stdin.write('j');
    await waitFor(() => expect(ui.lastFrame()).toContain('Selected line 2'));
    ui.stdin.write('s');
    await waitFor(() => expect(ui.lastFrame()).toContain('Submit review'));
    // The background is inactive while the dialog is open, so this j must change nothing.
    // Close the dialog next and check the line afterwards: a leaked j would show as line 3.
    ui.stdin.write('j');
    ui.stdin.write('\u001b');
    await waitFor(() => expect(ui.lastFrame()).not.toContain('Submit review'));
    expect(ui.lastFrame()).toContain('Selected line 2');
    ui.unmount();
  });
});

describe('submit dialog', () => {
  it('keeps posting controls visible in a standard terminal', async () => {
    const change = hunk('h1', 'src/item.ts', [{ kind: 'add', text: 'const item = 1;', newLine: 1 }]);
    const review = tour([change], [{ hunkIds: ['h1'] }]);
    const ui = render(
      <ReviewPopup
        width={80}
        height={20}
        maxWidth={104}
        maxHeight={34}
        background={
          <Box width={80} height={20}>
            <Text>Review heading</Text>
          </Box>
        }
      >
        {(width, height) => (
          <SubmitScreen tour={review} chapters={review.chapters} states={{}} drafts={[]} width={width} height={height} onEdit={() => {}} onDelete={() => {}} onPosted={() => {}} onBack={() => {}} />
        )}
      </ReviewPopup>,
    );
    expect(ui.lastFrame()).toContain('Review heading');
    expect(ui.lastFrame()).toContain('Submit review');
    expect(ui.lastFrame()).toMatch(/P\s+post/);
    ui.stdin.write('P');
    await waitFor(() => expect(ui.lastFrame()).toContain('Y / n'));
    ui.unmount();
  });
});
