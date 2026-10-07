import type { Chapter, DiffFile, Hunk } from '../types.js';

// Import-only hunks (adding, removing or reordering imports) are low value: they
// move into one optional chapter, cost no model calls, and never count as unread.

const SINGLE_LINE = [
  /^\s*import\s.+\sfrom\s+['"][^'"]+['"]\s*;?\s*$/, // JS/TS: import x from 'y'
  /^\s*import\s+['"][^'"]+['"]\s*;?\s*$/, // JS/TS: import 'side-effect'
  /^\s*import\s+(type\s+)?[\w$*{},\s]+=\s*require\(\s*['"][^'"]+['"]\s*\)\s*;?\s*$/, // TS import = require
  /^\s*export\s+(type\s+)?(\*|\{[^}]*\})(\s+as\s+[\w$]+)?\s+from\s+['"][^'"]+['"]\s*;?\s*$/, // re-exports
  /^\s*(const|let|var)\s+[\w${},\s:]+=\s*require\(\s*['"][^'"]+['"]\s*\)\s*;?\s*$/, // CommonJS
  /^\s*import\s+(static\s+)?[\w.]+(\.\*)?(\s+as\s+\w+)?\s*;?\s*$/, // Kotlin / Java / Scala / Swift
  /^\s*package\s+[\w.]+\s*;?\s*$/, // Kotlin / Java / Go package line
  /^\s*(from\s+[\w.]+\s+)?import\s+[\w., *()]+$/, // Python
  /^\s*import\s+(\w+\s+)?"[^"]+"\s*$/, // Go single import
  /^\s*(pub\s+)?use\s+[\w:{}, *]+;\s*$/, // Rust
  /^\s*(require|require_relative)\s+['"][^'"]+['"]\s*$/, // Ruby
  /^\s*using\s+[\w.]+\s*;\s*$/, // C#
  /^\s*#\s*include\s+[<"][^>"]+[>"]\s*$/, // C / C++
];

const BLOCK_OPEN = [
  /^\s*import\s+(type\s+)?\{[^}]*$/, // import {
  /^\s*export\s+(type\s+)?\{[^}]*$/, // export { … } from
  /^\s*import\s+[\w$]+\s*,\s*\{[^}]*$/, // import X, {
  /^\s*import\s*\(\s*$/, // Go import (
  /^\s*from\s+[\w.]+\s+import\s*\(\s*$/, // Python from x import (
  /^\s*(pub\s+)?use\s+[\w:]+::\{[^}]*$/, // Rust use a::{
];
const BLOCK_CLOSE = /^\s*(\}\s*from\s+['"][^'"]+['"]\s*;?|\)|\};?)\s*$/;
// A name inside an import block: `Foo,`, `type Bar as Baz,`, `"fmt"`, `alias "pkg/x"`.
const BLOCK_ITEM = /^\s*((type\s+)?[\w$]+(\s+as\s+[\w$]+)?\s*,?|(\w+\s+)?"[^"]+"|[\w:]+(::\{)?[\w, ]*,?)\s*$/;

const isBlank = (s: string) => /^\s*$/.test(s);

// A line that is, or opens, an import statement; also a quoted Go import spec on its own line.
export function isImportLine(text: string): boolean {
  return SINGLE_LINE.some((re) => re.test(text)) || BLOCK_OPEN.some((re) => re.test(text)) || /^\s*(\w+\s+)?"[^"]+"\s*$/.test(text);
}

// True when every added or removed line in the hunk is part of an import statement.
export function isImportOnlyHunk(h: Hunk): boolean {
  const kinds = h.lines.map(() => false); // per line: belongs to an import statement
  let inBlock = false;
  h.lines.forEach((l, i) => {
    const t = l.text;
    if (inBlock) {
      kinds[i] = true;
      if (BLOCK_CLOSE.test(t)) inBlock = false;
      return;
    }
    if (SINGLE_LINE.some((re) => re.test(t))) kinds[i] = true;
    else if (BLOCK_OPEN.some((re) => re.test(t))) {
      kinds[i] = true;
      inBlock = true;
    }
  });
  // The hunk may begin inside an import block whose opening line is above it:
  // leading item lines count when a block close follows them.
  const close = h.lines.findIndex((l, i) => BLOCK_CLOSE.test(l.text) && !kinds[i]);
  if (close >= 0 && h.lines.slice(0, close).every((l, i) => kinds[i] || isBlank(l.text) || BLOCK_ITEM.test(l.text))) {
    for (let i = 0; i <= close; i++) kinds[i] = true;
  }

  let changed = 0;
  for (let i = 0; i < h.lines.length; i++) {
    const l = h.lines[i];
    if (l.kind === 'ctx' || isBlank(l.text)) continue;
    if (!kinds[i]) return false;
    changed++;
  }
  return changed > 0;
}

// Flags import-only hunks in hand-written and test files and takes them out of
// test pairing and risk, which only add noise for imports.
export function markImportOnly(files: DiffFile[], hunks: Record<string, Hunk>): string[] {
  const ids: string[] = [];
  for (const f of files) {
    if ((f.kind !== 'logic' && f.kind !== 'test') || f.binary) continue;
    for (const id of f.hunkIds) {
      const h = hunks[id];
      if (!h || !isImportOnlyHunk(h)) continue;
      h.importOnly = true;
      ids.push(id);
    }
  }
  return ids;
}

export function clearImportNoise(hunks: Record<string, Hunk>): void {
  for (const h of Object.values(hunks)) {
    if (!h.importOnly) continue;
    h.tests = [];
    h.coverage = 'n/a';
    h.risk = 0;
    h.riskReasons = [];
    delete h.covers;
  }
}

const IMPORTS_CHAPTER_ID = 'imports';

// Moves import-only hunks out of the reading chapters into one optional chapter,
// placed after the hand-written chapters and before config and generated code.
export function separateImportChapter(chapters: Chapter[], hunks: Record<string, Hunk>): Chapter[] {
  const ids: string[] = [];
  const kept: Chapter[] = [];
  for (const c of chapters) {
    const moved = c.hunkIds.filter((id) => hunks[id]?.importOnly);
    if (!moved.length) {
      kept.push(c);
      continue;
    }
    ids.push(...moved);
    const hunkIds = c.hunkIds.filter((id) => !hunks[id]?.importOnly);
    const orphanReasons = Object.fromEntries(Object.entries(c.orphanReasons).filter(([id]) => !hunks[id]?.importOnly));
    if (hunkIds.length) kept.push({ ...c, hunkIds, orphanReasons, linkedHunkIds: c.linkedHunkIds.filter((id) => !hunks[id]?.importOnly) });
  }
  if (!ids.length) return chapters;
  const chapter: Chapter = {
    id: IMPORTS_CHAPTER_ID,
    kind: 'imports',
    title: 'Import-only changes',
    summary: `${ids.length} hunk(s) that only add, remove or reorder imports. Optional: they don't count toward progress.`,
    risk: 0,
    hunkIds: [...new Set(ids)],
    linkedHunkIds: [],
    orphanReasons: {},
    untestedBranches: [],
    collapsed: true,
    optional: true,
  };
  const firstLowPriority = kept.findIndex((c) => !['flow', 'supporting', 'tests'].includes(c.kind));
  const at = firstLowPriority < 0 ? kept.length : firstLowPriority;
  return [...kept.slice(0, at), chapter, ...kept.slice(at)];
}
