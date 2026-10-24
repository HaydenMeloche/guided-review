import { useEffect, useState } from 'react';
import { Text } from './themed.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_MS = 80;

// A small spinner for work in progress. It ticks only while mounted, so render it only while busy.
export function Spinner(props: { color?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), FRAME_MS);
    return () => clearInterval(t);
  }, []);
  return <Text color={props.color ?? 'cyan'}>{FRAMES[frame % FRAMES.length]}</Text>;
}

// Background work at a header's right end: a dim spinner and what is running, such as
// "narrating 3/7". Housekeeping, so it is quiet; notices that need a decision get the yellow bar.
export function Busy(props: { text: string }) {
  return (
    <Text dimColor wrap="truncate">
      {' '}
      <Spinner color="gray" /> {props.text}
    </Text>
  );
}

// A spinner with the seconds a request has run, for model calls that can take twenty: a static
// "thinking…" reads as hung. `label` follows the spinner; `color` is the spinner's.
export function Working(props: { label: string; color?: string }) {
  const [start] = useState(Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <Text>
      <Spinner color={props.color} /> <Text dimColor>{`${props.label} · ${Math.floor((now - start) / 1000)}s`}</Text>
    </Text>
  );
}
