import os from 'node:os';
import path from 'node:path';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useInput } from 'ink';
import { Box, Text, useSelected } from './themed.js';
import { Key, KeyBar } from './KeyBar.js';
import { pad, truncate, wrap } from './nav.js';
import { sanitizeTerminal as safe } from '../util/sanitize.js';
import { fuzzyScore } from '../util/fuzzy.js';
import { tildify, type CloneIndex, type ScanResult } from '../git/clones.js';

// Setup's step for the user's own clones: it scans the folder gr config runs in, lists the clones
// found, and Ctrl+R (or /) searches the folders under home, fzf style, for another to scan. Enter
// keeps what was found; the caller saves it with the config.

export interface ClonesStepProps {
  width: number;
  height: number;
  start: string; // the folder scanned first
  home?: string;
  known: CloneIndex; // clones.json as it is
  scan: (folder: string) => Promise<ScanResult>;
  targets: () => Promise<string[]>; // folders under home, relative to it
  onBack: () => void;
  backLabel?: string; // what Esc does: back to the previous step, or cancel on its own
  onDone: (clones: CloneIndex) => void;
}

const SEARCH_ROWS = 10;

// The folders matching `query`, best first. With no query, the shallowest first, so ~/code and
// its like lead.
export function rankTargets(targets: string[], query: string, limit = SEARCH_ROWS): string[] {
  const q = query.trim();
  if (!q) return [...targets].sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b)).slice(0, limit);
  const scored: [string, number][] = [];
  for (const t of targets) {
    const s = fuzzyScore(q, t);
    if (s === undefined) continue;
    // A match in the folder's own name beats one spread over the path, so "pine" puts ~/code/pine
    // above ~/code/pine/evergreen; a shorter path wins a tie.
    const own = fuzzyScore(q, path.basename(t));
    scored.push([t, (own === undefined ? s : Math.max(s, own) + 100) - t.length / 100]);
  }
  return scored
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([t]) => t);
}

// "Scanned ~/code", newest first, naming at most two folders.
export function scannedLine(folders: string[]): string {
  const recent = [...folders].reverse();
  if (!recent.length) return '';
  if (recent.length <= 2) return `Scanned ${recent.join(' and ')}`;
  const more = recent.length - 2;
  return `Scanned ${recent.slice(0, 2).join(', ')} and ${more} more folder${more === 1 ? '' : 's'}`;
}

// How many clones gr will know, and how many of them this setup found.
export function countLine(total: number, fresh: number): string {
  const clones = `${total} clone${total === 1 ? '' : 's'}`;
  if (!total) return 'No clones found yet';
  if (fresh === total) return `${clones} found`;
  return fresh ? `${clones}, ${fresh} new` : `${clones}, none new`;
}

export function ClonesStep(props: ClonesStepProps) {
  const home = props.home ?? os.homedir();
  const selectedRow = useSelected();
  const [found, setFound] = useState<CloneIndex>({});
  const [scanned, setScanned] = useState<string[]>([]);
  const [scanning, setScanning] = useState<string>();
  const [searching, setSearchingState] = useState(false);
  // Read through a ref, so keys that arrive with Ctrl+R (a paste, fast typing) land in the search.
  const searchingRef = useRef(false);
  const setSearching = (on: boolean) => {
    searchingRef.current = on;
    setSearchingState(on);
  };
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [targets, setTargets] = useState<string[]>();
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const scan = (folder: string) => {
    setScanning(folder);
    void props
      .scan(folder)
      .catch((): ScanResult => ({ folder, clones: {} }))
      .then((r) => {
        if (!live.current) return;
        setFound((f) => ({ ...r.clones, ...f }));
        setScanned((s) => (s.includes(folder) ? s : [...s, folder]));
        setScanning(undefined);
      });
  };
  // The folder gr config runs in, once, as the step opens.
  useEffect(() => scan(props.start), []); // eslint-disable-line react-hooks/exhaustive-deps

  const openSearch = () => {
    setSearching(true);
    setQuery('');
    setSel(0);
    if (!targets) void props.targets().then((t) => live.current && setTargets(t));
  };

  const matches = useMemo(() => rankTargets(targets ?? [], query), [targets, query]);
  // A typed path (~/ or /) is scanned as it is when nothing under home matches it.
  const typedPath = /^[~/]/.test(query.trim()) ? path.resolve(query.trim().replace(/^~(?=\/|$)/, home)) : undefined;

  useInput((input, key) => {
    if (searchingRef.current) {
      if (key.escape) return setSearching(false);
      if (key.return) {
        const choice = matches[sel];
        const folder = choice !== undefined ? path.join(home, choice) : typedPath;
        if (!folder) return;
        setSearching(false);
        return scan(folder);
      }
      if (key.upArrow || (key.ctrl && input === 'p')) return setSel((s) => Math.max(0, s - 1));
      if (key.downArrow || (key.ctrl && input === 'n')) return setSel((s) => Math.min(Math.max(0, matches.length - 1), s + 1));
      if (key.backspace || key.delete) {
        setSel(0);
        return setQuery((q) => q.slice(0, -1));
      }
      if (key.ctrl && input === 'u') {
        setSel(0);
        return setQuery('');
      }
      if (input && !key.ctrl && !key.meta && !/[\u0000-\u001f]/.test(input)) {
        setSel(0);
        setQuery((q) => q + input);
      }
      return;
    }
    if ((key.ctrl && input === 'r') || input === '/') return openSearch();
    if (key.escape) return props.onBack();
    if (key.return && !scanning) return props.onDone(found);
  });

  const w = props.width;
  if (searching) {
    return (
      <Box flexDirection="column" width={w} height={props.height}>
        <Text bold> Scan another folder</Text>
        <Text dimColor wrap="truncate">
          {' '}
          Type to search the folders in {tildify(home, home)}, or a path starting with ~/ or /.
        </Text>
        <Text> </Text>
        <Text wrap="truncate">
          <Text color="cyan"> {'>'} </Text>
          {safe(query)}
          <Text inverse> </Text>
        </Text>
        {!targets ? (
          <Text dimColor> Listing folders…</Text>
        ) : matches.length ? (
          matches.map((m, i) => (
            <Text key={m} {...selectedRow(i === sel)} wrap="truncate">
              {'   '}
              {safe(truncate(path.join('~', m), w - 4))}
            </Text>
          ))
        ) : (
          <Text dimColor> {typedPath ? `Enter scans ${tildify(typedPath, home)}` : 'No folder matches'}</Text>
        )}
        <Box flexGrow={1} />
        <KeyBar
          accent
          width={w}
          keys={[
            ['↑/↓', 'choose'],
            ['enter', 'scan'],
            ['esc', 'cancel'],
          ]}
        />
      </Box>
    );
  }

  const all: [string, string, boolean][] = Object.entries({ ...props.known, ...found })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, root]) => [repo, root, props.known[repo] !== root]);
  const fresh = all.filter(([, , isNew]) => isNew).length;
  const about = wrap(
    'gr checks out each PR from your own clone of its repository when it knows one, instead of downloading a copy of its own. It also remembers the clone of any repository you run gr in.',
    Math.max(10, w - 2),
  );
  const listRows = Math.max(1, props.height - about.length - 9);
  const shown = all.length > listRows ? all.slice(0, listRows - 1) : all;
  const repoW = Math.min(Math.max(0, ...shown.map(([r]) => r.length)) + 2, Math.floor(w / 2));
  return (
    <Box flexDirection="column" width={w} height={props.height}>
      <Text bold> Local clones</Text>
      {about.map((l, i) => (
        <Text key={i} dimColor>
          {' '}
          {l}
        </Text>
      ))}
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginTop={1} width={Math.min(w, 72)}>
        <Text wrap="truncate">
          <Key k="ctrl+r" />
          {'  '}Search for another folder to scan, such as ~/code
        </Text>
      </Box>
      <Text wrap="truncate" dimColor>
        {' '}
        {safe(scanning ? `Scanning ${tildify(scanning, home)}…` : scannedLine(scanned.map((s) => tildify(s, home))))}
      </Text>
      <Text> </Text>
      <Text wrap="truncate" bold>
        {' '}
        {countLine(all.length, fresh)}
      </Text>
      {shown.map(([repo, root, isNew]) => (
        <Text key={repo} wrap="truncate">
          {'   '}
          {pad(safe(truncate(repo, repoW - 2)), repoW)}
          <Text dimColor>{safe(tildify(root, home))}</Text>
          {isNew ? <Text color="green"> new</Text> : null}
        </Text>
      ))}
      {shown.length < all.length ? <Text dimColor> … and {all.length - shown.length} more</Text> : null}
      <Box flexGrow={1} />
      <KeyBar
        accent
        width={w}
        keys={[
          ['enter', scanning ? 'wait' : 'continue'],
          ['ctrl+r', 'search folders'],
          ['esc', props.backLabel ?? 'back'],
        ]}
      />
    </Box>
  );
}
