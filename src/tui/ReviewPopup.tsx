import type { ReactNode } from 'react';
import { Box } from './themed.js';
import { BORDER, SURFACES, type BorderTone } from './theme.js';

// `tone`: what the popup is for, which its border color says (reading when unset).
export function ReviewPopup(props: {
  background: ReactNode;
  width: number;
  height: number;
  maxWidth: number;
  maxHeight: number;
  tone?: BorderTone;
  children?: (width: number, height: number) => ReactNode;
}) {
  const popupWidth = Math.min(props.maxWidth, Math.max(4, props.width - 2));
  const popupHeight = Math.min(props.maxHeight, Math.max(4, props.height - 2));
  return (
    <Box position="relative" width={props.width} height={props.height} overflow="hidden">
      {props.background}
      {props.children ? (
        <Box
          position="absolute"
          left={Math.max(0, Math.floor((props.width - popupWidth) / 2))}
          top={Math.max(0, Math.floor((props.height - popupHeight) / 2))}
          width={popupWidth}
          height={popupHeight}
          flexDirection="column"
          overflow="hidden"
          borderStyle="round"
          borderColor={BORDER[props.tone ?? 'reading']}
          backgroundColor={SURFACES.popup}
        >
          {props.children(popupWidth - 2, popupHeight - 2)}
        </Box>
      ) : null}
    </Box>
  );
}
