import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function installCodexSkill(options: { codexHome?: string; source?: string; force?: boolean } = {}): SkillInstallResult {
  const home = options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const source = options.source ?? fileURLToPath(new URL('../codex/guided-review/SKILL.md', import.meta.url));
  return installFile(source, path.join(home, 'skills', 'guided-review', 'SKILL.md'), { force: options.force });
}

export function installClaudeCommand(options: { home?: string; source?: string; force?: boolean } = {}): SkillInstallResult {
  const home = options.home ?? os.homedir();
  const source = options.source ?? fileURLToPath(new URL('../claude/guided-review.md', import.meta.url));
  return installFile(source, path.join(home, '.claude', 'commands', 'guided-review.md'), { force: options.force });
}
