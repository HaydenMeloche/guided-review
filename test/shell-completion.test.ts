import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { COMMANDS, completionScript, completionText, SHELLS } from '../src/shellCompletion.js';

describe('shell completion', () => {
  it('completes every command gr --help lists', () => {
    const cli = fs.readFileSync(path.resolve(import.meta.dirname, '../src/cli.tsx'), 'utf8');
    const listed = new Set([...cli.matchAll(/usage\('([\w-]+)/g)].map((m) => m[1]));
    expect(new Set(COMMANDS.map((c) => c.name))).toEqual(listed);
  });

  it('completes both names gr is installed as', () => {
    for (const shell of SHELLS) {
      const script = completionScript(shell, ['gr', 'guided-review']);
      expect(script).toContain('guided-review');
      expect(script).toContain('__complete prs');
    }
  });

  it('makes a PR title one plain line', () => {
    expect(completionText('Fix\tthe\nthing \u001b[31mnow\u0007')).toBe('Fix the thing [31mnow');
  });
});
