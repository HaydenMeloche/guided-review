import type { Chapter, ChecklistStatus, DiffFile, Flag, Graph, Hunk, PRInfo, ProgressFn, RepoConfig, Risk, Tour } from './types.js';
import { changedCount, maxRisk } from './diff/lines.js';
import { HUNK_ID_RE } from './diff/parse.js';
import { parseTourDiff } from './diff/fuse.js';
import { markMovedLines, unmovedFiles } from './diff/moves.js';
import { classifyFiles } from './analysis/kinds.js';
import { checkGeneratedSync } from './analysis/generatedSync.js';
import { SPECIAL_CHAPTERS } from './analysis/special.js';
import { buildSymbolIndex } from './analysis/symbols.js';
import { attachChangedTestDiffs, COVERAGE_FILES, pairTests } from './analysis/tests.js';
import { safeReader } from './analysis/safeRead.js';
import { applyRisk } from './analysis/risk.js';
import { buildChapters, splitByDirectory } from './analysis/flows.js';
import { findBlastRadius } from './analysis/blast.js';
import { defaultRepoConfig, parseRepoConfig } from './config.js';
import { clearImportNoise, markImportOnly, separateImportChapter } from './analysis/imports.js';
import { initTreeSitter } from './analysis/treesitter.js';
import { findMissingChanges } from './analysis/missing.js';
import { applicableChecklists } from './analysis/checklists.js';
import { listFiles, diffBetween, fetchCommit, hasCommit, mergeBaseOf, prDiff } from './git/worktree.js';
import { primeBaseCache, readBlobs } from './git/blobs.js';
import { fetchDiff, fetchReviews, fetchThreads, getMentionUsers, viewerLogin } from './github/gh.js';
import { fetchSharedTour, restoreSharedTour } from './github/sharedTour.js';
import { analyzeBriefing, analyzeChapter, AgentUnavailableError, type ChapterResult } from './agent/agent.js';
import { routingIdentity, type AgentRole, type AgentRouting } from './agent/types.js';
import { chapterBatches, isTruncated, MINOR_SUMMARY_ID, minorHunkIds } from './agent/prompts.js';
import { computeReReview } from './review/rereview.js';
import type { Store } from './store/db.js';

const LARGE_PR_LINES = 5000;
export const CHAPTER_CONCURRENCY = 6; // chapters in flight, and model calls in flight across their batches

export interface PipelineOptions {
  pr: PRInfo;
  worktree: string;
  store: Store;
  agent?: AgentRouting;
  noAgent?: boolean;
  fresh?: boolean; // ignore a cached tour, and any tour posted to the PR
  shared?: boolean; // look for a tour CI posted to the PR (default true)
  diffOverride?: string; // author preview: a local diff instead of the PR's
  onProgress: ProgressFn;
  // Called whenever the tour gains content. Emitted tours are never mutated afterwards: each
  // emission is a new top-level object, and unchanged chapters and hunks keep their identity.
  onTour: (tour: Tour) => void;
  signal?: AbortSignal;
}

// Files that steer the review itself. They are read from the merge base, never from the PR head,
// and a PR that changes them gets a warning.
const REVIEW_CONFIG_FILES = ['.guided-review.json', '.gitattributes'];

function changedPaths(files: DiffFile[]): Set<string> {
  return new Set(files.flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]));
}

function repoConfigFromText(text: string | undefined): RepoConfig {
  return text === undefined ? defaultRepoConfig() : parseRepoConfig(text);
}

// Static half of the pipeline: everything that does not need the model.
export async function buildStaticTour(pr: PRInfo, diff: string, worktree: string, onProgress: ProgressFn, signal?: AbortSignal, opts: { mergeBase?: string } = {}): Promise<Tour> {
  signal?.throwIfAborted();
  onProgress('Parsing diff');
  const readHead = safeReader(worktree);
  const { files, hunks: hunkList } = parseTourDiff(diff, readHead);
  const hunks: Record<string, Hunk> = Object.fromEntries(hunkList.map((h) => [h.id, h]));
  onProgress('Parsing diff', true);

  // GitHub's baseRefOid is the base branch's current tip; the PR diff is against the merge base.
  const mergeBase = opts.mergeBase ?? (await mergeBaseOf(worktree, pr.baseSha, pr.headSha, signal)) ?? pr.baseSha;
  signal?.throwIfAborted();
  // Every base version in one batched read (and, in a blobless clone, one fetch).
  const basePaths = [...new Set(files.filter((f) => f.status !== 'added' && !f.binary).map((f) => f.oldPath ?? f.path))];
  const blobs = await readBlobs(worktree, mergeBase, [...basePaths, ...REVIEW_CONFIG_FILES], signal);
  const baseContents = new Map(basePaths.map((p) => [p, blobs.get(p)]));
  primeBaseCache(worktree, mergeBase, baseContents);
  const readBase = (p: string) => baseContents.get(p);
  const [configText, gitattributes] = REVIEW_CONFIG_FILES.map((p) => blobs.get(p));
  signal?.throwIfAborted();

  const flags: Flag[] = [];
  const touched = changedPaths(files);
  const touchedConfig = REVIEW_CONFIG_FILES.filter((p) => touched.has(p));
  if (touchedConfig.length) {
    flags.push({
      kind: 'info',
      message: `This PR changes ${touchedConfig.join(' and ')}, which steer this tour (file kinds, test patterns, checklists). The tour uses the base branch's version; review the change itself carefully.`,
      hunkIds: files.filter((f) => touchedConfig.includes(f.path) || touchedConfig.includes(f.oldPath ?? '')).flatMap((f) => f.hunkIds),
    });
  }
  const untrustedCoverage = COVERAGE_FILES.filter((p) => touched.has(p));
  if (untrustedCoverage.length) {
    flags.push({
      kind: 'info',
      message: `This PR changes committed coverage data (${untrustedCoverage.join(', ')}): it was ignored, so coverage-based test links are not shown for it.`,
    });
  }

  onProgress('Classifying files by kind');
  const config = repoConfigFromText(configText);
  classifyFiles(files, hunks, { gitattributes: gitattributes ?? '', readHead, config });
  markMovedLines(hunkList, readHead, unmovedFiles(files));
  flags.push(...checkGeneratedSync(files, hunks));
  markImportOnly(files, hunks);
  onProgress('Classifying files by kind', true);

  signal?.throwIfAborted();
  onProgress('Tracing flows');
  await initTreeSitter(files.map((f) => f.path)).catch(() => false);
  const index = buildSymbolIndex(files, hunks, { readHead, readBase });
  onProgress('Tracing flows', true);

  signal?.throwIfAborted();
  onProgress('Pairing tests');
  const allFiles = await listFiles(worktree, signal);
  pairTests(files, hunks, { root: worktree, readHead, listFiles: () => allFiles, untrustedCoverage, testPatterns: config.testPatterns });
  onProgress('Pairing tests', true);

  onProgress('Scoring risk');
  applyRisk(files, hunks);
  clearImportNoise(hunks);
  onProgress('Scoring risk', true);

  const built = buildChapters(files, hunks, index);
  built.chapters = separateImportChapter(built.chapters, hunks);
  flags.push(...built.flags);
  const notes = [...built.notes];
  if (index.lowConfidence) notes.push('Some files have no static analyzer: their flow edges come from naming and are low confidence.');

  flags.push(...findMissingChanges(files, hunks, { listFiles: () => allFiles, readHead }));
  for (const [chapterId, items] of applicableChecklists(built.chapters, hunks, config.checklists)) {
    const ch = built.chapters.find((c) => c.id === chapterId);
    if (ch) ch.checklist = items;
  }

  const kindOf = new Map(files.map((f) => [f.path, f.kind]));
  const logicHunks = Object.values(hunks).filter((h) => !h.importOnly && kindOf.get(h.file) === 'logic');
  const untestedRisky = logicHunks.filter((h) => h.coverage === 'untested' && h.risk >= 2);
  if (untestedRisky.length) {
    flags.push({ kind: 'missing-tests', message: `${untestedRisky.length} risky hunk(s) have no linked test`, hunkIds: untestedRisky.map((h) => h.id) });
  }
  const changed = logicHunks.reduce((n, h) => n + changedCount(h), 0);
  if (changed > LARGE_PR_LINES) {
    built.chapters = splitByDirectory(built.chapters, hunks);
    flags.push({
      kind: 'large-pr',
      message: `${changed} changed lines of hand-written code: supporting changes are split by directory and analyzed in batches; very large hunks get a lighter analysis.`,
    });
  }

  signal?.throwIfAborted();
  onProgress('Finding blast radius');
  const blastRadius = await findBlastRadius(
    worktree,
    hunks,
    index,
    files.map((f) => f.path),
    signal,
  ).catch(() => []);
  onProgress('Finding blast radius', true);
  signal?.throwIfAborted();

  return {
    version: 1,
    repo: pr.repo,
    pr: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    baseSha: mergeBase,
    headSha: pr.headSha,
    createdAt: new Date().toISOString(),
    mode: 'plain',
    intent: fallbackIntent(pr),
    description: pr.body,
    flags,
    notes,
    overview: built.overview,
    chapters: built.chapters,
    files,
    hunks,
    blastRadius,
    existingThreads: [],
  };
}

function fallbackIntent(pr: PRInfo): string {
  const body = pr.body
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((l) => !/^\s*(#|[-*] \[[ xX]\]|>)/.test(l)) // headings, template checklists, quotes
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences =
    body
      .match(/[^.!?]+[.!?](\s|$)/g)
      ?.slice(0, 3)
      .join('')
      .trim() ?? body.slice(0, 300);
  const issues = pr.linkedIssues.map((i) => i.title).filter(Boolean);
  const lead = `${pr.title}.${issues.length ? ` Addresses: ${issues.join('; ')}.` : ''}`;
  return sentences && sentences.length > 20 ? `${lead} ${sentences}` : lead;
}

// The agent cites hunk ids; readers need file:line instead.
export function humanizeHunkIds(text: string, tour: Tour): string {
  return text.replace(new RegExp(`\\b(${HUNK_ID_RE.source})\\b`, 'g'), (id) => {
    const h = tour.hunks[id];
    return h ? `${h.file.split('/').pop()}:${h.newStart || h.oldStart}` : id;
  });
}

// Runs fn over items with at most `limit` in flight. The first error aborts `controller`
// (so in-flight work that watches its signal stops too), no further items are started,
// and the error is rethrown once every worker has settled.
export async function mapLimit<T>(items: T[], limit: number, fn: (t: T) => Promise<void>, controller = new AbortController()) {
  let i = 0;
  let failed: { error: unknown } | undefined;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length && !controller.signal.aborted) {
      try {
        await fn(items[i++]);
      } catch (error) {
        failed ??= { error };
        controller.abort(error);
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw failed.error;
  controller.signal.throwIfAborted();
}

// The model can raise a hunk's static risk, never lower it; static reasons stay visible.
export function mergeModelRisk(hunk: Hunk, modelRisk: number, reason: string) {
  const staticRisk = hunk.risk;
  const model = Math.max(0, Math.min(3, Math.round(modelRisk))) as Risk;
  hunk.risk = Math.max(staticRisk, model) as Risk;
  const rest = hunk.riskReasons.filter((x) => x !== reason);
  hunk.riskReasons = model > staticRisk ? [reason, ...rest] : [...rest, reason];
}

const CHECKLIST_STATUSES: ChecklistStatus[] = ['pass', 'fail', 'unknown'];

// Applies one narration result to a chapter and returns a new tour. Only the chapter and
// the hunks the result narrated are new objects; everything else keeps its identity.
export function applyChapterResult(tour: Tour, chapterId: string, r: ChapterResult, opts: { minorIds?: string[]; untestedBranches?: string[] } = {}): Tour {
  const idx = tour.chapters.findIndex((c) => c.id === chapterId);
  if (idx < 0) return tour;
  const old = tour.chapters[idx];
  const chapter: Chapter = { ...old };
  const fix = (s: string) => humanizeHunkIds(s, tour);
  if (r.hunkOrder?.length) {
    const own = new Set(old.hunkIds);
    const valid = r.hunkOrder.filter((id) => own.has(id));
    const seen = new Set(valid);
    chapter.hunkIds = [...new Set([...valid, ...old.hunkIds.filter((id) => !seen.has(id))])];
  }
  const hunks = { ...tour.hunks };
  const narrated = new Set<string>();
  let orphanReasons: Record<string, string> | undefined;
  for (const h of r.hunks ?? []) {
    if (h.id === MINOR_SUMMARY_ID) continue;
    const prev = hunks[h.id];
    if (!prev) continue;
    const next: Hunk = { ...prev, narration: fix(h.narration), narrationInferred: !h.citesCode };
    delete next.narrationShared;
    if (typeof h.risk === 'number' && Number.isFinite(h.risk) && h.riskReason) mergeModelRisk(next, h.risk, h.riskReason);
    hunks[h.id] = next;
    narrated.add(h.id);
    if (chapter.kind === 'supporting' && h.orphanReason) (orphanReasons ??= { ...old.orphanReasons })[h.id] = fix(h.orphanReason);
  }
  // Minor hunks share the chapter's one summary of them, unless the model narrated one on its own.
  const shared = r.hunks?.find((h) => h.id === MINOR_SUMMARY_ID);
  if (shared?.narration) {
    const text = fix(shared.narration);
    for (const id of opts.minorIds ?? []) {
      if (narrated.has(id) || !hunks[id]) continue;
      hunks[id] = { ...hunks[id], narration: text, narrationInferred: !shared.citesCode, narrationShared: true };
    }
  }
  if (orphanReasons) chapter.orphanReasons = orphanReasons;
  if (opts.untestedBranches) chapter.untestedBranches = opts.untestedBranches.map(fix);
  else if (r.untestedBranches?.length) chapter.untestedBranches = r.untestedBranches.map(fix);
  if (r.checklist?.length && old.checklist) {
    const results = new Map(r.checklist.map((c) => [c.id, c]));
    // Checklist status is the model's pre-check only (see ChecklistItem.status); the reviewer's
    // own confirmation is stored separately and never set here.
    chapter.checklist = old.checklist.map((item) => {
      const res = results.get(item.id);
      return res && CHECKLIST_STATUSES.includes(res.status) ? { ...item, status: res.status, reason: res.reason === undefined ? undefined : fix(res.reason) } : item;
    });
  }
  const diagram = r.diagram?.nodes?.length ? sanitizeGraph(r.diagram, tour) : undefined;
  if (diagram) chapter.diagram = diagram;
  chapter.risk = maxRisk(chapter.hunkIds, hunks);
  const chapters = tour.chapters.slice();
  chapters[idx] = chapter;
  return { ...tour, chapters, hunks };
}

// Model graphs: drop dangling hunk ids and edges, turn hunk ids in text into file:line, and
// discard graphs too small to say more than a sentence would (the static diagram stays).
const MIN_GRAPH_NODES = 3;
export function sanitizeGraph(g: Graph, tour: Tour): Graph | undefined {
  if (g.nodes.length < MIN_GRAPH_NODES) return undefined;
  // A before/after side with one box has no relationships to compare.
  if (g.kind === 'before-after' && ['before', 'after'].some((side) => g.nodes.filter((n) => (n.group ?? 'after') === side).length < 2)) return undefined;
  const fix = (s: string) => humanizeHunkIds(s, tour);
  const ids = new Set(g.nodes.map((n) => n.id));
  return {
    ...g,
    title: fix(g.title),
    nodes: g.nodes.map((n) => ({ ...n, label: fix(n.label), hunkId: n.hunkId && tour.hunks[n.hunkId] ? n.hunkId : undefined })),
    edges: g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => (e.label === undefined ? e : { ...e, label: fix(e.label) })),
  };
}

// The briefing's result as a new tour: intent, flags, chapter titles and order, overview.
function applyBriefing(tour: Tour, brief: Awaited<ReturnType<typeof analyzeBriefing>>): Tour {
  const fix = (s: string) => humanizeHunkIds(s, tour);
  const fixOpt = (s?: string) => (s === undefined ? s : fix(s));
  let flags = tour.flags;
  flags = [...(brief.value.scopeCreep ?? []).map((s): Flag => ({ kind: 'scope-creep', message: s.message, hunkIds: s.hunkIds?.filter((id) => tour.hunks[id]) })), ...flags];
  for (const m of brief.value.missingChanges ?? []) {
    if (!flags.some((f) => f.kind === 'missing-change' && f.message === m.message)) {
      flags = [...flags, { kind: 'missing-change', message: m.message, hunkIds: m.hunkIds?.filter((id) => tour.hunks[id]) }];
    }
  }
  const named = new Map(brief.value.chapters.map((c) => [c.id, c]));
  const chapters = tour.chapters.map((c) => {
    const b = named.get(c.id);
    return {
      ...c,
      ...(b ? { title: b.title } : {}),
      summary: fixOpt(b ? b.summary : c.summary),
      untestedBranches: c.untestedBranches.map(fix),
      orphanReasons: Object.fromEntries(Object.entries(c.orphanReasons).map(([k, v]) => [k, fix(v)])),
      ...(c.checklist ? { checklist: c.checklist.map((it) => ({ ...it, reason: fixOpt(it.reason) })) } : {}),
    };
  });
  // Reorder flow chapters as recommended; supporting and low-priority kinds keep their place at the end.
  const rank = new Map(brief.value.chapters.map((c, i) => [c.id, i]));
  const flows = chapters.filter((c) => c.kind === 'flow').sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
  const next: Tour = {
    ...tour,
    mode: 'agent',
    intent: fix(brief.value.intent || tour.intent),
    flags: flags.map((f) => ({ ...f, message: fix(f.message) })),
    chapters: [...flows, ...chapters.filter((c) => c.kind !== 'flow')],
  };
  if (brief.modelUsed) next.modelUsage = { briefing: brief.modelUsed };
  const overview = brief.value.overview?.nodes?.length ? sanitizeGraph(brief.value.overview, tour) : undefined;
  if (overview) next.overview = overview;
  return next;
}

// At most n calls of fn in flight.
function semaphore(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < n) active++;
    else await new Promise<void>((resolve) => queue.push(resolve));
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

function roleIdentity(identity: string | undefined, role: AgentRole): string | undefined {
  if (!identity || identity === 'plain') return identity;
  try {
    return JSON.stringify((JSON.parse(identity) as Record<string, unknown>)[role]);
  } catch {
    return identity;
  }
}

// How much of a saved tour for this head can be reused under the current model routing:
// - complete: all of it (only the Q&A role, which does not shape the tour, may differ);
// - resume: the briefing and every chapter already narrated;
// - briefing: the briefing only (the narration model changed);
// - none: rebuild.
export function reuseLevel(saved: Tour, identity: string): 'complete' | 'resume' | 'briefing' | 'none' {
  // A shared tour was built with CI's models, not this reader's; it is complete as it stands.
  if (saved.source === 'shared') return saved.complete ? 'complete' : 'none';
  if (saved.agentIdentity === identity) return saved.complete ? 'complete' : saved.mode === 'agent' ? 'resume' : 'none';
  if (identity === 'plain' || !saved.agentIdentity || saved.agentIdentity === 'plain' || saved.mode !== 'agent') return 'none';
  const same = (role: AgentRole) => roleIdentity(saved.agentIdentity, role) === roleIdentity(identity, role);
  if (!same('briefing')) return 'none';
  if (!same('narration')) return 'briefing';
  return saved.complete ? 'complete' : 'resume';
}

const NARRATED_KINDS = new Set<Chapter['kind']>(['flow', 'supporting', 'tests', ...SPECIAL_CHAPTERS.map((c) => c.kind)]);
const STOPPED_EARLY = 'Narration stopped early';

interface LiveData {
  threads?: Tour['existingThreads'];
  reviews?: Tour['existingReviews'];
  viewer?: string;
}

// Full pipeline: cached tour → static analysis → agent briefing → per-chapter narration → re-review delta.
//
// onTour emissions:
// - cached complete tour: (1) the saved tour at once, with the threads and reviews it was saved
//   with; (2) a copy with live threads, reviews and viewer once they arrive. Returns (2).
// - resumable tour (same head, briefing reusable): (1) the saved tour at once (mode 'agent');
//   (2) a copy with live threads, reviews and viewer; then one per narrated batch for the chapters
//   still missing; then the final tour.
// - fresh: (1) the static tour (mode 'plain'); (2) after the briefing (mode 'agent'); then one per
//   narrated batch and one per finished chapter; then the final tour (complete set when every
//   step finished). The final tour is also the return value, and it is saved here.
export async function runPipeline(opts: PipelineOptions): Promise<Tour> {
  const { pr, worktree, store, onProgress, signal } = opts;
  signal?.throwIfAborted();
  const identity = opts.noAgent ? 'plain' : routingIdentity(opts.agent);
  const saved = !opts.fresh ? store.loadTour(pr.repo, pr.number, pr.headSha) : undefined;
  const reuse = saved ? reuseLevel(saved, identity) : 'none';
  const local = opts.diffOverride !== undefined;

  // Network calls start at once and are awaited only where their result is needed.
  onProgress('Fetching review threads');
  let mentionUsers: string[] | undefined;
  if (!local)
    getMentionUsers(pr.repo).then(
      (u) => void (mentionUsers = u),
      () => undefined,
    );
  const liveData: Promise<LiveData> = local
    ? Promise.resolve({})
    : Promise.all([fetchThreads(pr.repo, pr.number, signal).catch(() => undefined), fetchReviews(pr.repo, pr.number, signal).catch(() => undefined), viewerLogin(signal).catch(() => undefined)]).then(
        ([threads, reviews, viewer]) => ({ threads, reviews, viewer }),
      );
  const withLive = (t: Tour, live: LiveData): Tour => ({
    ...t,
    existingThreads: live.threads ?? t.existingThreads ?? [],
    existingReviews: live.reviews ?? t.existingReviews,
    viewer: live.viewer ?? t.viewer,
    mentionUsers: mentionUsers ?? t.mentionUsers,
  });

  let tour: Tour;
  if (saved && reuse !== 'none') {
    attachChangedTestDiffs(saved.files, saved.hunks);
    saved.description ??= pr.body;
    tour = saved;
    if (reuse !== 'complete') {
      // Chapters to narrate again lose their flag and the notes their earlier attempt left.
      const redo = new Set(tour.chapters.filter((c) => NARRATED_KINDS.has(c.kind) && (reuse === 'briefing' || !c.narrated)).map((c) => c.title));
      tour = {
        ...tour,
        agentIdentity: identity,
        complete: false,
        notes: tour.notes.filter((n) => !n.startsWith(STOPPED_EARLY) && ![...redo].some((title) => n.startsWith(`"${title}": `) || n.startsWith(`Chapter "${title}" `))),
        chapters: reuse === 'briefing' ? tour.chapters.map((c) => (c.narrated ? { ...c, narrated: false } : c)) : tour.chapters,
      };
    }
    opts.onTour(tour);
    const live = await liveData;
    signal?.throwIfAborted();
    onProgress('Fetching review threads', true);
    tour = withLive(tour, live);
    opts.onTour(tour);
    if (reuse === 'complete') return tour;
  } else {
    const sharedP = local || opts.fresh || opts.shared === false ? Promise.resolve(undefined) : fetchSharedTour(pr.repo, pr.number, pr.headSha, signal);
    onProgress('Fetching diff');
    const diff = opts.diffOverride !== undefined ? { text: opts.diffOverride } : await prDiffLocalOrRemote(pr, worktree, signal);
    onProgress('Fetching diff', true);

    // A tour CI posted to the PR stands in for building one, once its code matches the diff.
    const shared = await sharedP;
    signal?.throwIfAborted();
    const restored = shared && restoreSharedTour(shared, diff.text, safeReader(worktree));
    if (restored) {
      attachChangedTestDiffs(restored.files, restored.hunks);
      const live = await liveData;
      signal?.throwIfAborted();
      onProgress('Fetching review threads', true);
      tour = withLive(restored, live);
      await attachReReview(tour, opts, live.viewer);
      signal?.throwIfAborted();
      onProgress('Using the tour posted to the PR', true);
      store.saveTour(tour);
      opts.onTour(tour);
      return tour;
    }

    const built = await buildStaticTour(pr, diff.text, worktree, onProgress, signal, { mergeBase: diff.mergeBase });
    const live = await liveData;
    signal?.throwIfAborted();
    onProgress('Fetching review threads', true);
    built.agentIdentity = identity;
    built.existingThreads = live.threads ?? [];
    built.existingReviews = live.reviews ?? [];
    built.viewer = live.viewer;
    built.mentionUsers = mentionUsers ?? [];
    await attachReReview(built, opts, live.viewer);
    signal?.throwIfAborted();
    tour = built;
    opts.onTour(tour);
  }

  if (!opts.noAgent) {
    try {
      if (tour.mode !== 'agent') {
        onProgress('Writing briefing');
        const brief = await analyzeBriefing(tour, pr, worktree, opts.agent, signal);
        signal?.throwIfAborted();
        tour = applyBriefing(tour, brief);
        onProgress('Writing briefing', true);
        store.saveTour(tour);
        opts.onTour(tour);
      }

      // Chapter prompts carry the briefing's intent and per-chapter summary, so narration
      // waits for the briefing.
      const narratable = tour.chapters.filter((c) => NARRATED_KINDS.has(c.kind));
      const toNarrate = narratable.filter((c) => !c.narrated);
      let done = narratable.length - toNarrate.length;
      onProgress(`Narrating chapters ${done}/${narratable.length}`, done === narratable.length, { done, total: narratable.length });
      // Linked to the caller's signal, and aborted on the first fatal error so the other
      // workers stop calling the model and stop touching the tour.
      const narration = new AbortController();
      const stop = narration.signal;
      const onAbort = () => narration.abort(signal?.reason);
      if (signal?.aborted) onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const call = semaphore(CHAPTER_CONCURRENCY);
      const chapterNow = (id: string) => tour.chapters.find((c) => c.id === id)!;
      try {
        await mapLimit(
          toNarrate,
          CHAPTER_CONCURRENCY,
          async (start) => {
            const id = start.id;
            const batches = chapterBatches(tour, start);
            const multi = batches.length > 1;
            const staticBranches = start.untestedBranches;
            const branches: string[][] = [];
            // Every batch runs at once (within the call limit). With several batches the
            // model's hunkOrder is dropped and only batch 0's diagram is kept, so no batch
            // depends on another.
            const settled = await Promise.allSettled(
              batches.map((batch, i) =>
                call(async () => {
                  if (stop.aborted) return;
                  const part = multi ? { ...chapterNow(id), hunkIds: batch } : chapterNow(id);
                  const minorIds = minorHunkIds(tour, part);
                  let r: Awaited<ReturnType<typeof analyzeChapter>>;
                  try {
                    r = await analyzeChapter(tour, part, worktree, opts.agent, stop);
                  } catch (e) {
                    if (e instanceof AgentUnavailableError) narration.abort(e);
                    throw e;
                  }
                  if (stop.aborted) return;
                  if (r.modelUsed) tour = { ...tour, modelUsage: { ...tour.modelUsage, [`narration:${id}${multi ? `:${i}` : ''}`]: r.modelUsed } };
                  const value = { ...r.value };
                  if (multi) delete value.hunkOrder;
                  if (i > 0) delete value.diagram;
                  branches[i] = value.untestedBranches ?? [];
                  const merged = branches.flat();
                  tour = applyChapterResult(tour, id, value, { minorIds, untestedBranches: multi ? (merged.length ? merged : staticBranches) : undefined });
                  opts.onTour(tour);
                }),
              ),
            );
            const failures = settled.flatMap((s) => (s.status === 'rejected' ? [s.reason as unknown] : []));
            const fatal = failures.find((e) => e instanceof AgentUnavailableError);
            if (fatal) throw fatal;
            if (stop.aborted) return;
            let notes = tour.notes;
            const title = chapterNow(id).title;
            if (failures.length) {
              notes = [...notes, `Chapter "${title}" got a lighter analysis: ${(failures[0] as Error).message}`];
            } else {
              const truncated = chapterNow(id).hunkIds.filter((h) => tour.hunks[h] && isTruncated(tour.hunks[h])).length;
              if (truncated) notes = [...notes, `"${title}": ${truncated} very large hunk(s) got a lighter analysis (only their first lines were read).`];
            }
            tour = { ...tour, notes, chapters: tour.chapters.map((c) => (c.id === id ? { ...c, narrated: true } : c)) };
            done++;
            onProgress(`Narrating chapters ${done}/${narratable.length}`, done === narratable.length, { done, total: narratable.length });
            opts.onTour(tour);
          },
          narration,
        );
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    } catch (e) {
      signal?.throwIfAborted();
      if (tour.mode !== 'agent') {
        tour = {
          ...tour,
          flags: [
            {
              kind: 'model-unavailable',
              message: `Model unavailable (${(e as Error).message.slice(0, 120)}): plain diff mode with kind sorting and test pairing by name; agent features are off.`,
            },
            ...tour.flags,
          ],
        };
        onProgress('Writing briefing', true);
      } else {
        tour = { ...tour, notes: [...tour.notes, `${STOPPED_EARLY}: ${(e as Error).message.slice(0, 160)}`] };
        onProgress('Narrating chapters', true);
      }
    }
  }

  signal?.throwIfAborted();
  // A tour whose narration stopped early is resumed on the next open: the briefing and the
  // chapters marked narrated are reused, the rest are narrated then.
  const complete = (tour.mode === 'agent' && !tour.notes.some((n) => n.startsWith(STOPPED_EARLY))) || !!opts.noAgent;
  tour = { ...tour, complete, mentionUsers: mentionUsers ?? tour.mentionUsers };
  store.saveTour(tour);
  opts.onTour(tour);
  return tour;
}

// The PR's diff: computed in the worktree from the merge base when both commits are there
// (tens of milliseconds, byte-identical to GitHub's three-dot diff), else fetched from GitHub.
async function prDiffLocalOrRemote(pr: PRInfo, worktree: string, signal?: AbortSignal): Promise<{ text: string; mergeBase?: string }> {
  const mergeBase = await mergeBaseOf(worktree, pr.baseSha, pr.headSha, signal);
  if (mergeBase) {
    try {
      return { text: await prDiff(worktree, mergeBase, pr.headSha, signal), mergeBase };
    } catch {
      signal?.throwIfAborted();
    }
  }
  signal?.throwIfAborted();
  return { text: await fetchDiff(pr.repo, pr.number, signal) };
}

async function attachReReview(tour: Tour, opts: PipelineOptions, viewer: string | undefined) {
  const prev = opts.store.latestTour(tour.repo, tour.pr, tour.headSha);
  if (!prev || opts.diffOverride !== undefined) return;
  const posted = opts.store.listDrafts(tour.repo, tour.pr).filter((d) => d.posted);
  try {
    if (!(await hasCommit(opts.worktree, prev.headSha, opts.signal))) {
      await fetchCommit(opts.worktree, prev.headSha, opts.signal);
    }
    const diff = await diffBetween(opts.worktree, prev.headSha, tour.headSha, opts.signal);
    tour.rereview = computeReReview(prev, tour, { postedDrafts: posted, threads: tour.existingThreads, diffPrevToNext: diff, viewer });
  } catch (e) {
    opts.signal?.throwIfAborted();
    // The old head may be gone after a force-push; fall back to content hashes only.
    tour.rereview = computeReReview(prev, tour, { postedDrafts: posted, threads: tour.existingThreads, diffPrevToNext: '', viewer });
    tour.notes.push(`Re-review: could not diff against the previous head ${prev.headSha.slice(0, 8)} (${(e as Error).message.slice(0, 80)}).`);
  }
}
