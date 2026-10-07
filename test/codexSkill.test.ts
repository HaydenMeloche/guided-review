import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installCodexSkill } from '../src/codexSkill.js';

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
    expect(installed).toContain('gr review <number-or-URL>');

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
