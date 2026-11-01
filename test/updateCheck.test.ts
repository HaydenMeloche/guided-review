import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_INTERVAL_MS,
  compareVersions,
  detectOrigin,
  detectPackageManager,
  globalInstaller,
  npmPrefix,
  installedVersion,
  fetchReleaseNotes,
  newerRelease,
  promptForUpdate,
  startUpdateCheck,
  updateCheckDisabled,
  updateNow,
  versionToNotify,
  type Installer,
  type Spawn,
  type UpdateCheckOptions,
  type UpdateOffer,
  type UpdateResult,
} from '../src/updateCheck.js';

const dirs: string[] = [];
function cacheFile(contents?: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-update-'));
  dirs.push(dir);
  const file = path.join(dir, 'update-check.json');
  if (contents) fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
function fakeInstaller(over: Partial<Installer> = {}): Installer {
  return {
    name: 'pnpm',
    command: ['pnpm', ['add', '-g', '@haydenmeloche/guided-review@latest']],
    current: async () => ({ version: '0.2.0' }),
    relaunch: (args) => ({ command: '/bin/guided-review', args, env: { PATH: '/bin' } }),
    ...over,
  };
}
const npm = fakeInstaller({ name: 'npm', command: ['npm', ['install', '-g', '@haydenmeloche/guided-review@latest']] });
// npm's abbreviated package document, with the latest version and any deprecated ones.
const registry = (latest: string, deprecated: Record<string, string> = {}) =>
  vi.fn(
    async () =>
      new Response(
        JSON.stringify({ 'dist-tags': { latest }, versions: Object.fromEntries([latest, ...Object.keys(deprecated)].map((v) => [v, deprecated[v] ? { deprecated: deprecated[v] } : {}])) }),
        {
          status: 200,
        },
      ),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
function check(overrides: UpdateCheckOptions) {
  return startUpdateCheck({ env: {}, interactive: true, installed: '0.1.0', origin: npm, now: () => NOW, ...overrides });
}

describe('compareVersions', () => {
  it('orders release versions numerically', () => {
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.2.3', 'v1.2.3')).toBe(0);
    expect(compareVersions('1.2.3+build.5', '1.2.3')).toBe(0);
  });

  it('ranks prereleases below their release and by identifier', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.11')).toBe(-1);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
  });

  it('returns undefined for malformed input', () => {
    for (const bad of ['', '1.2', '1.2.3.4', 'latest', '1.x.0', '01.2.3-', 'v']) expect(compareVersions(bad, '1.0.0')).toBeUndefined();
  });
});

describe('newerRelease', () => {
  it('suggests only a newer full release', () => {
    expect(newerRelease('0.1.0', '0.2.0')).toBe('0.2.0');
    expect(newerRelease('0.2.0', '0.2.0')).toBeUndefined();
    expect(newerRelease('0.3.0', '0.2.0')).toBeUndefined();
    expect(newerRelease('0.1.0', '0.2.0-beta.1')).toBeUndefined();
    expect(newerRelease('0.2.0-beta.1', '0.2.0')).toBe('0.2.0');
    expect(newerRelease('0.1.0', 'garbage')).toBeUndefined();
    expect(newerRelease('0.1.0', undefined)).toBeUndefined();
  });

  it('respects a skipped version until a newer one appears', () => {
    expect(newerRelease('0.1.0', '0.2.0', '0.2.0')).toBeUndefined();
    expect(newerRelease('0.1.0', '0.3.0', '0.2.0')).toBe('0.3.0');
  });
});

it('reads the installed version from package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(installedVersion()).toBe(pkg.version);
});

describe('startUpdateCheck', () => {
  it('skips the network under CI, GR_NO_UPDATE_CHECK, NODE_ENV=test, or without a terminal', async () => {
    expect(updateCheckDisabled({})).toBe(false);
    for (const env of [{ CI: 'true' }, { GR_NO_UPDATE_CHECK: '1' }, { NODE_ENV: 'test' }]) {
      expect(updateCheckDisabled(env)).toBe(true);
      const fetchImpl = registry('9.9.9');
      const file = cacheFile({ latest: '9.9.9', checkedAt: NOW });
      expect(await check({ env, fetch: fetchImpl, cacheFile: file }).finish(50)).toBeUndefined();
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    const fetchImpl = registry('9.9.9');
    expect(await check({ interactive: false, fetch: fetchImpl, cacheFile: cacheFile() }).finish(50)).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches with no cache, caches the result, and reports a fetch that finished', async () => {
    const fetchImpl = registry('0.2.0');
    const file = cacheFile();
    const notice = await check({ fetch: fetchImpl, cacheFile: file }).finish(1000);
    expect(notice).toBe('Guided Review 0.2.0 is out (you have 0.1.0). Run gr update to install it.');
    expect(fetchImpl).toHaveBeenCalledWith('https://registry.npmjs.org/@haydenmeloche%2fguided-review', expect.objectContaining({ headers: { accept: 'application/vnd.npm.install-v1+json' } }));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ latest: '0.2.0', checkedAt: NOW, notified: { version: '0.2.0', at: NOW } });
  });

  it('checks at most once per 24 hours and notifies from the cache meanwhile', async () => {
    const fetchImpl = registry('0.3.0');
    const file = cacheFile({ latest: '0.2.0', checkedAt: NOW - CHECK_INTERVAL_MS + 60_000 });
    expect(await check({ fetch: fetchImpl, cacheFile: file }).finish(50)).toContain('0.2.0 is out');
    expect(fetchImpl).not.toHaveBeenCalled();

    fs.writeFileSync(file, JSON.stringify({ latest: '0.2.0', checkedAt: NOW - CHECK_INTERVAL_MS }));
    expect(await check({ fetch: fetchImpl, cacheFile: file }).finish(1000)).toContain('0.3.0 is out');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not wait on the network: without grace the notice comes from the cache', async () => {
    let release!: () => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => (release = () => resolve(new Response(JSON.stringify({ 'dist-tags': { latest: '0.5.0' } })))))) as unknown as typeof fetch;
    const file = cacheFile({ latest: '0.2.0', checkedAt: 0 });
    expect(await check({ fetch: fetchImpl, cacheFile: file }).finish()).toContain('0.2.0 is out');
    release();
    await new Promise((r) => setTimeout(r, 10));
    // The abandoned fetch must not overwrite the cache afterwards.
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ latest: '0.2.0', checkedAt: 0 });
  });

  it('gives the notice once per run and once a day', async () => {
    const file = cacheFile({ latest: '0.2.0', checkedAt: NOW });
    const updates = check({ fetch: registry('0.2.0'), cacheFile: file });
    expect(await updates.finish()).toBeDefined();
    expect(await updates.finish()).toBeUndefined();
    expect(await check({ cacheFile: file }).finish()).toBeUndefined();
    expect(await check({ cacheFile: file, now: () => NOW + CHECK_INTERVAL_MS }).finish()).toBeDefined();
  });

  it('points an install gr cannot update at the releases page, and says nothing from a source checkout', async () => {
    const file = cacheFile({ latest: '0.2.0', checkedAt: NOW });
    const manual = check({ cacheFile: file, origin: 'manual' });
    expect(manual.available()).toBeUndefined();
    expect(await manual.finish()).toBe('Guided Review 0.2.0 is out (you have 0.1.0): https://github.com/HaydenMeloche/guided-review/releases');
    const source = check({ cacheFile: cacheFile({ latest: '0.2.0', checkedAt: NOW }), origin: 'source' });
    expect(source.available()).toBeUndefined();
    expect(await source.finish()).toBeUndefined();
  });

  it('is silent when the fetch fails, times out, or returns junk, and records the attempt', async () => {
    const failures: (typeof fetch)[] = [
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
      vi.fn(async () => new Response('nope', { status: 503 })),
      vi.fn(async () => new Response('not json')),
      vi.fn(async () => new Response(JSON.stringify({ 'dist-tags': { latest: 42 } }))),
      // Never answers on its own; only the timeout signal ends it.
      vi.fn(
        (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason as Error))),
      ) as unknown as typeof fetch,
    ];
    for (const fetchImpl of failures) {
      const file = cacheFile({ latest: '0.1.0', checkedAt: 0 });
      await expect(check({ fetch: fetchImpl, cacheFile: file, timeoutMs: 20 }).finish(1000)).resolves.toBeUndefined();
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ latest: '0.1.0', checkedAt: NOW });
    }
  });

  it('ignores a corrupt cache file', async () => {
    const file = cacheFile();
    fs.writeFileSync(file, '{not json');
    expect(await check({ fetch: registry('0.2.0'), cacheFile: file }).finish(1000)).toContain('0.2.0 is out');
  });
});

describe('versionToNotify', () => {
  it('mentions a newer release unless skipped or already mentioned in the last day', () => {
    expect(versionToNotify('0.1.0', undefined, NOW)).toBeUndefined();
    expect(versionToNotify('0.1.0', { latest: '0.1.0', checkedAt: NOW }, NOW)).toBeUndefined();
    expect(versionToNotify('0.1.0', { latest: '0.2.0', checkedAt: NOW }, NOW)).toBe('0.2.0');
    expect(versionToNotify('0.1.0', { latest: '0.2.0', checkedAt: NOW, skipped: '0.2.0' }, NOW)).toBeUndefined();
    expect(versionToNotify('0.1.0', { latest: '0.3.0', checkedAt: NOW, skipped: '0.2.0' }, NOW)).toBe('0.3.0');
    const notified = { version: '0.2.0', at: NOW - CHECK_INTERVAL_MS + 1 };
    expect(versionToNotify('0.1.0', { latest: '0.2.0', checkedAt: NOW, notified }, NOW)).toBeUndefined();
    expect(versionToNotify('0.1.0', { latest: '0.2.0', checkedAt: NOW, notified }, NOW + 1)).toBe('0.2.0');
    // A newer release is mentioned even if another was today.
    expect(versionToNotify('0.1.0', { latest: '0.3.0', checkedAt: NOW, notified }, NOW)).toBe('0.3.0');
  });
});

describe('fetchReleaseNotes', () => {
  const releases = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const signal = new AbortController().signal;

  it('keeps the full releases after the installed version up to the latest, newest first', async () => {
    const fetchFn = releases([
      { tag_name: 'v0.4.0', body: 'later', published_at: '2026-11-01T00:00:00Z' },
      { tag_name: 'v0.2.0', body: 'two', published_at: '2026-10-15T20:23:27Z' },
      { tag_name: 'v0.3.0-beta.1', body: 'beta', prerelease: true },
      { tag_name: 'v0.3.0', body: 'three', published_at: '2026-10-20T00:00:00Z' },
      { tag_name: 'v0.2.5', body: 'draft', draft: true },
      { tag_name: 'v0.1.0', body: 'installed' },
      { tag_name: 'nightly', body: 'junk' },
    ]);
    expect(await fetchReleaseNotes('0.1.0', '0.3.0', fetchFn, signal)).toEqual([
      { version: '0.3.0', date: '2026-10-20', body: 'three' },
      { version: '0.2.0', date: '2026-10-15', body: 'two' },
    ]);
  });

  it('is undefined when GitHub fails or answers with something else', async () => {
    expect(await fetchReleaseNotes('0.1.0', '0.2.0', releases({ message: 'rate limited' }, 403), signal)).toBeUndefined();
    expect(await fetchReleaseNotes('0.1.0', '0.2.0', releases({ message: 'odd' }), signal)).toBeUndefined();
    const offline = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchReleaseNotes('0.1.0', '0.2.0', offline, signal)).toBeUndefined();
  });
});

describe('detectPackageManager', () => {
  const pkg = 'node_modules/@haydenmeloche/guided-review/bin/gr.js';
  it('recognises global installs', () => {
    expect(detectPackageManager(`/usr/local/lib/${pkg}`)).toBe('npm');
    expect(detectPackageManager(`/Users/me/.nvm/versions/node/v22.13.0/lib/${pkg}`)).toBe('npm');
    expect(detectPackageManager(`C:\\Users\\me\\AppData\\Roaming\\npm\\${pkg.replace(/\//g, '\\')}`)).toBe('npm');
    expect(detectPackageManager(`/Users/me/Library/pnpm/global/5/.pnpm/@haydenmeloche+guided-review@0.1.0/${pkg}`)).toBe('pnpm');
    expect(detectPackageManager(`/home/me/.local/share/pnpm/global/5/${pkg}`)).toBe('pnpm');
    expect(detectPackageManager(`/home/me/.config/yarn/global/${pkg}`)).toBe('yarn');
    expect(detectPackageManager(`/home/me/.bun/install/global/${pkg}`)).toBe('bun');
    expect(detectPackageManager(`/Users/me/.volta/tools/image/packages/@haydenmeloche/guided-review/lib/${pkg}`)).toBe('volta');
  });

  it('installs with npm into the prefix that holds this copy, whichever npm is on PATH', () => {
    expect(npmPrefix(`/Users/me/.nvm/versions/node/v22.13.0/lib/${pkg}`)).toBe('/Users/me/.nvm/versions/node/v22.13.0');
    expect(npmPrefix(`C:\\Users\\me\\AppData\\Roaming\\npm\\${pkg.replace(/\//g, '\\')}`)).toBe('C:/Users/me/AppData/Roaming/npm');
    expect(globalInstaller('npm', `/usr/local/lib/${pkg}`).command).toEqual(['npm', ['install', '-g', '--prefix', '/usr/local', '@haydenmeloche/guided-review@latest']]);
    expect(globalInstaller('volta', `/x/.volta/tools/image/packages/@haydenmeloche/guided-review/lib/${pkg}`).command).toEqual(['volta', ['install', '@haydenmeloche/guided-review@latest']]);
  });

  it('tells a global install from one gr cannot update and from a source checkout', () => {
    expect(detectOrigin(`/usr/local/lib/${pkg}`)).toMatchObject({ name: 'npm' });
    expect(detectOrigin(`/Users/me/.npm/_npx/abc123/${pkg}`)).toBe('manual');
    expect(detectOrigin(`/Users/me/code/app/${pkg}`)).toBe('manual');
    expect(detectOrigin('/Users/me/code/guided-review/bin/gr.js')).toBe('source');
  });

  it('declines runs a global install would not update', () => {
    expect(detectPackageManager(`/Users/me/.npm/_npx/abc123/${pkg}`)).toBeUndefined();
    expect(detectPackageManager(`/Users/me/Library/Caches/pnpm/dlx/abc/.pnpm/x/${pkg}`)).toBeUndefined();
    expect(detectPackageManager(`/Users/me/code/app/${pkg}`)).toBeUndefined();
    expect(detectPackageManager('/Users/me/code/guided-review/bin/gr.js')).toBeUndefined();
  });
});

describe('the update on offer', () => {
  it('is offered from the cache until skipped', async () => {
    const file = cacheFile({ latest: '0.2.0', checkedAt: NOW });
    const offer = check({ cacheFile: file }).available();
    expect(offer).toMatchObject({ installed: '0.1.0', latest: '0.2.0', installer: npm });
    // The PR list says so every time, not once a day.
    expect(check({ cacheFile: file }).available()).toBeDefined();

    offer!.skip();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).skipped).toBe('0.2.0');
    expect(check({ cacheFile: file, now: () => NOW + 2 * CHECK_INTERVAL_MS }).available()).toBeUndefined();
    expect(await check({ cacheFile: file }).finish()).toBeUndefined();
  });
});

describe('the update offered as gr starts', () => {
  it('offers each release once', () => {
    const file = cacheFile({ latest: '0.2.0', checkedAt: NOW });
    expect(check({ cacheFile: file }).launchOffer()).toMatchObject({ latest: '0.2.0' });
    expect(check({ cacheFile: file }).launchOffer()).toBeUndefined();
    // The PR list keeps offering it.
    expect(check({ cacheFile: file }).available()).toBeDefined();
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), latest: '0.3.0' }));
    expect(check({ cacheFile: file }).launchOffer()).toMatchObject({ latest: '0.3.0' });
  });

  it("offers a deprecated version's update every time, with the reason, even when skipped", async () => {
    const file = cacheFile();
    // The daily check reads the deprecation of the installed version.
    await check({ cacheFile: file, fetch: registry('0.2.0', { '0.1.0': 'Fixes a token leak; please update' }) }).finish(1000);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), skipped: '0.2.0' }));
    for (let i = 0; i < 2; i++) expect(check({ cacheFile: file }).launchOffer()).toMatchObject({ latest: '0.2.0', deprecated: 'Fixes a token leak; please update' });
    expect(check({ cacheFile: file }).available()).toMatchObject({ deprecated: 'Fixes a token leak; please update' });
    // Updated, the deprecation was another version's.
    expect(check({ cacheFile: file, installed: '0.2.0' }).launchOffer()).toBeUndefined();
  });

  it('says why in the notice as gr exits', async () => {
    const file = cacheFile({ latest: '0.2.0', checkedAt: NOW, deprecated: { version: '0.1.0', message: 'Broken\u001b[31m sign-in' } });
    expect(await check({ cacheFile: file }).finish()).toBe('Guided Review 0.2.0 is out (you have 0.1.0). Run gr update to install it. Guided Review 0.1.0 is deprecated: Broken sign-in');
  });
});

describe('gr update', () => {
  const run = (overrides: Parameters<typeof updateNow>[0]) => updateNow({ env: {}, installed: '0.1.0', origin: npm, now: () => NOW, cacheFile: cacheFile(), ...overrides });

  it('asks npm now and offers the newer version even when it was skipped', async () => {
    const file = cacheFile({ latest: '0.2.0', checkedAt: NOW, skipped: '0.2.0' });
    const found = await run({ fetch: registry('0.2.0'), cacheFile: file });
    expect(found).toMatchObject({ kind: 'offer', offer: { latest: '0.2.0' } });
    const deprecated = await run({ fetch: registry('0.2.0', { '0.1.0': 'please update' }) });
    expect(deprecated).toMatchObject({ kind: 'offer', offer: { deprecated: 'please update' } });
  });

  it('says when gr is current, offline, a source checkout, or an install it cannot update', async () => {
    expect(await run({ fetch: registry('0.1.0') })).toEqual({ kind: 'current', installed: '0.1.0' });
    expect(
      await run({
        fetch: (async () => {
          throw new Error('offline');
        }) as unknown as typeof fetch,
      }),
    ).toEqual({ kind: 'offline' });
    expect(await run({ origin: 'source' })).toEqual({ kind: 'source' });
    expect(await run({ origin: 'manual', fetch: registry('0.2.0') })).toEqual({ kind: 'manual', installed: '0.1.0', latest: '0.2.0' });
  });
});

describe('promptForUpdate', () => {
  function setup(result: UpdateResult, results: ReturnType<Spawn>[] = []) {
    const offer: UpdateOffer = { installed: '0.1.0', latest: '0.2.0', installer: fakeInstaller(), skip: vi.fn() };
    const spawn = vi.fn<Spawn>(() => results.shift() ?? { status: 0 });
    const log = vi.fn();
    const choose = vi.fn(async () => result);
    const run = (...restart: [string[] | undefined] | []) => promptForUpdate(offer, restart.length ? restart[0] : ['--no-agent'], { choose, spawn, log });
    return { offer, spawn, log, choose, run };
  }

  it('starts gr again once the screen has installed the update', async () => {
    const t = setup({ kind: 'updated', output: ['changed 3 packages in 2s'] }, [{ status: 3 }]);
    expect(await t.run()).toBe(3);
    // The installer's summary stays in the scrollback above the restarted gr.
    expect(t.log.mock.calls.map((c) => c[0])).toEqual(['changed 3 packages in 2s', 'Updated Guided Review 0.1.0 → 0.2.0.']);
    expect(t.choose).toHaveBeenCalledWith(t.offer, 'restart');
    expect(t.spawn).toHaveBeenCalledTimes(1);
    expect(t.spawn.mock.calls[0][0]).toBe('/bin/guided-review');
    expect(t.spawn.mock.calls[0][1]).toEqual(['--no-agent']);
    // The new version says it was updated.
    expect(t.spawn.mock.calls[0][2]).toEqual({ PATH: '/bin', GR_UPDATED: '0.2.0' });
  });

  it('ends after gr update, or Ctrl+C on the notes, without starting gr again', async () => {
    const t = setup({ kind: 'updated', output: [] });
    expect(await t.run(undefined)).toBe(0);
    expect(t.choose).toHaveBeenCalledWith(t.offer, 'exit');
    const quit = setup({ kind: 'updated', output: [], quit: true });
    expect(await quit.run()).toBe(0);
    expect(t.spawn).not.toHaveBeenCalled();
    expect(quit.spawn).not.toHaveBeenCalled();
  });

  it('carries on with this version when the install fails, and says so in the scrollback', async () => {
    const t = setup({ kind: 'failed', why: 'pnpm exited with code 243' });
    expect(await t.run()).toBeUndefined();
    expect(t.spawn).not.toHaveBeenCalled();
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining('Could not update (pnpm exited with code 243). Run pnpm add -g @haydenmeloche/guided-review@latest yourself'));
  });

  it('exits with 130 on Ctrl+C', async () => {
    const t = setup({ kind: 'quit' });
    expect(await t.run()).toBe(130);
    expect(t.spawn).not.toHaveBeenCalled();
    expect(t.offer.skip).not.toHaveBeenCalled();
  });

  it('does nothing on not now, and records a skip', async () => {
    const no = setup({ kind: 'later' });
    expect(await no.run()).toBeUndefined();
    expect(no.spawn).not.toHaveBeenCalled();
    expect(no.offer.skip).not.toHaveBeenCalled();

    const skip = setup({ kind: 'skip' });
    expect(await skip.run()).toBeUndefined();
    expect(skip.spawn).not.toHaveBeenCalled();
    expect(skip.offer.skip).toHaveBeenCalled();
  });
});
