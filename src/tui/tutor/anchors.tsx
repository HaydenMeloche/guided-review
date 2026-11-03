import { createContext, use, useEffect, useRef, type ReactNode } from 'react';
import { Box as InkBox, measureElement, type DOMElement } from 'ink';
import { Dimmed } from '../themed.js';

// What the tutor can point at. A screen wraps a part of itself in <Anchor id>, which measures
// where that part landed on screen after each render and tells the tutor, and keeps it bright
// while the rest of the screen is dimmed. Outside the tutor there is no registry, and an Anchor
// is its children alone: real tours lay out exactly as they would without it.

export const ANCHORS = ['header', 'explain', 'code', 'tests', 'status', 'keybar', 'briefing.chapters', 'submit'] as const;
export type AnchorId = (typeof ANCHORS)[number];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnchorRegistry {
  spot?: AnchorId; // the anchor the tutor points at, kept bright; the rest is dimmed
  report: (id: AnchorId, rect: Rect | undefined) => void;
  // A column inside an anchor worth pointing at, such as the key the tutor asks for in the key bar.
  column: (id: AnchorId, x: number | undefined) => void;
}

export const AnchorContext = createContext<AnchorRegistry | undefined>(undefined);

// The anchor a component sits in, so the key bar knows it is the screen's own.
export const InAnchor = createContext<AnchorId | undefined>(undefined);

// The key the tutor asks for, drawn inverted in the screen's key bar.
export const EmphasizedKey = createContext<string | undefined>(undefined);

export const sameRect = (a: Rect | undefined, b: Rect | undefined) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

export function Anchor(props: { id: AnchorId; children: ReactNode }) {
  const registry = use(AnchorContext);
  const dimmed = use(Dimmed);
  const ref = useRef<DOMElement>(null);
  // After every render: layout can move an anchor without its own props changing.
  useEffect(() => {
    if (!registry || !ref.current) return;
    const m = measureElement(ref.current);
    registry.report(props.id, { x: m.x, y: m.y, width: m.width, height: m.height });
  });
  useEffect(() => () => registry?.report(props.id, undefined), [registry, props.id]);
  if (!registry) return props.children;
  // The providers are always there, lit or not, so the spotlight moving never remounts a screen.
  return (
    <InAnchor value={props.id}>
      <Dimmed value={dimmed && registry.spot !== props.id}>
        <InkBox ref={ref} flexDirection="column" flexShrink={0}>
          {props.children}
        </InkBox>
      </Dimmed>
    </InAnchor>
  );
}
