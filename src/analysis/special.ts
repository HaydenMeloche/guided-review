import { isDependencyHunk, isToolchainHunk } from './dependencies.js';
import { isLockfile } from './lockfile.js';
import type { ChapterKind, DiffFile, Hunk } from '../types.js';

// Chapters whose narration explains what a change means rather than restating the diff: the
// effect of a migration, what an upgrade brings, whether an API change breaks clients.
export type SpecialKind = Extract<ChapterKind, 'migrations' | 'api' | 'dependencies' | 'lockfiles' | 'infra' | 'ci'>;

// In tour order. Lockfiles start collapsed: they can hold thousands of hunks, read as one summary.
export const SPECIAL_CHAPTERS: { kind: SpecialKind; title: string; collapsed: boolean }[] = [
  { kind: 'migrations', title: 'Database migrations', collapsed: false },
  { kind: 'api', title: 'API contracts', collapsed: false },
  { kind: 'dependencies', title: 'Dependencies and runtimes', collapsed: false },
  { kind: 'lockfiles', title: 'Lockfile changes', collapsed: true },
  { kind: 'infra', title: 'Infrastructure', collapsed: false },
  { kind: 'ci', title: 'CI and workflows', collapsed: false },
];

const SPECIAL_SET = new Set<ChapterKind>(SPECIAL_CHAPTERS.map((c) => c.kind));
export function isSpecialKind(kind: ChapterKind): kind is SpecialKind {
  return SPECIAL_SET.has(kind);
}

// Whole files, by path; the first match wins.
const SPECIAL_PATHS: [SpecialKind, RegExp][] = [
  ['migrations', /(^|\/)(migrations?|migrate)\/|(^|\/)alembic\/versions\/|(^|\/)V\d+(_\d+)*__[^/]+\.sql$|(^|\/)db\/changelog\//],
  ['api', /(^|\/)(openapi|swagger|asyncapi)[^/]*\.(ya?ml|json)$|\.proto$|\.graphqls$|(^|\/)[^/]*schema[^/]*\.(graphql|gql)$|\.avsc$/],
  [
    'ci',
    /(^|\/)\.github\/(workflows|actions)\/|(^|\/)action\.ya?ml$|(^|\/)\.gitlab-ci\.yml$|(^|\/)\.gitlab\/ci\/|(^|\/)\.circleci\/|(^|\/)Jenkinsfile[^/]*$|(^|\/)\.buildkite\/|(^|\/)azure-pipelines[^/]*\.ya?ml$|(^|\/)\.travis\.yml$|(^|\/)bitbucket-pipelines\.yml$/,
  ],
  [
    'infra',
    /\.(tf|tfvars)$|(^|\/)terragrunt\.hcl$|(^|\/)(k8s|kubernetes|kube|helm|charts|manifests|deploy|deployment|infra|infrastructure)\/.*\.ya?ml$|(^|\/)(Chart|kustomization|values[^/]*)\.ya?ml$|(^|\/)(serverless|cloudformation|Pulumi)[^/]*\.ya?ml$/,
  ],
];

// Hand-written files only: a migration test stays with the tests, generated output stays generated.
const PATH_KINDS = new Set<DiffFile['kind']>(['logic', 'config']);

// The special chapter a hunk belongs to, if any.
export function specialKindOf(f: DiffFile, h: Hunk): SpecialKind | undefined {
  if (f.kind === 'generated' && isLockfile(f.path)) return 'lockfiles';
  if (!PATH_KINDS.has(f.kind)) return undefined;
  const byPath = SPECIAL_PATHS.find(([, re]) => re.test(f.path));
  if (byPath) return byPath[0];
  if (f.kind === 'config' && (isDependencyHunk(h) || isToolchainHunk(h))) return 'dependencies';
  return undefined;
}
