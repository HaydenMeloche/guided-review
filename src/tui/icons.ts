// Optional Nerd Font file icons ("icons": "nerd" in config.json), before file paths in the chapter
// title, the PR preview's file list, the submit screen, and the theme preview. Off by default:
// whether the terminal's font has the glyphs can't be detected, and without them each shows as a box.

export type IconSetting = 'none' | 'nerd';

let enabled = false;

export function setIcons(setting: IconSetting): void {
  enabled = setting === 'nerd';
}

const BY_EXT: Record<string, string> = {
  ts: '',
  tsx: '',
  js: '',
  jsx: '',
  mjs: '',
  py: '',
  go: '',
  rs: '',
  rb: '',
  java: '',
  kt: '',
  c: '',
  h: '',
  cpp: '',
  cs: '',
  swift: '',
  php: '',
  md: '',
  json: '',
  yaml: '',
  yml: '',
  toml: '',
  sh: '',
  css: '',
  scss: '',
  html: '',
  sql: '',
  lock: '',
};
const BY_NAME: Record<string, string> = { Dockerfile: '', Makefile: '', 'package.json': '', '.gitignore': '' };
const FILE = '';

// The icon and a space before `path`, or nothing with icons off.
export function fileIcon(path: string): string {
  if (!enabled) return '';
  const name = path.split('/').at(-1) ?? path;
  const ext = name.includes('.') ? name.split('.').at(-1)!.toLowerCase() : '';
  return `${BY_NAME[name] ?? BY_EXT[ext] ?? FILE} `;
}
