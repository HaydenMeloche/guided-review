import path from 'node:path';
import { createRequire } from 'node:module';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite';
import type { AgentRole } from '../agent/types.js';
import type { ChapterOrder, CodeRef, Draft, ReadState, SuggestionMeta, Tour } from '../types.js';
import type { QueuedReply, Triage } from '../review/feedback.js';
import { grHome } from '../paths.js';
import { KEEP_TOURS_PER_PR, TOUR_MAX_AGE_DAYS } from './retention.js';

export { KEEP_TOURS_PER_PR, TOUR_MAX_AGE_DAYS };

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

// What author mode saw on its last visit to a PR, for "since your last visit".
export interface FeedbackVisit {
  head: string;
  at: string;
  addressed: string[]; // thread ids probably addressed then
  comments: number; // review comments by others then
}

export interface Position {
  chapterId: string;
  hunkId?: string;
  order: ChapterOrder;
}

const SCHEMA_V1 = `
-- A tour is gzipped JSON: mostly hunk text, it shrinks about five times.
CREATE TABLE tours (
  repo TEXT NOT NULL, pr INTEGER NOT NULL, head TEXT NOT NULL,
  created_at TEXT NOT NULL, opened_at TEXT, tour BLOB NOT NULL,
  PRIMARY KEY (repo, pr, head)
);
CREATE INDEX tours_pr ON tours (repo, pr, created_at);
CREATE TABLE read_states (
  repo TEXT NOT NULL, pr INTEGER NOT NULL, content_hash TEXT NOT NULL, state TEXT NOT NULL,
  PRIMARY KEY (repo, pr, content_hash)
);
CREATE TABLE drafts (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, pr INTEGER NOT NULL, created_at TEXT NOT NULL, json TEXT NOT NULL
);
CREATE INDEX drafts_pr ON drafts (repo, pr, created_at);
CREATE TABLE positions (
  repo TEXT NOT NULL, pr INTEGER NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (repo, pr)
);
CREATE TABLE moves (
  repo TEXT NOT NULL, pr INTEGER NOT NULL, content_hash TEXT NOT NULL, chapter_id TEXT NOT NULL,
  PRIMARY KEY (repo, pr, content_hash)
);
CREATE TABLE checklist_confirms (
  repo TEXT NOT NULL, pr INTEGER NOT NULL, item_id TEXT NOT NULL, confirmed INTEGER NOT NULL,
  PRIMARY KEY (repo, pr, item_id)
);
-- Agent sessions live apart from tours, so remembering a Q&A session doesn't rewrite the whole tour.
CREATE TABLE agent_sessions (
  repo TEXT NOT NULL, pr INTEGER NOT NULL, head TEXT NOT NULL, role TEXT NOT NULL,
  session_id TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, pr, head, role)
);
`;

// Author mode: the author's triage of each thread, replies queued to send together, what the
// last visit saw, and the model's reading of the feedback.
const SCHEMA_V2 = `
CREATE TABLE thread_triage (
  repo TEXT NOT NULL, pr INTEGER NOT NULL, thread_id TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, pr, thread_id)
);
CREATE TABLE thread_replies (
  repo TEXT NOT NULL, pr INTEGER NOT NULL, thread_id TEXT NOT NULL, body TEXT NOT NULL, resolve INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (repo, pr, thread_id)
);
CREATE TABLE feedback_visits (
  repo TEXT NOT NULL, pr INTEGER NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (repo, pr)
);
CREATE TABLE feedback_model (
  repo TEXT NOT NULL, pr INTEGER NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (repo, pr)
);
`;

interface Row {
  [key: string]: unknown;
}

// Each entry moves the database from user_version i to i + 1. Append only;
// never edit a migration that has shipped.
const MIGRATIONS: ((db: DatabaseSyncType) => void)[] = [(db) => db.exec(SCHEMA_V1), (db) => db.exec(SCHEMA_V2)];

export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(db: DatabaseSyncType): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as Row).user_version);
  if (version > SCHEMA_VERSION) {
    throw new Error(`the Guided Review database is from a newer version of gr (schema ${version}, this gr knows ${SCHEMA_VERSION}). Upgrade gr.`);
  }
  for (let v = version; v < SCHEMA_VERSION; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read inside the lock in case another gr process migrated first.
      const current = Number((db.prepare('PRAGMA user_version').get() as Row).user_version);
      if (current === v) {
        MIGRATIONS[v](db);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

// SQLite trims the WAL back to this size after a checkpoint; a tour rewrite otherwise leaves it large.
export const JOURNAL_SIZE_LIMIT = 8 * 1024 * 1024;

// Tables holding one PR's reading state, cleared once the PR has no tours left. Unposted
// drafts and queued replies are kept: they are the user's own writing.
const PR_STATE_TABLES = ['read_states', 'positions', 'moves', 'checklist_confirms', 'thread_triage', 'feedback_visits', 'feedback_model'];

const packTour = (t: Tour): Uint8Array => gzipSync(JSON.stringify(t), { level: 1 });
const unpackTour = (blob: unknown): Tour => JSON.parse(gunzipSync(blob as Uint8Array).toString('utf8')) as Tour;

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

// Drafts are JSON, so a row from an older or newer build may hold refs this one cannot use.
// Those refs are dropped rather than failing the whole list; a draft without refs is untouched.
export function normalizeDraft(d: Draft): Draft {
  const raw = d as unknown as Record<string, unknown>;
  if ('refs' in raw && raw.refs !== undefined) {
    const refs = Array.isArray(raw.refs) ? (raw.refs as unknown[]) : [];
    const ok = refs.filter((r): r is CodeRef => {
      if (typeof r !== 'object' || r === null) return false;
      const x = r as Record<string, unknown>;
      return nonEmpty(x.id) && nonEmpty(x.path) && nonEmpty(x.commitSha) && nonEmpty(x.label) && !/\s/.test(x.label);
    });
    // Earlier builds kept a role, note and title on each ref for an evidence list; a ref is now
    // only a code reference's target, so those fields are dropped.
    const STALE = ['role', 'note', 'title'];
    const stale = ok.some((r) => STALE.some((k) => k in r));
    const clean = stale
      ? ok.map((r) => {
          const rest: Record<string, unknown> = { ...r };
          for (const k of STALE) delete rest[k];
          return rest as unknown as CodeRef;
        })
      : ok;
    if (stale || ok.length !== refs.length || !Array.isArray(raw.refs)) d = { ...d, refs: clean };
  }
  const meta = raw.suggestionMeta;
  if (meta !== undefined && (typeof meta !== 'object' || meta === null || !nonEmpty((meta as Record<string, unknown>).headSha))) {
    d = { ...d };
    delete d.suggestionMeta;
  } else if (meta !== undefined && 'plain' in meta) {
    // Earlier builds marked a suggestion kept as plain code after moving the comment; that move
    // is gone, so the normal rules decide how it posts.
    const rest: Record<string, unknown> = { ...meta };
    delete rest.plain;
    d = { ...d, suggestionMeta: rest as unknown as SuggestionMeta };
  }
  return d;
}

export class Store {
  private db: DatabaseSyncType;
  private statements = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(file: string = path.join(grHome(), 'gr.db')) {
    this.db = new DatabaseSync(file);
    // Takes effect only on a new database, before its first table; `gr cleanup` returns the free pages.
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    // Safe under WAL: a power loss can drop the last commits but never corrupts the database.
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT};`);
    migrate(this.db);
  }

  // Prepared once per SQL string and reused.
  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  // Runs fn in one write transaction; a call nested inside another joins the outer one.
  private tx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth++;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.txDepth--;
    }
  }

  schemaVersion(): number {
    return Number((this.stmt('PRAGMA user_version').get() as Row).user_version);
  }

  pragmas(): { journalMode: string; synchronous: number; autoVacuum: number; journalSizeLimit: number } {
    return {
      journalMode: String((this.db.prepare('PRAGMA journal_mode').get() as Row).journal_mode),
      synchronous: Number((this.db.prepare('PRAGMA synchronous').get() as Row).synchronous),
      autoVacuum: Number((this.db.prepare('PRAGMA auto_vacuum').get() as Row).auto_vacuum),
      journalSizeLimit: Number((this.db.prepare('PRAGMA journal_size_limit').get() as Row).journal_size_limit),
    };
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  // Saving also prunes this PR's older tours, so the table stays bounded between `gr cleanup` runs.
  saveTour(t: Tour, keep: number = KEEP_TOURS_PER_PR): void {
    const blob = packTour(t);
    this.tx(() => {
      this.stmt('INSERT OR REPLACE INTO tours (repo, pr, head, created_at, opened_at, tour) VALUES (?, ?, ?, ?, ?, ?)').run(t.repo, t.pr, t.headSha, t.createdAt, new Date().toISOString(), blob);
      this.prunePr(t.repo, t.pr, t.headSha, keep);
    });
  }

  // Keeps `keep` tours of one PR: the tour just saved (even an older head opened again)
  // and the most recently opened of the rest.
  private prunePr(repo: string, pr: number, savedHead: string, keep: number): number {
    const result = this.stmt(
      `DELETE FROM tours WHERE repo = ? AND pr = ? AND head != ? AND rowid NOT IN (
         SELECT rowid FROM tours WHERE repo = ? AND pr = ? AND head != ? ORDER BY COALESCE(opened_at, created_at) DESC, rowid DESC LIMIT ?
       )`,
    ).run(repo, pr, savedHead, repo, pr, savedHead, Math.max(0, keep - 1));
    const removed = Number(result.changes);
    if (removed) this.stmt('DELETE FROM agent_sessions WHERE repo = ? AND pr = ? AND head NOT IN (SELECT head FROM tours WHERE repo = ? AND pr = ?)').run(repo, pr, repo, pr);
    return removed;
  }

  // Keeps the `keep` most recently opened tours (one per head) for each PR and deletes the rest.
  pruneTours(keep: number = KEEP_TOURS_PER_PR): number {
    return this.tx(() => {
      const removed = Number(
        this.stmt(
          `DELETE FROM tours WHERE rowid IN (
             SELECT rowid FROM (
               SELECT rowid, ROW_NUMBER() OVER (PARTITION BY repo, pr ORDER BY COALESCE(opened_at, created_at) DESC, rowid DESC) AS n FROM tours
             ) WHERE n > ?
           )`,
        ).run(keep).changes,
      );
      if (removed) this.dropOrphanSessions();
      return removed;
    });
  }

  // `gr cleanup`: deletes tours not opened within `maxAgeDays`, then the reading state and posted
  // drafts of PRs with no tour left, and returns the freed pages to the file system.
  pruneStale(maxAgeDays: number = TOUR_MAX_AGE_DAYS, now: Date = new Date()): { tours: number; prs: number } {
    const cutoff = new Date(now.getTime() - maxAgeDays * 86_400_000).toISOString();
    const result = this.tx(() => {
      const tours = Number(this.stmt('DELETE FROM tours WHERE COALESCE(opened_at, created_at) < ?').run(cutoff).changes);
      if (tours) this.dropOrphanSessions();
      const orphan = (table: string) => `NOT EXISTS (SELECT 1 FROM tours t WHERE t.repo = ${table}.repo AND t.pr = ${table}.pr)`;
      const prs = new Set<string>();
      for (const table of [...PR_STATE_TABLES, 'drafts']) {
        const where = table === 'drafts' ? `${orphan(table)} AND json_extract(json, '$.posted') = 1` : orphan(table);
        const rows = this.stmt(`DELETE FROM ${table} WHERE ${where} RETURNING repo, pr`).all() as Row[];
        for (const r of rows) prs.add(`${r.repo as string}#${r.pr as number}`);
      }
      return { tours, prs: prs.size };
    });
    this.db.exec('PRAGMA incremental_vacuum;');
    return result;
  }

  private dropOrphanSessions(): void {
    this.stmt('DELETE FROM agent_sessions WHERE NOT EXISTS (SELECT 1 FROM tours t WHERE t.repo = agent_sessions.repo AND t.pr = agent_sessions.pr AND t.head = agent_sessions.head)').run();
  }

  saveSession(repo: string, pr: number, head: string, role: AgentRole, sessionId: string): void {
    this.stmt('INSERT OR REPLACE INTO agent_sessions (repo, pr, head, role, session_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(repo, pr, head, role, sessionId, new Date().toISOString());
  }

  loadSessions(repo: string, pr: number, head: string): Partial<Record<AgentRole, string>> {
    const rows = this.stmt('SELECT role, session_id FROM agent_sessions WHERE repo = ? AND pr = ? AND head = ?').all(repo, pr, head) as Row[];
    return Object.fromEntries(rows.map((r) => [r.role as string, r.session_id as string]));
  }

  loadTour(repo: string, pr: number, headSha: string): Tour | undefined {
    const row = this.stmt('UPDATE tours SET opened_at = ? WHERE repo = ? AND pr = ? AND head = ? RETURNING tour').get(new Date().toISOString(), repo, pr, headSha) as Row | undefined;
    return row ? unpackTour(row.tour) : undefined;
  }

  latestTour(repo: string, pr: number, excludeHead?: string): Tour | undefined {
    const row = this.stmt('SELECT tour FROM tours WHERE repo = ? AND pr = ? AND head != ? ORDER BY created_at DESC LIMIT 1').get(repo, pr, excludeHead ?? '') as Row | undefined;
    return row ? unpackTour(row.tour) : undefined;
  }

  listTours(repo: string, pr: number): { headSha: string; createdAt: string }[] {
    const rows = this.stmt('SELECT head, created_at FROM tours WHERE repo = ? AND pr = ? ORDER BY created_at DESC').all(repo, pr) as Row[];
    return rows.map((r) => ({ headSha: r.head as string, createdAt: r.created_at as string }));
  }

  getReadStates(repo: string, pr: number): Record<string, ReadState> {
    const rows = this.stmt('SELECT content_hash, state FROM read_states WHERE repo = ? AND pr = ?').all(repo, pr) as Row[];
    return Object.fromEntries(rows.map((r) => [r.content_hash as string, r.state as ReadState]));
  }

  setReadState(repo: string, pr: number, contentHash: string, state: ReadState): void {
    if (state === 'unread') {
      this.stmt('DELETE FROM read_states WHERE repo = ? AND pr = ? AND content_hash = ?').run(repo, pr, contentHash);
      return;
    }
    this.stmt('INSERT OR REPLACE INTO read_states (repo, pr, content_hash, state) VALUES (?, ?, ?, ?)').run(repo, pr, contentHash, state);
  }

  // Many hunks at once, as one transaction: a lockfile's summary can stand for thousands.
  setReadStates(repo: string, pr: number, contentHashes: string[], state: ReadState): void {
    this.tx(() => {
      for (const hash of contentHashes) this.setReadState(repo, pr, hash, state);
    });
  }

  listDrafts(repo: string, pr: number): Draft[] {
    const rows = this.stmt('SELECT json FROM drafts WHERE repo = ? AND pr = ? ORDER BY created_at').all(repo, pr) as Row[];
    return rows.map((r) => normalizeDraft(JSON.parse(r.json as string) as Draft));
  }

  saveDraft(d: Draft): void {
    this.stmt(
      `INSERT INTO drafts (id, repo, pr, created_at, json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
    ).run(d.id, d.repo, d.pr, d.createdAt, JSON.stringify(d));
  }

  saveDrafts(ds: Draft[]): void {
    this.tx(() => {
      for (const d of ds) this.saveDraft(d);
    });
  }

  deleteDraft(id: string): void {
    this.stmt('DELETE FROM drafts WHERE id = ?').run(id);
  }

  markPosted(ids: string[]): void {
    this.stmt(`UPDATE drafts SET json = json_set(json, '$.posted', json('true')) WHERE id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(ids));
  }

  getPosition(repo: string, pr: number): Position | undefined {
    const row = this.stmt('SELECT json FROM positions WHERE repo = ? AND pr = ?').get(repo, pr) as Row | undefined;
    return row ? (JSON.parse(row.json as string) as Position) : undefined;
  }

  setPosition(repo: string, pr: number, pos: Position): void {
    this.stmt('INSERT OR REPLACE INTO positions (repo, pr, json) VALUES (?, ?, ?)').run(repo, pr, JSON.stringify(pos));
  }

  getMoves(repo: string, pr: number): Record<string, string> {
    const rows = this.stmt('SELECT content_hash, chapter_id FROM moves WHERE repo = ? AND pr = ?').all(repo, pr) as Row[];
    return Object.fromEntries(rows.map((r) => [r.content_hash as string, r.chapter_id as string]));
  }

  setMove(repo: string, pr: number, contentHash: string, chapterId: string): void {
    this.stmt('INSERT OR REPLACE INTO moves (repo, pr, content_hash, chapter_id) VALUES (?, ?, ?, ?)').run(repo, pr, contentHash, chapterId);
  }

  getChecklistConfirms(repo: string, pr: number): Record<string, boolean> {
    const rows = this.stmt('SELECT item_id, confirmed FROM checklist_confirms WHERE repo = ? AND pr = ?').all(repo, pr) as Row[];
    return Object.fromEntries(rows.map((r) => [r.item_id as string, Number(r.confirmed) === 1]));
  }

  setChecklistConfirm(repo: string, pr: number, itemId: string, confirmed: boolean): void {
    this.stmt('INSERT OR REPLACE INTO checklist_confirms (repo, pr, item_id, confirmed) VALUES (?, ?, ?, ?)').run(repo, pr, itemId, confirmed ? 1 : 0);
  }

  getTriage(repo: string, pr: number): Record<string, Triage> {
    const rows = this.stmt('SELECT thread_id, state FROM thread_triage WHERE repo = ? AND pr = ?').all(repo, pr) as Row[];
    return Object.fromEntries(rows.map((r) => [r.thread_id as string, r.state as Triage]));
  }

  setTriage(repo: string, pr: number, threadId: string, state: Triage | undefined): void {
    if (!state) {
      this.stmt('DELETE FROM thread_triage WHERE repo = ? AND pr = ? AND thread_id = ?').run(repo, pr, threadId);
      return;
    }
    this.stmt('INSERT OR REPLACE INTO thread_triage (repo, pr, thread_id, state, updated_at) VALUES (?, ?, ?, ?, ?)').run(repo, pr, threadId, state, new Date().toISOString());
  }

  listReplies(repo: string, pr: number): QueuedReply[] {
    const rows = this.stmt('SELECT thread_id, body, resolve, updated_at FROM thread_replies WHERE repo = ? AND pr = ? ORDER BY updated_at').all(repo, pr) as Row[];
    return rows.map((r) => ({ threadId: r.thread_id as string, body: r.body as string, resolve: Number(r.resolve) === 1, updatedAt: r.updated_at as string }));
  }

  // An empty body removes the queued reply.
  saveReply(repo: string, pr: number, reply: Omit<QueuedReply, 'updatedAt'>): void {
    if (!reply.body.trim()) return this.deleteReplies(repo, pr, [reply.threadId]);
    this.stmt('INSERT OR REPLACE INTO thread_replies (repo, pr, thread_id, body, resolve, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      repo,
      pr,
      reply.threadId,
      reply.body,
      reply.resolve ? 1 : 0,
      new Date().toISOString(),
    );
  }

  deleteReplies(repo: string, pr: number, threadIds: string[]): void {
    this.stmt('DELETE FROM thread_replies WHERE repo = ? AND pr = ? AND thread_id IN (SELECT value FROM json_each(?))').run(repo, pr, JSON.stringify(threadIds));
  }

  getVisit(repo: string, pr: number): FeedbackVisit | undefined {
    const row = this.stmt('SELECT json FROM feedback_visits WHERE repo = ? AND pr = ?').get(repo, pr) as Row | undefined;
    return row ? (JSON.parse(row.json as string) as FeedbackVisit) : undefined;
  }

  setVisit(repo: string, pr: number, visit: FeedbackVisit): void {
    this.stmt('INSERT OR REPLACE INTO feedback_visits (repo, pr, json) VALUES (?, ?, ?)').run(repo, pr, JSON.stringify(visit));
  }

  // The model's reading of the feedback, kept while the threads it read stay the same (`key`).
  getFeedbackModel<T>(repo: string, pr: number, key: string): T | undefined {
    const row = this.stmt('SELECT json FROM feedback_model WHERE repo = ? AND pr = ? AND key = ?').get(repo, pr, key) as Row | undefined;
    return row ? (JSON.parse(row.json as string) as T) : undefined;
  }

  setFeedbackModel(repo: string, pr: number, key: string, value: unknown): void {
    this.stmt('INSERT OR REPLACE INTO feedback_model (repo, pr, key, json) VALUES (?, ?, ?, ?)').run(repo, pr, key, JSON.stringify(value));
  }
}
