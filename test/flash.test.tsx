import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from '../src/tui/themed.js';
import { useFlash, type Tone } from '../src/tui/flash.js';

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
    await new Promise((r) => setTimeout(r, 50));
    expect(info.lastFrame()).toBe('info: Draft saved.');
    expect(warn.lastFrame()).toBe('warn: No review thread on this line.');
    expect(error.lastFrame()).toBe('error: Resolve failed: 502');
    await new Promise((r) => setTimeout(r, 2600));
    expect(info.lastFrame()).toBe('none');
    expect(warn.lastFrame()).toBe('warn: No review thread on this line.');
    expect(error.lastFrame()).toBe('error: Resolve failed: 502');
  });
});
