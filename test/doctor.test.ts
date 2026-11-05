import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnose, formatFindings, type DoctorDeps, type Run } from '../src/doctor.js';

// A machine with everything, unless a test says otherwise.
function deps(over: Partial<DoctorDeps> & { missing?: string[]; ghUser?: string } = {}): DoctorDeps {
  const run: Run = async (cmd, args) => {
    if (over.missing?.includes(cmd)) return { ok: false, out: '', missing: true };
    if (cmd === 'gh' && args[0] === 'api') return over.ghUser === '' ? { ok: false, out: 'not logged in' } : { ok: true, out: over.ghUser ?? 'octocat' };
    return { ok: true, out: `${cmd} version 2.47.1` };
  };
  return {
    run,
    env: { PATH: '', TMUX: '1', VISUAL: '/bin/sh' },
    platform: 'linux',
    nodeVersion: '22.14.0',
    home: '/nonexistent/gr-home',
    grammars: async () => ({ loaded: ['python', 'go'], all: ['python', 'go'] }),
    colorDepth: () => 'truecolor',
    models: async () => [{ model: 'claude-haiku-5-5', ok: true, ms: 1800 }],
    githubToken: () => undefined,
    viewer: async () => 'octocat',
    configProblem: () => undefined,
    noModel: 'none',
    ...over,
  };
}

const byName = async (d: DoctorDeps) => Object.fromEntries((await diagnose(d)).map((f) => [f.name, f]));

describe('gr doctor', () => {
  it('passes a machine with everything', async () => {
    const f = await byName(deps());
    expect(f.node.status).toBe('ok');
    expect(f.gh).toMatchObject({ status: 'ok', detail: '2.47.1 · signed in as octocat' });
    expect(f.model).toMatchObject({ status: 'ok', detail: 'claude-haiku-5-5 answered in 1.8s' });
    expect(f['gr open'].detail).toContain('tmux');
  });

  it('fails what gr needs and warns about what makes it worse, each with a fix', async () => {
    const d = deps({ missing: ['rg', 'gh'], nodeVersion: '22.12.0', colorDepth: () => '256', grammars: async () => ({ loaded: ['go'], all: ['python', 'go'] }) });
    const f = await byName(d);
    expect(f.node).toMatchObject({ status: 'fail', fix: 'install Node 22.13 or newer' });
    expect(f.gh).toMatchObject({ status: 'fail', fix: expect.stringContaining('cli.github.com') });
    expect(f.rg).toMatchObject({ status: 'warn', fix: expect.stringContaining('ripgrep') });
    expect(f['tree-sitter']).toMatchObject({ status: 'warn', detail: expect.stringContaining('python fall back') });
    expect(f.colors.status).toBe('warn');
    // No clipboard tool on this PATH.
    expect(f.clipboard.status).toBe('warn');
    const text = formatFindings(await diagnose(d), false);
    expect(text).toContain(' ✗ gh');
    expect(text).toContain(' ! rg');
    expect(text).toMatch(/2 problems to fix\n$/);
  });

  it('says how to sign in when gh is signed out, and brew on macOS', async () => {
    const f = await byName(deps({ ghUser: '', platform: 'darwin', missing: ['rg'], env: { PATH: '', VISUAL: '/bin/sh' } }));
    expect(f.gh).toMatchObject({ status: 'fail', fix: 'gh auth login' });
    expect(f.rg.fix).toBe('brew install ripgrep');
    expect(f['gr open'].detail).toContain('Terminal');
  });

  it('checks a configured token instead of gh', async () => {
    const ok = await byName(deps({ missing: ['gh'], githubToken: () => '$GITHUB_TOKEN' }));
    expect(ok.GitHub).toMatchObject({ status: 'ok', detail: 'token from $GITHUB_TOKEN · signed in as octocat' });
    const refused = await byName(deps({ githubToken: () => '$GITHUB_TOKEN', viewer: async () => Promise.reject(new Error('401 Bad credentials')) }));
    expect(refused.GitHub).toMatchObject({ status: 'fail', detail: expect.stringContaining('401 Bad credentials') });
    const unset = await byName(
      deps({
        githubToken: () => {
          throw new Error('the GitHub token variable $GITHUB_TOKEN is not set');
        },
      }),
    );
    expect(unset.GitHub.status).toBe('fail');
  });

  it('reports a model that does not answer, an unusable config, and no model at all', async () => {
    expect((await byName(deps({ models: async () => [{ model: 'gpt-x', ok: false, ms: 50, error: '401' }] }))).model).toMatchObject({ status: 'fail', detail: 'gpt-x: 401', fix: 'gr config' });
    expect((await byName(deps({ configProblem: () => 'no "provider"' }))).config).toMatchObject({ status: 'fail', fix: 'gr config' });
    expect((await byName(deps({ models: async () => undefined, noModel: 'not set up yet' }))).model).toMatchObject({ status: 'ok', detail: 'not set up yet' });
  });

  it('warns when no editor is set', async () => {
    expect((await byName(deps({ env: { PATH: '' } }))).editor).toMatchObject({ status: 'warn', fix: 'set $EDITOR' });
  });

  it("suggests a clones scan once gr's own clones grow large", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-doctor-'));
    try {
      expect((await byName(deps({ home }))).clones).toMatchObject({ status: 'ok', detail: 'none of your clones known yet', fix: undefined });
      fs.writeFileSync(path.join(home, 'clones.json'), JSON.stringify({ 'org/app': '/code/app' }));
      fs.mkdirSync(path.join(home, 'repos', 'org__big.git'), { recursive: true });
      // Sparse: counts toward the size without taking the disk space.
      const pack = path.join(home, 'repos', 'org__big.git', 'pack');
      fs.writeFileSync(pack, '');
      fs.truncateSync(pack, 150e6);
      const f = (await byName(deps({ home }))).clones;
      expect(f).toMatchObject({ status: 'ok', detail: 'using 1 of your clones · 1 downloaded by gr (150 MB)' });
      expect(f.fix).toContain('gr config --clones');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
