import { isLockfile, lockfileChanges } from '../analysis/lockfile.js';
import { changedCount } from '../diff/lines.js';
import { isSpecialKind, type SpecialKind } from '../analysis/special.js';
import type { Chapter, DiffFile, Hunk, PRInfo, Tour } from '../types.js';

export const SYSTEM_PROMPT = `You are the guide in Guided Review, a terminal app that walks a code reviewer through a pull request the way its author would explain it at a whiteboard.

Your job is curation and explanation, not judgment: decide reading order, explain what each change does and why, and point at what deserves attention. The reviewer makes every judgment.

Rules:
- Every claim cites code (file:line or a hunk id). If you are inferring, say so and set citesCode=false.
- The diff is the truth. Never describe behavior the diff does not show.
- Be brief and concrete. Narration is one short paragraph (2-4 sentences, under 70 words): what this hunk does in the flow and why. Do not end with review advice ("Check for...", "Verify that..."); flag concerns through risk and riskReason instead.
- You have read-only tools scoped to the PR's worktree (head commit). Use them sparingly, only when the diff alone is not enough.
- Never edit files.`;

const MAX_HUNK_LINES = 120;

// Rendering is the bulk of prompt building; hunks are immutable once emitted (a change makes a
// new object), so a rendering can be cached per hunk object.
const rendered = new WeakMap<Hunk, Map<number, string>>();

function renderHunk(h: Hunk, maxLines = MAX_HUNK_LINES): string {
  let byLimit = rendered.get(h);
  const hit = byLimit?.get(maxLines);
  if (hit !== undefined) return hit;
  const text = renderHunkUncached(h, maxLines);
  if (!byLimit) rendered.set(h, (byLimit = new Map<number, string>()));
  byLimit.set(maxLines, text);
  return text;
}

function renderHunkUncached(h: Hunk, maxLines: number): string {
  const body = h.lines.slice(0, maxLines).map((l) => {
    const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
    return `${sign}${l.text}`;
  });
  if (h.lines.length > maxLines) body.push(`… (${h.lines.length - maxLines} more lines)`);
  const meta = [
    h.symbols.length ? `symbols: ${h.symbols.join(', ')}` : '',
    h.riskReasons.length ? `static risk: ${h.riskReasons.join('; ')}` : '',
    h.tests.length ? `linked tests: ${h.tests.map((t) => `${t.testFile} › ${t.testName} (${t.source})`).join('; ')}` : 'linked tests: none',
  ].filter(Boolean);
  return `### hunk ${h.id} — ${h.file} ${h.header}\n${meta.join('\n')}\n\`\`\`diff\n${body.join('\n')}\n\`\`\``;
}

// Briefing size caps: the briefing sees the shape of the PR, not every hunk (chapter calls do).
const BRIEF_HUNKS_PER_CHAPTER = 15;
const BRIEF_MAX_FILES = 200;
const BRIEF_EXCERPTS = 40;
const BRIEF_EXCERPT_CHARS = 16_000;

function dirOf(file: string, depth = 2): string {
  const parts = file.split('/');
  return parts.length > 1 ? parts.slice(0, Math.min(depth, parts.length - 1)).join('/') : '(root)';
}

// "src/a (12), lib (3)": the most common directories of some files.
function topDirs(files: string[], n = 3): string {
  const counts = new Map<string, number>();
  for (const f of files) counts.set(dirOf(f), (counts.get(dirOf(f)) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = top.slice(0, n).map(([d, c]) => `${d} (${c})`);
  return top.length > n ? `${shown.join(', ')} and ${top.length - n} more dirs` : shown.join(', ');
}

const KIND_PRIORITY: Record<DiffFile['kind'], number> = { logic: 0, config: 1, test: 2, mechanical: 3, generated: 4, vendored: 5 };

function briefingFiles(files: DiffFile[]): string[] {
  const line = (f: DiffFile) => `- [${f.kind}] ${f.path} +${f.additions}/-${f.deletions}${f.summary ? ` — ${f.summary}` : ''}`;
  if (files.length <= BRIEF_MAX_FILES) return files.map(line);
  // Keep the most reviewable files (hand-written logic first, then the larger changes), in diff order.
  const keep = new Set([...files].sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || b.additions + b.deletions - (a.additions + a.deletions)).slice(0, BRIEF_MAX_FILES));
  const rest = new Map<string, { n: number; add: number; del: number; kinds: Map<string, number> }>();
  for (const f of files) {
    if (keep.has(f)) continue;
    const d = dirOf(f.path);
    const r = rest.get(d) ?? { n: 0, add: 0, del: 0, kinds: new Map() };
    r.n++;
    r.add += f.additions;
    r.del += f.deletions;
    r.kinds.set(f.kind, (r.kinds.get(f.kind) ?? 0) + 1);
    rest.set(d, r);
  }
  const rollups = [...rest.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([d, r]) => `- ${d}/: ${r.n} more file(s) +${r.add}/-${r.del} (${[...r.kinds.entries()].map(([k, c]) => `${k} ×${c}`).join(', ')})`);
  return [...files.filter((f) => keep.has(f)).map(line), ...rollups];
}

export function briefingPrompt(tour: Tour, pr: PRInfo): string {
  const files = briefingFiles(tour.files);
  const fileKind = new Map(tour.files.map((f) => [f.path, f.kind]));
  const chapters = tour.chapters
    .filter((c) => c.kind === 'flow' || c.kind === 'supporting')
    .map((c) => {
      const hs = c.hunkIds.map((id) => tour.hunks[id]).filter(Boolean);
      const lines = hs.slice(0, BRIEF_HUNKS_PER_CHAPTER).map((h) => `    - ${h.id} ${h.file}:${h.newStart || h.oldStart}${h.symbols.length ? ` [${h.symbols.join(', ')}]` : ''} ±${changedCount(h)}`);
      const more = hs.slice(BRIEF_HUNKS_PER_CHAPTER);
      if (more.length) lines.push(`    - …and ${more.length} more in ${topDirs(more.map((h) => h.file))}`);
      return `- chapter ${c.id} (${c.kind}) "${c.title}"${c.entryPoint ? ` entry: ${c.entryPoint}` : ''}${hs.length > BRIEF_HUNKS_PER_CHAPTER ? ` (${hs.length} hunks)` : ''}\n${lines.join('\n')}`;
    });
  // Cost control: show only short excerpts of logic hunks here; full hunks go to per-chapter calls.
  const excerpts: string[] = [];
  let excerptChars = 0;
  for (const h of Object.values(tour.hunks)) {
    if (excerpts.length >= BRIEF_EXCERPTS) break;
    if (h.importOnly || fileKind.get(h.file) !== 'logic') continue;
    const r = renderHunk(h, 25);
    if (excerptChars + r.length > BRIEF_EXCERPT_CHARS) continue;
    excerptChars += r.length;
    excerpts.push(r);
  }
  const issues = pr.linkedIssues.map((i) => `- ${i.title || i.url}\n${i.body.slice(0, 1500)}`).join('\n');
  const commits = pr.commits
    .slice(0, 50)
    .map((c) => `- ${c.message.split('\n')[0]}`)
    .join('\n');

  return `Prepare the briefing for PR #${pr.number} in ${pr.repo}: "${pr.title}" by ${pr.author}.

## PR description
${pr.body.slice(0, 6000) || '(empty)'}

## Linked issues
${issues || '(none)'}

## Commits
${commits || '(none)'}

## Files (kind as classified; generated and vendored files are shown only as stats)
${files.join('\n')}

## Static analysis: candidate chapters (flows traced from entry points, in call order; ±N = changed lines)
${chapters.join('\n') || '(none found)'}

## Flags already raised
${tour.flags.map((f) => `- ${f.kind}: ${f.message}`).join('\n') || '(none)'}

## Excerpts of hand-written changes
${excerpts.join('\n\n')}

Return:
- intent: the goal of the PR in 2-3 sentences, from the description, issues and commits, checked against the diff.
- scopeCreep: changes that do not serve the stated goal (cite hunk ids). Empty if none.
- missingChanges: what the PR did not change but probably should (docs, CHANGELOG, a migration for a model change, a feature flag, translations), only with evidence from this repo that it uses that practice; skip anything already in "Flags already raised". Empty if none.
- chapters: for each chapter id above, a short title naming the flow (e.g. "Create invoice: route → service → DB") and a one-sentence summary. List them in the reading order you recommend.
- overview: a small graph (3-12 nodes) of what changed and what it touches, read top to bottom as the path a request or user takes: start at the entry point (the route, handler, command or UI action that triggers the change) and follow it through each component to where it ends. One node per major component; nodes are things (a component, route, hook, query, store or API), never actions: a prefetch is an edge to the query it fills, not a node. hunkId on nodes that map to one hunk. Shared state that several parts read or write (URL params, a store, a cache, a table) is a single node with an edge for each read and each write, even when that makes a loop; that round trip is often the point of the change. Every edge points the way control or data flows (caller → callee, writer → state → reader), and every node is connected to the path; leave out test fixtures, mocks, loading placeholders and pure type changes unless they are the point of the PR. changed=true only on changed parts; add an unchanged node (an API, a caller) when it explains why the change exists. Edge labels are 1-3 words saying what the source does to the target ("calls", "renders", "reads", "writes"); if the source does not do it, the edge is drawn the wrong way round (a route prefetches a query, not the reverse). Draw each relationship once, from the caller: results coming back are implied, so add no "returns" edge. A UI control is rendered by a component; draw that edge too, so the control sits under it rather than floating at the top. kind: call for a flow through components, state only for status or enum transitions, entity for schema, deps for import structure.`;
}

const CHAPTER_BUDGET = 60_000;

// Splits a chapter's hunks into batches that each fit one analysis call, so large
// chapters get every hunk narrated instead of dropping the tail.
export function chapterBatches(tour: Tour, chapter: Chapter): string[][] {
  // Lockfile hunks are not rendered, only their parsed changes, so one call covers them all.
  if (chapter.kind === 'lockfiles') return chapter.hunkIds.length ? [chapter.hunkIds.filter((id) => tour.hunks[id])] : [];
  const batches: string[][] = [[]];
  let size = 0;
  for (const id of chapter.hunkIds) {
    const h = tour.hunks[id];
    if (!h) continue;
    const n = renderHunk(h).length;
    if (size + n > CHAPTER_BUDGET && batches[batches.length - 1].length) {
      batches.push([]);
      size = 0;
    }
    batches[batches.length - 1].push(id);
    size += n;
  }
  return batches.filter((b) => b.length);
}

export function isTruncated(h: Hunk): boolean {
  return h.lines.length > MAX_HUNK_LINES;
}

// Minor hunks are summarized together per chapter instead of narrated one by one: output
// tokens are about half the cost of a large PR. Never applies to medium or high static risk.
export const MINOR_SUMMARY_ID = 'minor-hunks';
const MINOR_MAX_CHANGED = 3; // fewer changed lines than this
const LARGE_SUPPORTING_CHAPTER = 40; // hunks
const MINOR_MIN_COUNT = 2; // a lone minor hunk is narrated normally
const MINOR_RENDER_LINES = 12;

function isMinorHunk(h: Hunk, chapter: Pick<Chapter, 'kind'> & { size: number }): boolean {
  if (h.risk >= 2) return false;
  return !!h.importOnly || changedCount(h) < MINOR_MAX_CHANGED || (chapter.kind === 'supporting' && chapter.size > LARGE_SUPPORTING_CHAPTER);
}

// The minor hunks among `chapter.hunkIds` (a whole chapter, or one batch of it: the size rule
// looks at the whole chapter in the tour). Empty when there are too few to summarize together.
export function minorHunkIds(tour: Tour, chapter: Chapter): string[] {
  // Lockfile hunks are read as one summary of the parsed package changes. In the other special
  // chapters a one-line edit (a version bump, a dropped column) can be the whole point.
  if (chapter.kind === 'lockfiles') return chapter.hunkIds.filter((id) => tour.hunks[id]);
  if (isSpecialKind(chapter.kind)) return [];
  const size = tour.chapters.find((c) => c.id === chapter.id)?.hunkIds.length ?? chapter.hunkIds.length;
  const ids = chapter.hunkIds.filter((id) => tour.hunks[id] && isMinorHunk(tour.hunks[id], { kind: chapter.kind, size }));
  return ids.length >= MINOR_MIN_COUNT ? ids : [];
}

const SPECIAL_LENGTH = 'This narration may run past the usual length, up to about 150 words.';

// Chapters whose narration explains what a change means rather than what the diff says.
// `context` follows the chapter heading; `ask` replaces the usual hunks instruction.
const SPECIAL_PROMPTS: Record<Exclude<SpecialKind, 'lockfiles'>, { context: string; ask: string }> = {
  migrations: {
    context: 'These hunks are database migrations or schema changes.',
    ask: `- hunks: narration for each hunk. Do not restate the SQL or migration code (the reviewer sees the diff). Explain what happens when it runs, mentioning only the points that apply, in 2-4 short bullets: whether it locks or rewrites a table and whether that table is likely large (from how the code uses it); whether it can lose data (a dropped or renamed column or table, a narrowed type, NOT NULL added without a default); whether it can be rolled back (a down migration exists and restores the data); whether it needs a backfill; and whether application code must deploy before or after it (e.g. code still reads a column it drops). Grep the repo for the tables and columns it touches. ${SPECIAL_LENGTH} Raise risk (0-3) with a short riskReason for possible data loss or a long lock.`,
  },
  api: {
    context: 'These hunks change API contracts (OpenAPI, protobuf, GraphQL or Avro schemas).',
    ask: `- hunks: narration for each hunk. Do not restate the schema (the reviewer sees the diff). For each changed endpoint, operation, message, field or type, say whether it breaks existing clients or consumers (a removed or renamed field or endpoint, a field made required, a changed type, a narrowed enum, changed auth or status codes; for protobuf, any changed or reused field number) or is an additive, compatible change. Lead with breaking changes and name the clients or consumers in this repo that rely on them (grep). 2-4 short bullets. ${SPECIAL_LENGTH} Raise risk (0-3) with a short riskReason for a breaking change.`,
  },
  dependencies: {
    context: 'These hunks change dependency manifests or runtime and toolchain versions.',
    ask: `- hunks: narration for each hunk. Do not describe the edit to the file (the reviewer sees the diff). For a dependency upgraded or downgraded, give "name old → new" and then the highlights of what is new between those versions: notable features, breaking changes, deprecations and security fixes, 1-3 short bullets per dependency, most important first. For a dependency added for the first time or removed, give "name version (added)" or "name (removed)" and instead of release notes a high-level overview of the package in 1-2 sentences: what it is, what it is typically used for, and, for an addition, where this PR uses it (grep the repo). For a major upgrade lead with the breaking changes and grep the repo for uses of anything removed or renamed. A runtime or toolchain version (a Docker base image, the Node, Python, Go, Java, Ruby, Rust or .NET version, the TypeScript target) is treated like an upgrade: "name old → new" and its highlights, adding when the old or new version reaches end of life if that is near or past. Read a changelog in the worktree (e.g. node_modules/<name>/CHANGELOG.md) when one exists; otherwise answer from what you know of the release and set citesCode=false. If you do not know a release, say so instead of guessing. If a hunk changes no dependency or version (e.g. a script), say what it is in one sentence. ${SPECIAL_LENGTH} Adjust risk (0-3) only with a short riskReason, e.g. a major upgrade with breaking changes the code uses.`,
  },
  infra: {
    context: 'These hunks change infrastructure (Terraform, Kubernetes, Helm, serverless or CloudFormation).',
    ask: `- hunks: narration for each hunk. Do not restate the configuration (the reviewer sees the diff). Say what happens when it is applied, in 2-4 short bullets: which resources are created, destroyed or replaced; in-place edits that force a replacement or restart (an attribute that forces a new resource, a renamed resource or module without a moved block, a changed StatefulSet selector or immutable field); and changes to IAM, network exposure, scaling, resource limits or secrets. Say plainly when a change is routine. ${SPECIAL_LENGTH} Raise risk (0-3) with a short riskReason for destructive or exposure changes.`,
  },
  ci: {
    context: 'These hunks change CI and workflow configuration.',
    ask: `- hunks: narration for each hunk. Do not restate the YAML (the reviewer sees the diff). Say what changes in when the pipeline runs and what it can do, in 2-4 short bullets: triggers (new events, branches or paths), jobs added or removed, permissions and token scopes, and secrets newly passed to a step or job. Call out risky patterns: pull_request_target or workflow_run checking out PR code, untrusted input (a PR title, branch name or comment) interpolated into a run script, third-party actions not pinned to a commit SHA, self-hosted runners reachable from fork PRs. Say plainly when a change is routine maintenance. ${SPECIAL_LENGTH} Raise risk (0-3) with a short riskReason for a security-relevant change.`,
  },
};

const LOCKFILE_LIST_MAX = 60;

// The parsed package changes of the lockfiles in a chapter, in place of their (often huge) hunks.
function lockfileSection(tour: Tour, chapter: Chapter): string {
  const byFile = new Map<string, Hunk[]>();
  for (const id of chapter.hunkIds) {
    const h = tour.hunks[id];
    if (h) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);
  }
  const list = (label: string, items: string[]) =>
    items.length ? `${label} (${items.length}): ${items.slice(0, LOCKFILE_LIST_MAX).join(', ')}${items.length > LOCKFILE_LIST_MAX ? `, … ${items.length - LOCKFILE_LIST_MAX} more` : ''}` : '';
  return [...byFile]
    .map(([file, hs]) => {
      const c = lockfileChanges(file, hs);
      const lines = [
        list(
          'Major version changes',
          c.changed.filter((p) => p.major).map((p) => `${p.name} ${p.from} → ${p.to}`),
        ),
        list(
          'Minor and patch changes',
          c.changed.filter((p) => !p.major).map((p) => `${p.name} ${p.from} → ${p.to}`),
        ),
        list(
          'Added',
          c.added.map((p) => `${p.name} ${p.version}`),
        ),
        list(
          'Removed',
          c.removed.map((p) => `${p.name} ${p.version}`),
        ),
      ].filter(Boolean);
      return `### ${file} (${hs.length} hunk(s): ${hs.map((h) => h.id).join(', ')})\n${lines.length ? lines.map((l) => `- ${l}`).join('\n') : '- no package changes detected'}`;
    })
    .join('\n\n');
}

function lockfilePrompt(tour: Tour, chapter: Chapter): string {
  const manifests = tour.chapters.some((c) => c.kind === 'dependencies');
  return `PR #${tour.pr} — intent: ${tour.intent || '(unknown)'}

Chapter ${chapter.id} (lockfiles): "${chapter.title}". The lockfile hunks are not shown; these are the package changes parsed from them.${manifests ? ' The PR also changes dependency manifests, narrated in another chapter.' : ' No dependency manifest changed, so these are indirect (transitive) changes, e.g. from a lockfile refresh or an audit fix.'}

${lockfileSection(tour, chapter)}

Return:
- hunks: a single entry with id "${MINOR_SUMMARY_ID}" (do not narrate hunks one by one) whose narration summarizes the indirect changes in 2-5 short bullets, most important first: the major version changes and what breaks in them, packages added or removed that matter, and security fixes the new versions are known to bring (with the advisory id if you know it). If the manifest changes explain these, say so in one line. Answer from what you know of the releases and set citesCode=false; say so when you do not know a release instead of guessing. ${SPECIAL_LENGTH}
- untestedBranches: empty.`;
}

export function chapterPrompt(tour: Tour, chapter: Chapter): string {
  if (chapter.kind === 'lockfiles') return lockfilePrompt(tour, chapter);
  const minor = new Set(minorHunkIds(tour, chapter));
  const hunks = chapter.hunkIds.map((id) => tour.hunks[id]).filter(Boolean);
  let budget = CHAPTER_BUDGET;
  const rendered: string[] = [];
  const minorRendered: string[] = [];
  for (const h of hunks) {
    const isMinor = minor.has(h.id);
    const r = renderHunk(h, isMinor ? MINOR_RENDER_LINES : MAX_HUNK_LINES);
    const out = isMinor ? minorRendered : rendered;
    if (budget - r.length < 0) {
      out.push(`### hunk ${h.id} — ${h.file} ${h.header} (omitted for size; narrate from the file if needed)`);
      continue;
    }
    budget -= r.length;
    out.push(r);
  }
  const minorSection = minorRendered.length
    ? `\n\n## Minor hunks (${minorRendered.length}): imports, one- or two-line edits, or routine changes in a large chapter\n\n${minorRendered.join('\n\n')}`
    : '';
  const supporting =
    chapter.kind === 'supporting'
      ? '\nThese hunks are not reached from any entry point. For each, also give orphanReason: a one-line reason it is in the PR (e.g. "config default", "dead code removal").'
      : '';
  const checklist = chapter.checklist?.length
    ? `\n\nTeam checklist for this chapter. Pre-check each item against the code (read files if needed): pass, fail, or unknown when you cannot tell; give a one-line reason citing file:line.\n${chapter.checklist.map((c) => `- ${c.id}: ${c.item}`).join('\n')}`
    : '';
  const special = isSpecialKind(chapter.kind) ? SPECIAL_PROMPTS[chapter.kind] : undefined;
  const lockfiles = chapter.kind === 'dependencies' ? tour.files.filter((f) => isLockfile(f.path) && f.summary).map((f) => `- ${f.path}: ${f.summary}`) : [];
  const specialContext = special ? `\n${special.context}${lockfiles.length ? ` Lockfile changes in this PR:\n${lockfiles.join('\n')}` : ''}` : '';
  const hunksAsk = special
    ? special.ask
    : minorRendered.length
      ? `- hunks: narration for each hunk above the "Minor hunks" section (what it does in this flow and why). Do not narrate the minor hunks one by one: add a single entry with id "${MINOR_SUMMARY_ID}" whose narration summarizes them together in 1-2 sentences. Narrate a minor hunk on its own only if it changes behavior in a way the reviewer must check. citesCode=false if a narration relies on inference beyond the visible code. Adjust risk (0-3) only with a short riskReason when the static risk is wrong or missing.`
      : '- hunks: narration for each hunk (what it does in this flow and why). citesCode=false if the narration relies on inference beyond the visible code. Adjust risk (0-3) only with a short riskReason when the static risk is wrong or missing.';
  return `PR #${tour.pr} — intent: ${tour.intent || '(unknown)'}

Chapter ${chapter.id} (${chapter.kind}): "${chapter.title}"${chapter.entryPoint ? `, entry point ${chapter.entryPoint}` : ''}.
Briefing summary: ${chapter.summary || '(none)'}
The hunks below are in the call order static analysis found.${supporting}${specialContext}

${rendered.join('\n\n')}${minorSection}${checklist}

Return:
- hunkOrder: all hunk ids, in the order a request or job would run through them (handler, then service, then data layer). Put a type or schema change right before its first use. Keep the given order if it is already right.
${hunksAsk}
- untestedBranches: new branches or behaviors with no linked test case, each as "file:line — what is untested".
- diagram: include one when the flow crosses 3+ functions, components or services (call; most flow chapters do), when it changes behavior of an existing path (before-after, nodes grouped "before"/"after"), changes enum/status transitions (state), or touches schema (entity). 3-10 nodes (a single rename or field swap needs no diagram); changed=true on changed nodes; hunkId on nodes that map to a hunk. Shared state (URL params, a store, a cache) is one node with an edge for each read and write; edges point the way control or data flows, labelled with what the source does in 1-3 words ("reads", "renders", "prefetches"). Each node is named for the component it is (a function, hook, module or route, 2-4 words such as "PaymentEventsTable" or "URL date params"), never a sentence or an action (a prefetch is an edge to the query it fills); what it does belongs on the edges, and edge labels are never code expressions. A change to conditions or values inside one component needs no diagram. Draw each relationship once, from the caller, with no "returns" edge. Use state only for status or enum transitions, not for data flow. Omit otherwise.${chapter.checklist?.length ? '\n- checklist: one entry per checklist id above.' : ''}`;
}
