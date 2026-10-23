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
