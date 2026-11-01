import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexSkill, installCodexSkill, refreshInstalled } from '../src/codexSkill.js';

const homes: string[] = [];
function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-codex-skill-'));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('Codex skill installation', () => {
  it('installs a usable skill and can be repeated without changing it', () => {
    const home = temporaryHome();
    const first = installCodexSkill({ codexHome: home });
    expect(first.status).toBe('installed');
    expect(first.path).toBe(path.join(home, 'skills', 'guided-review', 'SKILL.md'));
    const installed = fs.readFileSync(first.path, 'utf8');
    expect(installed).toContain('name: guided-review');
    expect(installed).toContain('guided-review open --preview');
    expect(installed).not.toContain('gr review');

    const second = installCodexSkill({ codexHome: home });
    expect(second).toEqual({ path: first.path, status: 'already-installed' });
    expect(fs.readFileSync(first.path, 'utf8')).toBe(installed);
  });

  it('preserves a custom skill at the destination', () => {
    const home = temporaryHome();
    const target = path.join(home, 'skills', 'guided-review', 'SKILL.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'custom instructions\n');

    expect(() => installCodexSkill({ codexHome: home })).toThrow('already exists with different content');
    expect(fs.readFileSync(target, 'utf8')).toBe('custom instructions\n');
  });
});

describe('refreshing the installed skill after an update', () => {
  function shipped(contents: string) {
    const home = temporaryHome();
    const source = path.join(home, 'SKILL.source.md');
    fs.writeFileSync(source, contents);
    return { home, source, file: codexSkill({ codexHome: home, source }) };
  }

  it('brings the copy gr installed up to the new version', () => {
    const { home, source, file } = shipped('version one\n');
    installCodexSkill({ codexHome: home, source });
    fs.writeFileSync(source, 'version two\n');
    expect(refreshInstalled([file])).toEqual(['the Codex skill']);
    expect(fs.readFileSync(file.target, 'utf8')).toBe('version two\n');
    // Recorded again, so the next version replaces it too.
    fs.writeFileSync(source, 'version three\n');
    expect(refreshInstalled([file])).toEqual(['the Codex skill']);
    expect(refreshInstalled([file])).toEqual([]);
  });

  it('leaves an edited copy, and a missing one, alone', () => {
    const { home, source, file } = shipped('version one\n');
    expect(refreshInstalled([file])).toEqual([]);
    expect(fs.existsSync(file.target)).toBe(false);
    installCodexSkill({ codexHome: home, source });
    fs.writeFileSync(file.target, 'my own instructions\n');
    fs.writeFileSync(source, 'version two\n');
    expect(refreshInstalled([file])).toEqual([]);
    expect(fs.readFileSync(file.target, 'utf8')).toBe('my own instructions\n');
  });
});
