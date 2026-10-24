// Every screen lays out from the same three widths, so resizing the terminal changes them all at
// the same moment. Narrow (under 110 columns): one column. Regular (110 to 139): a side panel
// (the PR preview, the overview diagram, the feedback, the tests beside the code, a thread's
// linked files). Wide (140 and up): the chapter list beside a chapter as well.
export const REGULAR = 110;
export const WIDE = 140;

export type Breakpoint = 'narrow' | 'regular' | 'wide';

export const breakpoint = (width: number): Breakpoint => (width >= WIDE ? 'wide' : width >= REGULAR ? 'regular' : 'narrow');
export const hasSidePanel = (width: number) => width >= REGULAR;
