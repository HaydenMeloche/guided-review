import { spawn } from 'node:child_process';
import { git } from '../git/git.js';
import { escapeRe } from '../util/regex.js';
import { extensionsWhere, languageOf } from '../util/language.js';
import { isDefinition } from './blast.js';
import { isImportLine } from './imports.js';
import { safeReadFile } from './safeRead.js';
import { FALLBACK_LANGUAGES, parseFallbackSymbols, parseTsSymbols, type Decl, type DeclKind } from './symbols.js';
import { initTreeSitter, parseWithTreeSitter, supportsTreeSitter } from './treesitter.js';

// Lazy, per-head lookups behind comment autocompletion: repository files by fuzzy path, and
// declarations by name. Nothing is parsed up front; a symbol query greps for files that mention
// the typed word and parses only those, caching declarations per path. All paths are relative
// to `root` and every read goes through safeReadFile, so nothing outside the worktree is read.

const SEARCH_TIMEOUT_MS = 1500;
const MAX_HIT_FILES = 40;
const MAX_PARSE_BYTES = 512 * 1024;
const MAX_TEXT = 200;

// Every language some parser here reads: TS/JS, tree-sitter grammars, and the regex fallback.
const SOURCE_EXTS = extensionsWhere((l) => l.family === 'js' || !!l.treeSitter || FALLBACK_LANGUAGES.has(l.id)).split('|');
const RG_GLOBS = ['-g', `*.{${SOURCE_EXTS.join(',')}}`, '-g', '!*.min.js'];
const GIT_PATHSPECS = [...SOURCE_EXTS.map((e) => `*.${e}`), ':!*.min.js'];

export function isSourcePath(path: string): boolean {
  const lang = languageOf(path);
  return !!lang && (lang.family === 'js' || !!lang.treeSitter || FALLBACK_LANGUAGES.has(lang.id));
}

export interface RepoIndexOptions {
  root: string;
  headSha: string;
  changedFiles?: string[];
  rg?: string; // ripgrep binary; tests point this at a missing one to exercise the git grep path
}

export interface FileHit {
  path: string;
  score: number;
  changed: boolean;
}

export interface SymbolHit {
  name: string;
  qualified: string;
  kind: DeclKind;
  file: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  owner?: string; // enclosing class or type for methods
}

// `truncated` is set when the grep hit the file cap or the timeout, so more matches may exist.
export type SymbolResults = SymbolHit[] & { truncated: boolean };

export interface CallerHit {
  file: string;
  line: number;
  text: string;
}

const isBoundary = (t: string, j: number): boolean => {
  if (j === 0) return true;
  const p = t[j - 1];
  if (p === '/' || p === '.' || p === '_' || p === '-' || p === ' ') return true;
  // camelCase hump
  return p >= 'a' && p <= 'z' && t[j] >= 'A' && t[j] <= 'Z';
};

// Case-insensitive subsequence score, or undefined when `query` is not a subsequence of
// `target`. Rewards matches at segment starts and contiguous runs; each gap costs a little.
export function fuzzyScore(query: string, target: string): number | undefined {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const n = q.length;
  const m = t.length;
  if (!n) return 0;
  let k = 0;
  for (let j = 0; j < m && k < n; j++) if (t[j] === q[k]) k++;
  if (k < n) return undefined;
  // prev[j]: best score with q[i-1] matched at t[j].
  let prev = new Float64Array(m).fill(-Infinity);
  for (let j = 0; j < m; j++) if (t[j] === q[0]) prev[j] = 1 + (isBoundary(target, j) ? 8 : 0);
  for (let i = 1; i < n; i++) {
    const cur = new Float64Array(m).fill(-Infinity);
    let gapBest = -Infinity; // best prev[k] with k <= j - 2
    for (let j = i; j < m; j++) {
      if (j >= 2) gapBest = Math.max(gapBest, prev[j - 2]);
      if (t[j] !== q[i]) continue;
      const via = Math.max(gapBest - 1, prev[j - 1] + 6);
      if (via > -Infinity) cur[j] = via + 1 + (isBoundary(target, j) ? 8 : 0);
    }
    prev = cur;
  }
  let best = -Infinity;
  for (const v of prev) if (v > best) best = v;
  return best > -Infinity ? best : undefined;
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const stemOf = (b: string) => (b.lastIndexOf('.') > 0 ? b.slice(0, b.lastIndexOf('.')) : b);
const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

function ownerOf(qualified: string): string | undefined {
  const local = qualified.slice(qualified.indexOf('#') + 1);
  const dot = local.lastIndexOf('.');
  return dot > 0 ? local.slice(0, dot) : undefined;
}

function innermost(decls: Decl[], line: number): Decl | undefined {
  let best: Decl | undefined;
  for (const d of decls) {
    if (line >= d.startLine && line <= d.endLine && (!best || d.endLine - d.startLine < best.endLine - best.startLine)) best = d;
  }
  return best;
}

// Normalizes a path printed by rg or git grep to repo-relative form; undefined for anything
// that could leave the root.
function relPath(p: string): string | undefined {
  const rel = p.startsWith('./') ? p.slice(2) : p;
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) return undefined;
  return rel;
}

interface StreamResult {
  missing: boolean; // the binary was not found
  timedOut: boolean;
  stopped: boolean; // onRecord asked for no more
}

// Streams a search command's stdout as `sep`-terminated records. `onRecord` returns false to
// stop the search early. Never rejects; the caller checks its signal afterwards.
function streamRecords(cmd: string, args: string[], cwd: string, sep: string, onRecord: (rec: string) => boolean, signal?: AbortSignal): Promise<StreamResult> {
  return new Promise((resolve) => {
    const res: StreamResult = { missing: false, timedOut: false, stopped: false };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], signal });
    } catch {
      resolve(res);
      return;
    }
    const timer = setTimeout(() => {
      res.timedOut = true;
      child.kill();
    }, SEARCH_TIMEOUT_MS);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') res.missing = true;
      finish();
    });
    let pending = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      if (res.stopped) return;
      const parts = (pending + chunk).split(sep);
      pending = parts.pop() ?? '';
      for (const p of parts) {
        if (p && !onRecord(p)) {
          res.stopped = true;
          child.kill();
          return;
        }
      }
    });
    child.on('close', () => {
      if (!res.stopped && !res.timedOut && pending) onRecord(pending);
      finish();
    });
  });
}

export class RepoIndex {
  readonly root: string;
  readonly headSha: string;
  private readonly changed: Set<string>;
  private readonly rg: string;
  private rgMissing = false;
  private fileList?: Promise<string[]>;
  private readonly decls = new Map<string, Decl[]>();
  private readonly parsing = new Map<string, Promise<Decl[]>>();
  private changedParsed?: Promise<void>;

  constructor(opts: RepoIndexOptions) {
    this.root = opts.root;
    this.headSha = opts.headSha;
    this.changed = new Set(opts.changedFiles ?? []);
    this.rg = opts.rg ?? 'rg';
  }

  // Tracked files, listed once. ls-files reads only the index, so it works in blobless clones.
  private listFiles(): Promise<string[]> {
    this.fileList ??= git(this.root, ['ls-files', '-z'], { maxBuffer: 256 * 1024 * 1024 }).then(
      (out) => out.split('\0').filter(Boolean),
      () => [],
    );
    return this.fileList;
  }

  async files(query: string, opts: { limit?: number; recent?: string[] } = {}): Promise<FileHit[]> {
    const limit = opts.limit ?? 50;
    const all = await this.listFiles();
    const q = query.trim();
    if (!q) {
      // Changed files, then recently used ones, then the rest in index order.
      const recent = (opts.recent ?? []).filter((p) => !this.changed.has(p));
      const known = new Set(all);
      const head = [...all.filter((p) => this.changed.has(p)), ...recent.filter((p) => known.has(p))];
      const seen = new Set(head);
      const out = head.map((path) => ({ path, score: 0, changed: this.changed.has(path) }));
      for (const path of all) {
        if (out.length >= limit) break;
        if (!seen.has(path)) out.push({ path, score: 0, changed: false });
      }
      return out.slice(0, limit);
    }
    const ql = q.toLowerCase();
    const hits: FileHit[] = [];
    for (const path of all) {
      let score = fuzzyScore(q, path);
      if (score === undefined) continue;
      const base = baseName(path);
      const bl = base.toLowerCase();
      const bs = fuzzyScore(q, base);
      if (bs !== undefined) score = Math.max(score, bs + 10);
      if (bl === ql || stemOf(bl) === ql) score += 40;
      else if (bl.startsWith(ql)) score += 15;
      const changed = this.changed.has(path);
      if (changed) score += 6; // a nudge; a clearly better path match still wins
      hits.push({ path, score, changed });
    }
    hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
    return hits.slice(0, limit);
  }

  // Declarations already parsed for a path, without parsing.
  declsIn(path: string): Decl[] | undefined {
    return this.decls.get(path);
  }

  // Head-side declarations of one file, parsed once. Unreadable, oversized, or unsupported
  // files yield none.
  ensureParsed(path: string): Promise<Decl[]> {
    const cached = this.decls.get(path);
    if (cached) return Promise.resolve(cached);
    let p = this.parsing.get(path);
    if (!p) {
      p = this.parse(path).finally(() => this.parsing.delete(path));
      this.parsing.set(path, p);
    }
    return p;
  }

  private async parse(path: string): Promise<Decl[]> {
    let decls: Decl[] = [];
    const rel = relPath(path);
    if (rel && isSourcePath(rel)) {
      const lang = languageOf(rel);
      // Loads the grammar on first use; a failed load leaves the regex fallback.
      if (lang?.treeSitter && !supportsTreeSitter(rel)) await initTreeSitter([rel]).catch(() => false);
      const text = safeReadFile(this.root, rel, MAX_PARSE_BYTES);
      if (text !== undefined) {
        try {
          if (lang?.family === 'js') decls = parseTsSymbols(rel, text, 'head').decls;
          else if (supportsTreeSitter(rel)) decls = (parseWithTreeSitter(rel, text, 'head') ?? parseFallbackSymbols(rel, text, 'head')).decls;
          else decls = parseFallbackSymbols(rel, text, 'head').decls;
        } catch {
          decls = [];
        }
      }
    }
    this.decls.set(path, decls);
    return decls;
  }

  async enclosingDecl(path: string, line: number): Promise<Decl | undefined> {
    return innermost(await this.ensureParsed(path), line);
  }

  private parseChanged(): Promise<void> {
    this.changedParsed ??= (async () => {
      for (const p of [...this.changed].filter(isSourcePath).slice(0, MAX_HIT_FILES)) {
        await this.ensureParsed(p);
        await yieldToLoop();
      }
    })().catch(() => {
      this.changedParsed = undefined;
    });
    return this.changedParsed;
  }

  // Files that mention a word starting with `term`, case-insensitively, and are not parsed yet.
  private async grepFiles(term: string, signal?: AbortSignal): Promise<{ paths: string[]; truncated: boolean }> {
    const paths: string[] = [];
    const seen = new Set<string>();
    let truncated = false;
    const onRecord = (rec: string) => {
      const rel = relPath(rec.replace(/\n$/, ''));
      if (!rel || seen.has(rel) || this.decls.has(rel) || !isSourcePath(rel)) return true;
      if (paths.length >= MAX_HIT_FILES) {
        truncated = true;
        return false;
      }
      seen.add(rel);
      paths.push(rel);
      return true;
    };
    let res: StreamResult | undefined;
    if (!this.rgMissing) {
      const args = ['-l', '-i', '--max-count', '1', '--null', '--no-messages', '--max-filesize', '512K', ...RG_GLOBS, '-e', `\\b${escapeRe(term)}\\w*`, '.'];
      res = await streamRecords(this.rg, args, this.root, '\0', onRecord, signal);
      if (res.missing) this.rgMissing = true;
    }
    if (this.rgMissing) {
      // git grep's regex dialect varies by platform, so it searches for the fixed string; the
      // declaration filter afterwards decides what actually matches.
      res = await streamRecords('git', ['grep', '-l', '-i', '-I', '-z', '-F', '-e', term, '--', ...GIT_PATHSPECS], this.root, '\0', onRecord, signal);
    }
    signal?.throwIfAborted();
    return { paths, truncated: truncated || !!res?.timedOut };
  }

  // Declarations whose name fuzzy-matches `query`, head side. `Owner.name` narrows by class.
  async symbols(query: string, opts: { signal?: AbortSignal; limit?: number; recent?: string[] } = {}): Promise<SymbolResults> {
    const { signal } = opts;
    const limit = opts.limit ?? 30;
    signal?.throwIfAborted();
    const q = query.trim();
    const dot = q.lastIndexOf('.');
    const ownerTerm = dot > 0 ? q.slice(0, dot) : '';
    const nameTerm = dot >= 0 ? q.slice(dot + 1) : q;
    const grepTerm = (nameTerm || ownerTerm).replace(/^\W+/, '');

    await this.parseChanged();
    signal?.throwIfAborted();
    let truncated = false;
    // Below two characters a grep would match nearly every file; use what is parsed already.
    if (grepTerm.length >= 2) {
      const hit = await this.grepFiles(grepTerm, signal);
      truncated = hit.truncated;
      for (const p of hit.paths) {
        signal?.throwIfAborted();
        await this.ensureParsed(p);
        await yieldToLoop(); // parsing is synchronous; let Ink render between files
      }
      signal?.throwIfAborted();
    }

    const recent = new Set(opts.recent ?? []);
    const nl = nameTerm.toLowerCase();
    const ranked: { hit: SymbolHit; score: number }[] = [];
    for (const decls of this.decls.values()) {
      for (const d of decls) {
        const owner = ownerOf(d.qualified);
        if (ownerTerm && (!owner || fuzzyScore(ownerTerm, owner) === undefined)) continue;
        const name = d.name.toLowerCase();
        const fz = fuzzyScore(nameTerm, d.name);
        if (fz === undefined) continue;
        // Match class dominates; the boosts only order within a class.
        const cls = !nl ? 1 : name === nl ? 4 : name.startsWith(nl) ? 3 : name.includes(nl) ? 2 : 1;
        let score = cls * 1000 + fz;
        if (d.name === nameTerm) score += 5;
        if (this.changed.has(d.file)) score += 60;
        if (recent.has(d.file)) score += 100; // the reviewer just used it
        if (d.exported) score += 20;
        ranked.push({
          score,
          hit: { name: d.name, qualified: d.qualified, kind: d.kind, file: d.file, startLine: d.startLine, endLine: d.endLine, exported: d.exported, ...(owner ? { owner } : {}) },
        });
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.hit.name.length - b.hit.name.length || (a.hit.file < b.hit.file ? -1 : a.hit.file > b.hit.file ? 1 : a.hit.startLine - b.hit.startLine));
    return Object.assign(
      ranked.slice(0, limit).map((r) => r.hit),
      { truncated },
    );
  }

  // Lines that mention `name` as a whole word, excluding its declarations and imports. These
  // are name matches, not resolved calls: a different symbol with the same name shows up too.
  async possibleCallers(name: string, opts: { signal?: AbortSignal; limit?: number } = {}): Promise<CallerHit[]> {
    const { signal } = opts;
    const limit = opts.limit ?? 20;
    signal?.throwIfAborted();
    // A name is a single identifier; anything else would not be a call site.
    if (!/^[\w$]+$/.test(name)) return [];
    const out: CallerHit[] = [];
    const onRecord = (rec: string) => {
      // rg --null: path\0line:text; git grep -z: path\0line\0text
      const m = /^([^\0]+)\0(\d+)[:\0](.*)$/s.exec(rec.replace(/\r?\n$/, ''));
      if (!m) return true;
      const file = relPath(m[1]);
      const line = Number(m[2]);
      const raw = m[3];
      if (!file || isDefinition(raw, name) || isImportLine(raw)) return true;
      if (this.decls.get(file)?.some((d) => d.name === name && d.startLine === line)) return true;
      out.push({ file, line, text: raw.trim().slice(0, MAX_TEXT) });
      return out.length < limit;
    };
    let res: StreamResult | undefined;
    if (!this.rgMissing) {
      const args = ['-n', '-w', '-F', '--null', '--no-messages', '--max-filesize', '512K', ...RG_GLOBS, '-e', name, '.'];
      res = await streamRecords(this.rg, args, this.root, '\n', onRecord, signal);
      if (res.missing) this.rgMissing = true;
    }
    if (this.rgMissing) {
      await streamRecords('git', ['grep', '-n', '-w', '-F', '-I', '-z', '-e', name, '--', ...GIT_PATHSPECS], this.root, '\n', onRecord, signal);
    }
    signal?.throwIfAborted();
    return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  }
}
