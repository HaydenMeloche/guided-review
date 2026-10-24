import { useEffect, useState, type ReactNode } from 'react';
import { Box, Text, useTheme } from './themed.js';
import { readLinkedFile, type FileLink, type LinkedFile } from '../review/fileLinks.js';
import { highlightFileLines, type SyntaxSpan } from './highlight.js';
import { SyntaxText } from './chapter/SyntaxText.js';
import { codeChunks } from './chapter/text.js';
import { truncate } from './nav.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';
import { plural } from './plural.js';

// Lines shown on each side of a link's lines.
export const LINK_CONTEXT = 10;

// The lines (1-based, inclusive) a link shows: its own lines and LINK_CONTEXT on each side, or
// the top of the file for a link to the whole file.
export function linkWindow(link: Pick<FileLink, 'startLine' | 'endLine'>, lineCount: number, context = LINK_CONTEXT): { from: number; to: number } {
  if (!link.startLine) return { from: 1, to: Math.min(lineCount, 2 * context + 1) };
  const end = link.endLine ?? link.startLine;
  return { from: Math.max(1, link.startLine - context), to: Math.min(lineCount, end + context) };
}

type Loaded = { value?: LinkedFile; spans?: SyntaxSpan[][] };

// Each link's file, read at the commit it names, then highlighted. Keyed by URL.
function useLinkedFiles(links: FileLink[], worktree: string | undefined, headSha: string): Record<string, Loaded> {
  const { syntax } = useTheme();
  const [files, setFiles] = useState<Record<string, Loaded>>({});
  const key = links.map((l) => l.url).join('\n');
  useEffect(() => {
    if (!worktree) return;
    const ac = new AbortController();
    setFiles({});
    for (const link of links) {
      void readLinkedFile(worktree, link, headSha, ac.signal)
        .then(async (value) => {
          if (ac.signal.aborted) return;
          setFiles((f) => ({ ...f, [link.url]: { value } }));
          const spans = value.text === undefined ? undefined : await highlightFileLines(link.path, value.text, undefined, syntax).catch(() => undefined);
          if (!ac.signal.aborted && spans) setFiles((f) => ({ ...f, [link.url]: { value, spans } }));
        })
        .catch(() => undefined);
    }
    return () => ac.abort();
    // `key` stands for the links: the array is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, worktree, headSha, syntax]);
  return files;
}

// The files a review thread links to, beside it: from link `first` on, each with its linked
// lines marked and LINK_CONTEXT lines around them, stacked while they fit. A link with a label
// is code the thread names without linking (see codeRefs.ts), headed by the name.
export function FilePreview(props: { links: (FileLink & { label?: string })[]; first: number; worktree?: string; headSha: string; width: number; height: number }) {
  const { links, width, height } = props;
  const files = useLinkedFiles(links, props.worktree, props.headSha);
  const rows: ReactNode[] = [];
  let shown = 0;
  for (let k = props.first; k < links.length; k++) {
    // A row stays free for the "more" line while other links are off screen.
    const cap = height - (k < links.length - 1 || props.first ? 1 : 0);
    if (shown && cap - rows.length < 4) break;
    const link = links[k];
    const loaded = files[link.url];
    const lines = loaded?.value?.text?.split('\n') ?? [];
    const start = link.startLine;
    const end = link.endLine ?? start;
    const where = `${link.path}${start ? `:${start}${end && end !== start ? `-${end}` : ''}` : ''}`;
    if (shown) rows.push(<Text key={`gap${k}`}> </Text>);
    rows.push(
      <Text key={`h${k}`} wrap="truncate">
        {link.label ? <Text color="cyan">{`${truncate(safe(link.label), Math.max(8, Math.floor(width / 3)))} → `}</Text> : null}
        <Text bold color="cyan">
          {truncate(safe(where), Math.max(8, width - 14 - (link.label ? Math.min(link.label.length, Math.floor(width / 3)) + 3 : 0)))}
        </Text>
        <Text dimColor>{` @ ${safe((loaded?.value?.at ?? link.ref).slice(0, 8))}`}</Text>
      </Text>,
    );
    if (loaded?.value?.note)
      rows.push(
        <Text key={`n${k}`} color="yellow" wrap="truncate">
          {safe(loaded.value.note)}
        </Text>,
      );
    if (!props.worktree)
      rows.push(
        <Text key={`w${k}`} dimColor>
          The checkout isn’t ready yet.
        </Text>,
      );
    else if (!loaded)
      rows.push(
        <Text key={`w${k}`} dimColor>
          Reading…
        </Text>,
      );
    else if (lines.length) {
      // Short of room, the context shrinks evenly so the linked lines still show.
      const room = cap - rows.length;
      const span = start ? (end ?? start) - start + 1 : 0;
      const context = start && span + 2 * LINK_CONTEXT > room ? Math.max(0, Math.floor((room - span) / 2)) : LINK_CONTEXT;
      const { from, to } = linkWindow(link, lines.length, start ? context : Math.min(LINK_CONTEXT, Math.floor((room - 1) / 2)));
      const numW = String(to).length;
      const codeW = Math.max(4, width - numW - 4);
      for (let n = from; n <= to && rows.length < cap; n++) {
        const inRange = start !== undefined && n >= start && n <= (end ?? start);
        for (const [part, text] of codeChunks(lines[n - 1], codeW).entries()) {
          if (rows.length >= cap) break;
          rows.push(
            <Text key={`${k}:${n}:${part}`} wrap="truncate">
              <Text color={inRange ? 'cyan' : undefined}>{inRange ? '▌' : ' '}</Text>
              <Text dimColor={!inRange} bold={inRange}>
                {`${part ? '' : n}`.padStart(numW)}{' '}
              </Text>
              <SyntaxText text={text} spans={loaded.spans?.[n - 1]} column={part * codeW} />
            </Text>,
          );
        }
      }
    }
    shown++;
  }
  const rest = links.length - props.first - shown;
  if (rest > 0 || props.first > 0)
    rows.push(
      <Text key="more" dimColor wrap="truncate">
        {[props.first ? `${props.first} above` : '', rest > 0 ? `${plural(rest, 'more linked file')}` : ''].filter(Boolean).join(' · ')} · l next
      </Text>,
    );
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden" borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor="gray" paddingLeft={1}>
      {rows.slice(0, height)}
    </Box>
  );
}
