import type { Hunk } from '../types.js';

// Hand-edited files that declare a project's dependencies (lockfiles are classified as generated).
export const DEPENDENCY_MANIFEST =
  /(^|\/)(package\.json|pom\.xml|build\.gradle(\.kts)?|libs\.versions\.toml|Cargo\.toml|go\.mod|pyproject\.toml|requirements[^/]*\.txt|Pipfile|Gemfile|composer\.json|Directory\.Packages\.props|packages\.config|Package\.swift|pubspec\.yaml|mix\.exs|build\.sbt)$|\.csproj$|\.gemspec$/;

export function isDependencyManifest(path: string): boolean {
  return DEPENDENCY_MANIFEST.test(path);
}

// A changed manifest line that looks like a dependency entry: "zod": "^3.22.0", zod = "1.0",
// require x v1.2, gem 'x', <version>1.2</version>, implementation 'g:a:1.2', x==1.2, PackageReference.
export const DEP_LINE =
  /^\s*"[@\w./-]+"\s*:\s*"(?:[\^~>=<*]|\d|workspace:|npm:|file:|link:|git)|^\s*[\w-]+\s*=\s*(?:"[\^~>=<*\d]|\{\s*version)|^\s*(?:require\s+)?[\w.-]+\/[\w./-]+\s+v\d|^\s*gem\s+['"]|<(?:version|artifactId)>|<Package(?:Reference|Version)\b|['"][\w.-]+:[\w.-]+:[\w.${}-]+['"]|^\s*[A-Za-z][\w.-]*(?:\[[\w,.-]+\])?\s*(?:==|>=|<=|~=|!=|>|<)\s*\d/;

export function isDependencyHunk(h: Hunk): boolean {
  return isDependencyManifest(h.file) && h.lines.some((l) => l.kind !== 'ctx' && DEP_LINE.test(l.text));
}

// Files that only pin a runtime or toolchain version.
export const TOOLCHAIN_FILE = /(^|\/)(\.nvmrc|\.node-version|\.python-version|\.ruby-version|\.java-version|\.go-version|\.terraform-version|\.tool-versions|\.sdkmanrc|rust-toolchain(\.toml)?)$/;

// Runtime and toolchain lines inside other files: a Docker base image, engines, the go directive,
// requires-python, the TypeScript target, the JVM level, rust-version, the .NET target framework.
const TOOLCHAIN_LINES: [RegExp, RegExp][] = [
  [/(^|\/)(Dockerfile|Containerfile)[^/]*$/, /^\s*FROM\s/i],
  [/(^|\/)package\.json$/, /^\s*"(node|npm|pnpm|yarn|bun|packageManager)"\s*:/],
  [/(^|\/)go\.(mod|work)$/, /^\s*(go|toolchain)\s+\S/],
  [/(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|Pipfile)$/, /requires-python|python_requires|python_version/],
  [/(^|\/)[jt]sconfig[^/]*\.json$/, /^\s*"(target|lib|module)"\s*:/],
  [
    /(^|\/)(build\.gradle(\.kts)?|pom\.xml|gradle\.properties)$/,
    /jvmToolchain|sourceCompatibility|targetCompatibility|JavaVersion\.|jvmTarget|<(maven\.compiler\.(source|target|release)|java\.version|release)>/,
  ],
  [/(^|\/)Cargo\.toml$/, /^\s*rust-version\s*=/],
  [/\.(csproj|fsproj|props)$/, /<TargetFrameworks?>/],
  [/(^|\/)Gemfile$|\.gemspec$/, /^\s*ruby\s+['"]|required_ruby_version/],
];

export function isToolchainHunk(h: Hunk): boolean {
  if (TOOLCHAIN_FILE.test(h.file)) return h.lines.some((l) => l.kind !== 'ctx');
  const rule = TOOLCHAIN_LINES.find(([file]) => file.test(h.file));
  return !!rule && h.lines.some((l) => l.kind !== 'ctx' && rule[1].test(l.text));
}
