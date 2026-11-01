import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grHome } from './paths.js';

export type SkillInstallResult = { path: string; status: 'installed' | 'already-installed' | 'replaced' };

// Copies source to target without clobbering a file the user may have edited:
// an identical file is left alone, and a different one is refused unless force.
export function installFile(source: string, target: string, options: { force?: boolean } = {}): SkillInstallResult {
  const contents = fs.readFileSync(source);
  let replacing = false;

  try {
    const existing = fs.lstatSync(target);
    if (!existing.isFile()) throw new Error(`${target} already exists and is not a regular file.`);
    if (fs.readFileSync(target).equals(contents)) return { path: target, status: 'already-installed' };
    if (!options.force) {
      throw new Error(`${target} already exists with different content. Move or remove it, or pass --force to replace it.`);
    }
    replacing = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (replacing) {
    fs.copyFileSync(source, target);
    return { path: target, status: 'replaced' };
  }
  try {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (fs.readFileSync(target).equals(contents)) return { path: target, status: 'already-installed' };
    throw new Error(`${target} was created with different content. Move or remove it before installing.`, { cause: error });
  }
  return { path: target, status: 'installed' };
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

// Each installed file and the hash of what gr wrote there, so a later gr can tell its own copy
// from one the user edited.
const recordFile = () => path.join(grHome(), 'installed-files.json');

function readRecord(): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(recordFile(), 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function record(target: string, contents: Buffer): void {
  try {
    fs.writeFileSync(recordFile(), `${JSON.stringify({ ...readRecord(), [target]: sha256(contents) }, null, 2)}\n`);
  } catch {
    // unrecorded, the file is still refreshed while it matches a version gr shipped
  }
}

// Every version of these files gr shipped before installs were recorded.
const SHIPPED = new Set([
  'f6b29c145cef13e446d32aa4c36660e4093fb7d0f2a86febef50bbf6777f76e9', // claude/guided-review.md
  'e7c482a33fe6fab0587a461a60b36aea0ed773d15cc1d3a9b51c4fa820585b9a', // codex/guided-review/SKILL.md
]);

interface Shipped {
  what: string;
  source: string;
  target: string;
}

const codexSkill = (options: { codexHome?: string; source?: string } = {}): Shipped => ({
  what: 'the Codex skill',
  source: options.source ?? fileURLToPath(new URL('../codex/guided-review/SKILL.md', import.meta.url)),
  target: path.join(options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'skills', 'guided-review', 'SKILL.md'),
});

const claudeCommand = (options: { home?: string; source?: string } = {}): Shipped => ({
  what: 'the /guided-review command in Claude Code',
  source: options.source ?? fileURLToPath(new URL('../claude/guided-review.md', import.meta.url)),
  target: path.join(options.home ?? os.homedir(), '.claude', 'commands', 'guided-review.md'),
});

function installShipped(file: Shipped, force?: boolean): SkillInstallResult {
  const result = installFile(file.source, file.target, { force });
  record(file.target, fs.readFileSync(file.source));
  return result;
}

export function installCodexSkill(options: { codexHome?: string; source?: string; force?: boolean } = {}): SkillInstallResult {
  return installShipped(codexSkill(options), options.force);
}

export function installClaudeCommand(options: { home?: string; source?: string; force?: boolean } = {}): SkillInstallResult {
  return installShipped(claudeCommand(options), options.force);
}

// Brings the installed command and skill up to this version of gr, leaving alone any the user
// edited: only a file gr wrote, or one matching a version gr shipped, is replaced. Returns what
// it updated, to be said.
export function refreshInstalled(files: Shipped[] = [claudeCommand(), codexSkill()]): string[] {
  const recorded = readRecord();
  const updated: string[] = [];
  for (const file of files) {
    try {
      const installed = fs.readFileSync(file.target);
      const contents = fs.readFileSync(file.source);
      if (installed.equals(contents)) continue;
      const hash = sha256(installed);
      if (hash !== recorded[file.target] && !SHIPPED.has(hash)) continue;
      fs.writeFileSync(file.target, contents);
      record(file.target, contents);
      updated.push(file.what);
    } catch {
      // not installed, or not readable: nothing to refresh
    }
  }
  return updated;
}

export { claudeCommand, codexSkill };
