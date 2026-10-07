// One table for every per-language decision: which parser reads a file, which tests pair with
// it by name, and how it is highlighted.

export type TreeSitterLang = 'python' | 'go' | 'kotlin' | 'c' | 'cpp' | 'java' | 'ruby' | 'rust';

export interface Language {
  id: string;
  // Sources and tests pair by file name only within a family. Data and markup have none, which
  // also marks them as not code.
  family?: string;
  treeSitter?: TreeSitterLang;
  shiki?: string;
}

const TABLE: [string[], Language][] = [
  [['ts', 'mts', 'cts'], { id: 'typescript', family: 'js', shiki: 'typescript' }],
  [['tsx'], { id: 'tsx', family: 'js', shiki: 'tsx' }],
  [['js', 'jsx', 'mjs', 'cjs'], { id: 'javascript', family: 'js', shiki: 'javascript' }],
  [['py'], { id: 'python', family: 'python', treeSitter: 'python', shiki: 'python' }],
  [['go'], { id: 'go', family: 'go', treeSitter: 'go', shiki: 'go' }],
  [['kt', 'kts'], { id: 'kotlin', family: 'jvm', treeSitter: 'kotlin', shiki: 'kotlin' }],
  [['java'], { id: 'java', family: 'jvm', treeSitter: 'java', shiki: 'java' }],
  [['scala'], { id: 'scala', family: 'jvm' }],
  [['cs'], { id: 'csharp', family: 'dotnet', shiki: 'csharp' }],
  [['swift'], { id: 'swift', family: 'swift', shiki: 'swift' }],
  [['c', 'h'], { id: 'c', family: 'c-family', treeSitter: 'c', shiki: 'c' }],
  [['cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx'], { id: 'cpp', family: 'c-family', treeSitter: 'cpp', shiki: 'cpp' }],
  [['rb'], { id: 'ruby', family: 'ruby', treeSitter: 'ruby', shiki: 'ruby' }],
  [['rs'], { id: 'rust', family: 'rust', treeSitter: 'rust', shiki: 'rust' }],
  [['php'], { id: 'php', family: 'php', shiki: 'php' }],
  [['sh', 'bash', 'zsh'], { id: 'shell', family: 'shell', shiki: 'bash' }],
  [['ex', 'exs'], { id: 'elixir', family: 'elixir' }],
  [['clj'], { id: 'clojure', family: 'clojure' }],
  [['lua'], { id: 'lua', family: 'lua', shiki: 'lua' }],
  [['dart'], { id: 'dart', family: 'dart' }],
  [['m', 'mm'], { id: 'objc', family: 'objc' }],
  [['json'], { id: 'json', shiki: 'json' }],
  [['jsonc'], { id: 'jsonc', shiki: 'jsonc' }],
  [['yaml', 'yml'], { id: 'yaml', shiki: 'yaml' }],
  [['toml'], { id: 'toml', shiki: 'toml' }],
  [['css'], { id: 'css', shiki: 'css' }],
  [['html', 'htm'], { id: 'html', shiki: 'html' }],
];

const BY_EXT = new Map(TABLE.flatMap(([exts, lang]) => exts.map((e) => [e, lang] as const)));
const CPP = BY_EXT.get('cpp')!;
// A .h header is C unless its source uses C++-only syntax.
const CPP_SYNTAX = /\b(class|namespace|template|constexpr)\b|::/;

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

// Pass the file's source to tell a C++ header from a C one.
export function languageOf(path: string, source?: string): Language | undefined {
  const ext = extOf(path);
  if (ext === 'h' && source !== undefined && CPP_SYNTAX.test(source)) return CPP;
  return BY_EXT.get(ext);
}

export function familyOf(path: string): string | undefined {
  return languageOf(path)?.family;
}

// The extensions of the matching languages as a regex alternation, e.g. `c|h|cc|cpp`.
export function extensionsWhere(match: (lang: Language) => boolean): string {
  return TABLE.filter(([, lang]) => match(lang))
    .flatMap(([exts]) => exts)
    .join('|');
}
