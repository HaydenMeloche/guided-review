// Plain helpers shared by the runPipeline tests. The vi.mock factories for gh, git and the
// agent stay in each test file, because vitest hoists vi.mock per file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import type { ChapterResult } from '../../src/agent/agent.js';
import type { PipelineOptions } from '../../src/pipeline.js';
import type { Store } from '../../src/store/db.js';
import type { Chapter, PRInfo, Tour } from '../../src/types.js';

export const pr: PRInfo = {
  repo: 'o/r',
  number: 7,
  title: 'Add modules',
  body: '',
  url: 'https://github.com/o/r/pull/7',
  author: 'a',
  baseRef: 'main',
  headRef: 'feature',
  baseSha: 'base',
  headSha: 'head',
  commits: [],
  linkedIssues: [],
};

export function fakeStore(cached?: Tour) {
  return {
    loadTour: vi.fn(() => cached),
    saveTour: vi.fn(),
    latestTour: vi.fn(() => undefined),
    listDrafts: vi.fn(() => []),
  };
}

export function briefingFor(chapters: Chapter[]) {
  return { value: { intent: 'Adds modules.', chapters: chapters.map((c) => ({ id: c.id, title: c.title, summary: `About ${c.title}` })) } };
}

export function narrationFor(c: Chapter): { value: ChapterResult } {
  return { value: { hunks: c.hunkIds.map((id) => ({ id, narration: `narrated ${c.id}`, citesCode: true })) } };
}

// A fresh temp worktree per test (created in beforeEach, removed in afterEach), with helpers bound to it.
export function tempWorktree(prefix: string) {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  return {
    get root() {
      return root;
    },

    // Writes `n` independent entry points into the worktree and returns their diff: each becomes its own flow chapter.
    writeModules: (n: number): string => {
      let diff = '';
      for (let i = 1; i <= n; i++) {
        const file = `src/mod${i}/entry.ts`;
        const text = `export function run${i}(x: number) {\n  if (x > ${i}) return helper${i}(x);\n  return 0;\n}\n\nfunction helper${i}(x: number) {\n  return x * ${i};\n}\n`;
        fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
        const lines = text.trimEnd().split('\n');
        diff += `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
      }
      return diff;
    },

    options: (store: ReturnType<typeof fakeStore>, extra: Partial<PipelineOptions> = {}): PipelineOptions => ({
      pr,
      worktree: root,
      store: store as unknown as Store,
      onProgress: () => {},
      onTour: vi.fn(),
      ...extra,
    }),
  };
}
