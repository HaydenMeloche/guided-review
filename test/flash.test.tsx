import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from '../src/tui/themed.js';
import { useFlash, type Tone } from '../src/tui/flash.js';
import { waitFor } from './helpers/waitFor.js';

function Show(props: { text: string; tone?: Tone }) {
  const { flash, show } = useFlash();
  useEffect(() => show(props.text, props.tone), []); // eslint-disable-line react-hooks/exhaustive-deps
  return <Text>{flash ? `${flash.tone}: ${flash.text}` : 'none'}</Text>;
}

describe('useFlash', () => {
  it('fades info but holds warnings and errors until dismissed', async () => {
    const info = render(<Show text="Draft saved." tone="info" />);
    const warn = render(<Show text="No review thread on this line." />);
    const error = render(<Show text="Resolve failed: 502" />);
    await waitFor(() => expect(info.lastFrame()).toBe('info: Draft saved.'));
    await waitFor(() => expect(warn.lastFrame()).toBe('warn: No review thread on this line.'));
    await waitFor(() => expect(error.lastFrame()).toBe('error: Resolve failed: 502'));
    await waitFor(() => expect(info.lastFrame()).toBe('none'), { timeout: 5000, interval: 50 });
    expect(warn.lastFrame()).toBe('warn: No review thread on this line.');
    expect(error.lastFrame()).toBe('error: Resolve failed: 502');
  }, 10_000);
});
