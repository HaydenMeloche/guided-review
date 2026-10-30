import { sha1 } from '../util/hash.js';
import type { DiffFile, DiffLine, Hunk } from '../types.js';

// What makeHunkId produces; unanchored, so callers can embed it.
export const HUNK_ID_RE = /h_[0-9a-f]{10}/;

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(p: string): string {
  // a/foo, b/foo, or quoted "a/foo bar"
  let s = p.trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).replace(/\\(.)/g, '$1');
  if (s === '/dev/null') return s;
  return s.replace(/^[ab]\//, '');
}

function pathsFromDiffGit(line: string): { a: string; b: string } | undefined {
  const rest = line.slice('diff --git '.length);
  const quoted = rest.match(/^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/);
  if (quoted) return { a: stripPrefix(`"${quoted[1]}"`), b: stripPrefix(`"${quoted[2]}"`) };
  // Unquoted: split where " b/" begins; prefer a split where both halves match.
  const idx = rest.indexOf(' b/');
  if (idx < 0) return undefined;
  for (let i = idx; ; i = rest.indexOf(' b/', i + 1)) {
    const a = rest.slice(0, i);
    const b = rest.slice(i + 1);
    if (a.slice(2) === b.slice(2)) return { a: stripPrefix(a), b: stripPrefix(b) };
    if (rest.indexOf(' b/', i + 1) < 0) return { a: stripPrefix(rest.slice(0, idx)), b: stripPrefix(rest.slice(idx + 1)) };
  }
}

export function makeHunkId(path: string, header: string): string {
  return 'h_' + sha1(path + '\0' + header).slice(0, 10);
}

export function makeContentHash(path: string, lines: DiffLine[]): string {
  const changed = lines
    .filter((l) => l.kind !== 'ctx')
    .map((l) => (l.kind === 'add' ? '+' : '-') + l.text)
    .join('\n');
  return sha1(path + '\0' + changed);
}

export function parseUnifiedDiff(diff: string): { files: DiffFile[]; hunks: Hunk[] } {
  const files: DiffFile[] = [];
  const hunks: Hunk[] = [];
  const lines = diff.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  let file: DiffFile | undefined;
  let hunk: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;

  const finishHunk = () => {
    if (hunk && file) {
      hunk.contentHash = makeContentHash(file.path, hunk.lines);
      hunks.push(hunk);
      file.hunkIds.push(hunk.id);
    }
    hunk = undefined;
  };
  const finishFile = () => {
    finishHunk();
    if (file) files.push(file);
    file = undefined;
  };
  const newFile = (path: string, oldPath?: string): DiffFile => ({
    path,
    oldPath,
    status: 'modified',
    binary: false,
    kind: 'logic',
    kindReason: '',
    additions: 0,
    deletions: 0,
    hunkIds: [],
  });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      finishFile();
      const p = pathsFromDiffGit(line);
      file = newFile(p?.b ?? '', p && p.a !== p.b ? p.a : undefined);
      continue;
    }

    // Inside a hunk body: consume lines until counts are exhausted.
    if (hunk && file && (oldLeft > 0 || newLeft > 0 || line.startsWith('\\'))) {
      const c = line[0];
      if (c === '\\') continue; // "\ No newline at end of file"
      if (c === '+') {
        hunk.lines.push({ kind: 'add', text: line.slice(1), newLine: newNo++ });
        newLeft--;
        file.additions++;
        continue;
      }
      if (c === '-') {
        hunk.lines.push({ kind: 'del', text: line.slice(1), oldLine: oldNo++ });
        oldLeft--;
        file.deletions++;
        continue;
      }
      if (c === ' ' || line === '') {
        hunk.lines.push({ kind: 'ctx', text: line.slice(1), oldLine: oldNo++, newLine: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      // Malformed: fall through to header handling.
    }

    const m = line.match(HUNK_RE);
    if (m) {
      if (!file) file = newFile('');
      finishHunk();
      const oldStart = +m[1];
      const oldLines = m[2] === undefined ? 1 : +m[2];
      const newStart = +m[3];
      const newLines = m[4] === undefined ? 1 : +m[4];
      hunk = {
        id: makeHunkId(file.path, line),
        contentHash: '',
        file: file.path,
        oldFile: file.oldPath,
        header: line,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
        symbols: [],
        risk: 0,
        riskReasons: [],
        tests: [],
        coverage: 'n/a',
      };
      oldNo = oldStart;
      newNo = newStart;
      oldLeft = oldLines;
      newLeft = newLines;
      continue;
    }

    if (!file) {
      // Plain unified diff without "diff --git": start a file at ---/+++.
      if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
        const a = stripPrefix(line.slice(4).split('\t')[0]);
        const b = stripPrefix(lines[i + 1].slice(4).split('\t')[0]);
        file = newFile(b === '/dev/null' ? a : b, a !== b && a !== '/dev/null' && b !== '/dev/null' ? a : undefined);
        if (a === '/dev/null') file.status = 'added';
        if (b === '/dev/null') file.status = 'deleted';
        i++;
      }
      continue;
    }

    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      file.oldPath = line.slice('rename from '.length);
      file.status = 'renamed';
    } else if (line.startsWith('rename to ')) {
      file.path = line.slice('rename to '.length);
      file.status = 'renamed';
    } else if (line.startsWith('copy from ')) file.oldPath = line.slice('copy from '.length);
    else if (line.startsWith('copy to ')) file.path = line.slice('copy to '.length);
    else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true;
    else if (line.startsWith('--- ')) {
      const a = stripPrefix(line.slice(4).split('\t')[0]);
      if (a === '/dev/null') file.status = 'added';
    } else if (line.startsWith('+++ ')) {
      const b = stripPrefix(line.slice(4).split('\t')[0]);
      if (b === '/dev/null') file.status = 'deleted';
      else file.path = b;
    }
  }
  finishFile();

  for (const f of files) {
    if (f.status === 'modified' && f.oldPath && f.oldPath !== f.path) f.status = 'renamed';
    if (f.status === 'added' || f.status === 'deleted') f.oldPath = undefined;
  }
  // Hunk ids were built before rename lines might have changed path; keep file field consistent.
  const byId = new Map(hunks.map((h) => [h.id, h]));
  for (const f of files) {
    f.hunkIds = f.hunkIds.map((id) => {
      const h = byId.get(id)!;
      if (h.file !== f.path) {
        h.file = f.path;
        h.oldFile = f.oldPath;
        h.id = makeHunkId(f.path, h.header);
        h.contentHash = makeContentHash(f.path, h.lines);
      }
      if (f.status === 'renamed') h.oldFile = f.oldPath;
      return h.id;
    });
  }
  numberCopies(hunks);
  return { files, hunks };
}

// The same change made in several places of one file (a line added to 15 tests) would share a
// hash, and so a read state: each copy after the first gets its place among them, hash#2, hash#3.
// Hunks in diff order. A fused hunk's parts are numbered the same way, so a tour saved before
// copies were numbered can be numbered as it loads; numbering twice changes nothing.
export function numberCopies(hunks: Hunk[]) {
  const seen = new Map<string, number>();
  const number = (k: string) => {
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n > 1 ? `${k}#${n}` : k;
  };
  for (const h of hunks) {
    if (h.parts) h.parts = h.parts.map(number);
    else h.contentHash = number(h.contentHash);
  }
}

// The hash a hunk's copies share (see numberCopies).
export const sameChange = (h: Hunk) => h.contentHash.replace(/#\d+$/, '');
