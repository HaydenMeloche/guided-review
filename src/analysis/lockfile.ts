import { changedCount } from '../diff/lines.js';
import type { Hunk } from '../types.js';

type Side = 'add' | 'del';
interface Event {
  name: string;
  version: string;
  side: Side;
}

// Lockfile name -> the manifest it locks.
export const LOCKFILE_MANIFESTS: Record<string, string> = {
  'package-lock.json': 'package.json',
  'npm-shrinkwrap.json': 'package.json',
  'pnpm-lock.yaml': 'package.json',
  'yarn.lock': 'package.json',
  'bun.lock': 'package.json',
  'Cargo.lock': 'Cargo.toml',
  'go.sum': 'go.mod',
  'poetry.lock': 'pyproject.toml',
  'uv.lock': 'pyproject.toml',
  'Gemfile.lock': 'Gemfile',
  'composer.lock': 'composer.json',
};

function base(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dir(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function isLockfile(path: string): boolean {
  return Object.hasOwn(LOCKFILE_MANIFESTS, base(path));
}

// Whether `path` is named like the manifest a lockfile of this kind locks.
export function locksManifest(lockfile: string, path: string): boolean {
  return LOCKFILE_MANIFESTS[base(lockfile)] === base(path);
}

// Lockfiles that also lock the manifests below them in a workspace. A go.sum, Gemfile.lock,
// composer.lock or poetry.lock belongs to its own directory's manifest only.
const WORKSPACE_LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'Cargo.lock', 'uv.lock']);

export interface LockfilePair {
  lockfile: string;
  manifests: string[];
}

// Each changed lockfile with the changed manifests it locks, by path. A manifest pairs with the
// lockfile in its own directory, else with the nearest workspace lockfile above it; so one
// lockfile can lock several manifests, and a manifest has at most one. Lockfiles that lock none
// of the manifests are left out.
export function pairLockfiles(lockfiles: string[], manifests: string[]): LockfilePair[] {
  const locks = [...new Set(lockfiles)].filter(isLockfile).sort();
  const byLock = new Map<string, string[]>();
  for (const m of [...new Set(manifests)].sort()) {
    const md = dir(m);
    let best: string | undefined;
    let depth = -1;
    for (const l of locks) {
      if (!locksManifest(l, m)) continue;
      const ld = dir(l);
      const above = ld !== md && WORKSPACE_LOCKFILES.has(base(l)) && (ld === '' || md.startsWith(`${ld}/`));
      if (ld !== md && !above) continue;
      // The nearest wins: the manifest's own directory is the deepest a lockfile can be.
      const d = ld === '' ? 0 : ld.split('/').length;
      if (d > depth) [best, depth] = [l, d];
    }
    if (best) byLock.set(best, [...(byLock.get(best) ?? []), m]);
  }
  return locks.filter((l) => byLock.has(l)).map((l) => ({ lockfile: l, manifests: byLock.get(l)! }));
}

// Walk hunk lines; `ctxName` tracks the package the next version line belongs to.
function collect(path: string, hunks: Hunk[]): Event[] {
  const events: Event[] = [];
  const b = base(path);
  for (const h of hunks) {
    let ctxName: string | undefined;
    for (const l of h.lines) {
      const t = l.text;
      const side: Side | undefined = l.kind === 'ctx' ? undefined : l.kind;
      let m: RegExpMatchArray | null;
      if (b === 'package-lock.json' || b === 'npm-shrinkwrap.json' || b === 'composer.lock') {
        if ((m = t.match(/^\s*"(?:.*node_modules\/)?((?:@[^/"]+\/)?[^/"]+)":\s*\{/)) && t.includes('node_modules/')) {
          ctxName = m[1];
        } else if ((m = t.match(/^\s*"name":\s*"([^"]+)"/))) {
          ctxName = m[1];
        } else if ((m = t.match(/^\s*"version":\s*"([^"]+)"/)) && side && ctxName) {
          events.push({ name: ctxName, version: m[1], side });
        }
      } else if (b === 'pnpm-lock.yaml') {
        // v6: "  /react@18.2.0:"  v9: "  react@18.2.0:"  v5: "  /react/18.2.0:"
        m = t.match(/^\s{2}'?\/?((?:@[^@/\s']+\/)?[^@/\s':]+)[@/](\d[^:'(\s]*)(?:\([^)]*\))*'?:\s*$/);
        if (m && side) events.push({ name: m[1], version: m[2], side });
      } else if (b === 'yarn.lock') {
        if ((m = t.match(/^"?((?:@[^@/\s"]+\/)?[^@\s",]+)@/)) && !t.startsWith(' ')) ctxName = m[1];
        else if ((m = t.match(/^\s+version:?\s+"?([^"\s]+)"?/)) && side && ctxName) {
          events.push({ name: ctxName, version: m[1], side });
        }
      } else if (b === 'go.sum') {
        if ((m = t.match(/^(\S+)\s+(v[^\s/]+)(?:\/go\.mod)?\s+h1:/)) && side) {
          events.push({ name: m[1], version: m[2], side });
        }
      } else if (b === 'Gemfile.lock') {
        if ((m = t.match(/^\s{4}([A-Za-z0-9_.-]+) \(([^)]+)\)\s*$/)) && side) {
          events.push({ name: m[1], version: m[2], side });
        }
      } else {
        // Cargo.lock, poetry.lock, uv.lock: name = "x" / version = "y"
        if ((m = t.match(/^\s*name\s*=\s*"([^"]+)"/))) ctxName = m[1];
        else if ((m = t.match(/^\s*version\s*=\s*"([^"]+)"/)) && side && ctxName) {
          events.push({ name: ctxName, version: m[1], side });
        }
      }
    }
  }
  return events;
}

function major(v: string): string {
  const parts = v.replace(/^[v^~=]/, '').split(/[.+-]/);
  // For 0.x, a minor change is breaking.
  if (parts[0] === '0' && parts.length > 1) return `0.${parts[1]}`;
  return parts[0] ?? v;
}

function list(names: string[], max = 4): string {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown}, …` : shown;
}

export interface LockfileChanges {
  added: { name: string; version: string }[];
  removed: { name: string; version: string }[];
  changed: { name: string; from: string; to: string; major: boolean }[];
}

// Packages added, removed and moved between versions, each sorted by name.
export function lockfileChanges(path: string, hunks: Hunk[]): LockfileChanges {
  const events = collect(path, hunks);
  const added = new Map<string, Set<string>>();
  const removed = new Map<string, Set<string>>();
  for (const e of events) {
    const m = e.side === 'add' ? added : removed;
    if (!m.has(e.name)) m.set(e.name, new Set());
    m.get(e.name)!.add(e.version);
  }
  const out: LockfileChanges = { added: [], removed: [], changed: [] };
  for (const [name, vs] of added) {
    const old = removed.get(name);
    if (!old) {
      out.added.push({ name, version: [...vs][0] });
      continue;
    }
    const oldV = [...old].filter((v) => !vs.has(v));
    const newV = [...vs].filter((v) => !old.has(v));
    if (!oldV.length || !newV.length) continue;
    out.changed.push({ name, from: oldV[0], to: newV[0], major: major(oldV[0]) !== major(newV[0]) });
  }
  for (const [name, vs] of removed) if (!added.has(name)) out.removed.push({ name, version: [...vs][0] });
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  out.added.sort(byName);
  out.removed.sort(byName);
  out.changed.sort(byName);
  return out;
}

export function summarizeLockfile(path: string, hunks: Hunk[]): string {
  const c = lockfileChanges(path, hunks);
  const addedOnly = c.added.map((p) => p.name);
  const removedOnly = c.removed.map((p) => p.name);
  const majors = c.changed.filter((p) => p.major).map((p) => `${p.name} ${p.from}→${p.to}`);
  const bumped = c.changed.length;

  const parts: string[] = [];
  if (addedOnly.length) parts.push(`+${addedOnly.length} added (${list(addedOnly)})`);
  if (removedOnly.length) parts.push(`-${removedOnly.length} removed (${list(removedOnly)})`);
  if (majors.length) parts.push(`major: ${list(majors, 5)}`);
  const minor = bumped - majors.length;
  if (minor > 0) parts.push(`${minor} minor/patch bump${minor === 1 ? '' : 's'}`);
  if (!parts.length) {
    const n = hunks.reduce((s, h) => s + changedCount(h), 0);
    return `lockfile: ${n} changed lines, no package changes detected`;
  }
  return parts.join(', ');
}

// One package's change in a lockfile, for listing: a major or a minor-or-patch version change
// (from → to), or an added or removed package (its version in `to` or `from`).
export interface PackageChange {
  name: string;
  change: 'major' | 'minor' | 'added' | 'removed';
  from?: string;
  to?: string;
}

// In the order they are listed: major changes, minor and patch changes, added, removed.
export function packageChanges(c: LockfileChanges): PackageChange[] {
  return [
    ...c.changed.filter((p) => p.major).map((p): PackageChange => ({ name: p.name, change: 'major', from: p.from, to: p.to })),
    ...c.changed.filter((p) => !p.major).map((p): PackageChange => ({ name: p.name, change: 'minor', from: p.from, to: p.to })),
    ...c.added.map((p): PackageChange => ({ name: p.name, change: 'added', to: p.version })),
    ...c.removed.map((p): PackageChange => ({ name: p.name, change: 'removed', from: p.version })),
  ];
}

// Package names compare loosely: Python treats case, "-", "_" and "." alike.
const looseName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

// The words on a hunk's changed lines that could name a package: "react" in "react": "^19.0.0",
// github.com/x/y in require github.com/x/y v1.2.0, requests in "requests>=2.31".
function changedNames(h: Hunk): Set<string> {
  const out = new Set<string>();
  for (const l of h.lines) {
    if (l.kind === 'ctx') continue;
    for (const w of l.text.split(/[^A-Za-z0-9@/._-]+/)) if (w) out.add(looseName(w));
  }
  return out;
}

export interface PairChanges {
  direct: Map<string, PackageChange[]>; // manifest hunk id -> the changes of the packages it names
  indirect: PackageChange[]; // the changes no manifest hunk names
  total: number;
}

// A lockfile's package changes split by the manifest hunks of its pair: the packages a hunk names
// are its direct changes (a package two manifests name is direct for both); the rest are indirect.
export function pairChanges(lockfile: string, lockHunks: Hunk[], manifestHunks: Hunk[]): PairChanges {
  const all = packageChanges(lockfileChanges(lockfile, lockHunks));
  const named = manifestHunks.map((h) => ({ id: h.id, names: changedNames(h) }));
  const direct = new Map<string, PackageChange[]>(named.map((n) => [n.id, []]));
  const indirect: PackageChange[] = [];
  for (const p of all) {
    const key = looseName(p.name);
    const hits = named.filter((n) => n.names.has(key));
    for (const n of hits) direct.get(n.id)!.push(p);
    if (!hits.length) indirect.push(p);
  }
  return { direct, indirect, total: all.length };
}
