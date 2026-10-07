import { DEP_LINE } from './dependencies.js';
import { isLockfile, LOCKFILE_MANIFESTS } from './lockfile.js';
import { PROTOBUF_OUTPUT } from './patterns.js';
import type { DiffFile, Flag, Hunk } from '../types.js';

// A schema source and the generated outputs that should move with it.
interface SourceRule {
  source: RegExp;
  label: string;
  generated: RegExp; // a changed generated file matching this counts as regenerated output
}

const SOURCES: SourceRule[] = [
  { source: /\.(graphql|gql)$/, label: 'GraphQL schema', generated: /__generated__\/|\.generated\.|\.gen\.|graphql\.(ts|js|d\.ts)$|gql\.(ts|js)$|generated\// },
  { source: /\.proto$/, label: 'protobuf definition', generated: new RegExp(`${PROTOBUF_OUTPUT.source}|generated\\/`) },
  { source: /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/, label: 'OpenAPI spec', generated: /generated\/|\.gen\.|\.generated\.|__generated__\/|api-client|client\/|sdk\// },
  { source: /(^|\/)schema\.prisma$/, label: 'Prisma schema', generated: /prisma\/client|generated\/|migrations\// },
];

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
// Each manifest with the lockfiles that lock it.
const MANIFEST_LOCK: { manifest: string; locks: Set<string> }[] = [];
for (const [lock, manifest] of Object.entries(LOCKFILE_MANIFESTS)) {
  const entry = MANIFEST_LOCK.find((m) => m.manifest === manifest);
  if (entry) entry.locks.add(lock);
  else MANIFEST_LOCK.push({ manifest, locks: new Set([lock]) });
}

function dir(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function checkGeneratedSync(files: DiffFile[], hunks: Record<string, Hunk>): Flag[] {
  const flags: Flag[] = [];
  const generated = files.filter((f) => f.kind === 'generated' && !isLockfile(f.path));
  const hunkIdsOf = (fs: DiffFile[]) => fs.flatMap((f) => f.hunkIds);

  // Schema changed, generated output did not.
  const matchedGenerated = new Set<DiffFile>();
  const changedSources = new Map<SourceRule, DiffFile[]>();
  for (const rule of SOURCES) {
    const sources = files.filter((f) => rule.source.test(f.path) && f.kind !== 'generated');
    if (sources.length) changedSources.set(rule, sources);
    const outputs = generated.filter((f) => rule.generated.test(f.path));
    outputs.forEach((o) => matchedGenerated.add(o));
    if (sources.length && !outputs.length) {
      flags.push({
        kind: 'generated-out-of-sync',
        message: `${rule.label} changed (${sources.map((s) => s.path).join(', ')}) but no generated code changed with it`,
        hunkIds: hunkIdsOf(sources),
      });
    }
  }
  // Generated output whose possible sources (any rule it matches) all stayed put.
  const orphans = generated.filter((g) => {
    const rules = SOURCES.filter((r) => r.generated.test(g.path));
    return rules.length > 0 && !rules.some((r) => changedSources.has(r));
  });
  if (orphans.length) {
    flags.push({
      kind: 'generated-out-of-sync',
      message: `generated code changed without its source: ${orphans.map((o) => o.path).join(', ')}`,
      hunkIds: hunkIdsOf(orphans),
    });
  }

  // Generated output with an obvious source sibling (foo.gen.ts next to foo.ts, x.pb.go next to x.proto).
  for (const g of generated) {
    if (matchedGenerated.has(g)) continue;
    const m = g.path.match(/^(.*)\.(gen|generated)\.[a-z]+$/);
    if (!m) continue;
    const stem = m[1];
    const src = files.find((f) => f !== g && f.kind !== 'generated' && f.path.startsWith(stem + '.'));
    // Any hand-written change in the same directory may be the source under another name.
    const neighbour = files.some((f) => f.kind !== 'generated' && dir(f.path) === dir(g.path));
    if (!src && !neighbour) {
      flags.push({
        kind: 'generated-out-of-sync',
        message: `generated code changed without its source: ${g.path}`,
        hunkIds: g.hunkIds,
      });
    }
  }

  // Manifest vs lockfile.
  for (const r of MANIFEST_LOCK) {
    const manifests = files.filter((f) => base(f.path) === r.manifest);
    const locks = files.filter((f) => r.locks.has(base(f.path)));
    // Manifest edits that touch no dependency line (scripts, metadata) leave the lockfile alone.
    const depChange = manifests.some((f) => f.status !== 'deleted' && f.hunkIds.some((id) => hunks[id]?.lines.some((l) => l.kind !== 'ctx' && DEP_LINE.test(l.text))));
    if (manifests.length && depChange && !locks.length) {
      flags.push({
        kind: 'generated-out-of-sync',
        message: `${r.manifest} changed but no lockfile changed; if dependencies changed, the lockfile is stale`,
        hunkIds: hunkIdsOf(manifests),
      });
    }
    if (locks.length && !manifests.length) {
      flags.push({
        kind: 'info',
        message: `lockfile changed without ${r.manifest}: dependency versions moved within existing ranges`,
        hunkIds: hunkIdsOf(locks),
      });
    }
  }
  return flags;
}
