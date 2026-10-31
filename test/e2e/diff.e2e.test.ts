import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixtureRepo, sandbox, startGr, type Sandbox, type Session } from './harness.js';

let box: Sandbox;
let repo: string;
const sessions: Session[] = [];

beforeEach(() => {
  box = sandbox();
  repo = fixtureRepo(box);
});
afterEach(() => {
  for (const s of sessions.splice(0)) s.kill();
  box.cleanup();
});

function gr(args: string[]): Session {
  const session = startGr(box, [...args, '--no-agent'], { cwd: repo });
  sessions.push(session);
  return session;
}

describe('gr diff and gr preview --base', () => {
  it('tours the working tree against a commit', async () => {
    const screen = await gr(['diff', 'HEAD~1']).waitFor('Chapters · Guided order');
    expect(screen).toContain('Changes since HEAD~1');
    expect(screen).toMatch(/0\/1 hunks done/);
  });

  it('tours two commits from a checkout of the second, leaving the working tree alone', async () => {
    fs.writeFileSync(path.join(repo, 'src/invoice.ts'), 'uncommitted\n');
    const screen = await gr(['diff', 'main..feature/discount']).waitFor('Chapters · Guided order');
    expect(screen).toContain('main..feature/discount');
    expect(screen).toMatch(/0\/1 hunks done/);
    const worktrees = path.join(box.env.GR_HOME!, 'worktrees');
    const copies = fs.readdirSync(worktrees).flatMap((r) => fs.readdirSync(path.join(worktrees, r)));
    expect(copies).toEqual([expect.stringMatching(/^pr-0-[0-9a-f]{8}$/)]);
    expect(fs.readFileSync(path.join(repo, 'src/invoice.ts'), 'utf8')).toBe('uncommitted\n');
  });

  it('compares the branch with another base', async () => {
    execFileSync('git', ['branch', 'parent', 'main'], { cwd: repo });
    const screen = await gr(['preview', '--base', 'parent']).waitFor('Chapters · Guided order');
    expect(screen).toContain('feature/discount (preview against parent)');
  });

  it('says which name is not a commit', async () => {
    const session = gr(['diff', 'nope']);
    await session.waitFor('no commit named "nope"');
    expect(await session.exited).not.toBe(0);
  });

  it('says when there is nothing to tour', async () => {
    const session = gr(['diff']);
    await session.waitFor('nothing to tour: the working tree has no changes against HEAD.');
    expect(await session.exited).not.toBe(0);
  });
});

describe('commit order', () => {
  it('cycles to Commit order on f, with a chapter per commit', async () => {
    fs.writeFileSync(path.join(repo, 'src/fees.ts'), 'export function fee(cents: number): number {\n  return Math.round(cents * 0.03);\n}\n');
    const commit = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e', '-c', 'commit.gpgsign=false', ...args], { cwd: repo });
    commit('add', '-A');
    commit('commit', '-qm', 'Charge a fee');
    const session = gr(['preview']);
    await session.waitFor('Chapters · Guided order');
    for (const order of ['Risk first', 'Small first', 'File', 'Commit']) {
      session.press('f');
      await session.waitFor(`Chapters · ${order} order`);
    }
    const screen = session.screen();
    expect(screen).toMatch(/1 · Apply a discount to invoice totals[\s\S]*2 · Charge a fee/);
    // And on round to the guided order.
    session.press('f');
    await session.waitFor('Chapters · Guided order');
  });
});
