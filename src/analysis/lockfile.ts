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

export function isLockfile(path: string): boolean {
  return Object.hasOwn(LOCKFILE_MANIFESTS, base(path));
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

interface LockfileChanges {
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
