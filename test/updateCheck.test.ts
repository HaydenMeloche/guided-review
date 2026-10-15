import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHECK_INTERVAL_MS,
  compareVersions,
  detectPackageManager,
  installedVersion,
  newerRelease,
  parseAnswer,
  promptForUpdate,
  startUpdateCheck,
  updateCheckDisabled,
  versionToOffer,
  type Spawn,
  type UpdateCheckOptions,
  type UpdateOffer,
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
const registry = (version: string) => vi.fn(async () => new Response(JSON.stringify({ version }), { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
function check(overrides: UpdateCheckOptions) {
  return startUpdateCheck({ env: {}, interactive: true, installed: '0.1.0', packageManager: 'npm', now: () => NOW, ...overrides });
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
    expect(notice).toBe('Update available: 0.1.0 → 0.2.0. Run npm install -g @haydenmeloche/guided-review@latest to update.');
    expect(fetchImpl).toHaveBeenCalledWith('https://registry.npmjs.org/@haydenmeloche%2fguided-review/latest', expect.anything());
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ latest: '0.2.0', checkedAt: NOW });
  });

  it('checks at most once per 24 hours and notifies from the cache meanwhile', async () => {
    const fetchImpl = registry('0.3.0');
    const file = cacheFile({ latest: '0.2.0', checkedAt: NOW - CHECK_INTERVAL_MS + 60_000 });
    expect(await check({ fetch: fetchImpl, cacheFile: file }).finish(50)).toContain('0.1.0 → 0.2.0');
    expect(fetchImpl).not.toHaveBeenCalled();

    fs.writeFileSync(file, JSON.stringify({ latest: '0.2.0', checkedAt: NOW - CHECK_INTERVAL_MS }));
    expect(await check({ fetch: fetchImpl, cacheFile: file }).finish(1000)).toContain('0.1.0 → 0.3.0');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not wait on the network: without grace the notice comes from the cache', async () => {
    let release!: () => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => (release = () => resolve(new Response(JSON.stringify({ version: '0.5.0' })))))) as unknown as typeof fetch;
    const file = cacheFile({ latest: '0.2.0', checkedAt: 0 });
    expect(await check({ fetch: fetchImpl, cacheFile: file }).finish()).toContain('→ 0.2.0');
    release();
    await new Promise((r) => setTimeout(r, 10));
    // The abandoned fetch must not overwrite the cache afterwards.
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ latest: '0.2.0', checkedAt: 0 });
  });

  it('gives the notice once per run', async () => {
    const updates = check({ fetch: registry('0.2.0'), cacheFile: cacheFile({ latest: '0.2.0', checkedAt: NOW }) });
    expect(await updates.finish()).toBeDefined();
    expect(await updates.finish()).toBeUndefined();
  });

  it('is silent when the fetch fails, times out, or returns junk, and records the attempt', async () => {
    const failures: (typeof fetch)[] = [
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
      vi.fn(async () => new Response('nope', { status: 503 })),
      vi.fn(async () => new Response('not json')),
      vi.fn(async () => new Response(JSON.stringify({ version: 42 }))),
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
    expect(await check({ fetch: registry('0.2.0'), cacheFile: file }).finish(1000)).toContain('→ 0.2.0');
  });
});

describe('versionToOffer', () => {
  it('offers a newer release unless skipped or already offered in the last day', () => {
    expect(versionToOffer('0.1.0', undefined, NOW)).toBeUndefined();
    expect(versionToOffer('0.1.0', { latest: '0.1.0', checkedAt: NOW }, NOW)).toBeUndefined();
    expect(versionToOffer('0.1.0', { latest: '0.2.0', checkedAt: NOW }, NOW)).toBe('0.2.0');
    expect(versionToOffer('0.1.0', { latest: '0.2.0', checkedAt: NOW, skipped: '0.2.0' }, NOW)).toBeUndefined();
    expect(versionToOffer('0.1.0', { latest: '0.3.0', checkedAt: NOW, skipped: '0.2.0' }, NOW)).toBe('0.3.0');
    const prompted = { version: '0.2.0', at: NOW - CHECK_INTERVAL_MS + 1 };
    expect(versionToOffer('0.1.0', { latest: '0.2.0', checkedAt: NOW, prompted }, NOW)).toBeUndefined();
    expect(versionToOffer('0.1.0', { latest: '0.2.0', checkedAt: NOW, prompted }, NOW + 1)).toBe('0.2.0');
    // A newer release is offered even if another was offered today.
    expect(versionToOffer('0.1.0', { latest: '0.3.0', checkedAt: NOW, prompted }, NOW)).toBe('0.3.0');
  });
});

describe('parseAnswer', () => {
  it('treats Enter as yes and anything unknown as not now', () => {
    for (const a of ['', ' ', 'y', 'Y', 'yes']) expect(parseAnswer(a)).toBe('update');
    for (const a of ['n', 'No', 'maybe', 'q']) expect(parseAnswer(a)).toBe('later');
    for (const a of ['s', 'S', 'skip']) expect(parseAnswer(a)).toBe('skip');
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
  });

  it('declines runs a global install would not update', () => {
    expect(detectPackageManager(`/Users/me/.npm/_npx/abc123/${pkg}`)).toBeUndefined();
    expect(detectPackageManager(`/Users/me/Library/Caches/pnpm/dlx/abc/.pnpm/x/${pkg}`)).toBeUndefined();
    expect(detectPackageManager(`/Users/me/code/app/${pkg}`)).toBeUndefined();
    expect(detectPackageManager('/Users/me/code/guided-review/bin/gr.js')).toBeUndefined();
  });
});

describe('offer before a tour', () => {
  it('offers from the cache, then not again today, and remembers a skip', () => {
    const file = cacheFile({ latest: '0.2.0', checkedAt: NOW });
    const offer = check({ cacheFile: file }).offer();
    expect(offer).toMatchObject({ installed: '0.1.0', latest: '0.2.0', packageManager: 'npm' });
    expect(check({ cacheFile: file }).offer()).toBeUndefined();
    expect(check({ cacheFile: file, now: () => NOW + CHECK_INTERVAL_MS }).offer()).toBeDefined();

    offer!.skip();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).skipped).toBe('0.2.0');
    expect(check({ cacheFile: file, now: () => NOW + 2 * CHECK_INTERVAL_MS }).offer()).toBeUndefined();
  });

  it('offers once per run and not when the install method is unknown', () => {
    const file = cacheFile({ latest: '0.2.0', checkedAt: NOW });
    expect(check({ cacheFile: file, packageManager: null }).offer()).toBeUndefined();
    const updates = check({ cacheFile: file });
    expect(updates.offer()).toBeDefined();
    expect(updates.offer()).toBeUndefined();
  });
});

describe('promptForUpdate', () => {
  function setup(answer: string, results: ReturnType<Spawn>[] = []) {
    const offer: UpdateOffer = { installed: '0.1.0', latest: '0.2.0', packageManager: 'pnpm', skip: vi.fn() };
    const spawn = vi.fn<Spawn>(() => results.shift() ?? { status: 0 });
    const log = vi.fn();
    const ask = vi.fn(async () => answer);
    const run = () => promptForUpdate(offer, { ask, spawn, log, argv: ['/node', '/bin/gr', 'review', '12'] });
    return { offer, spawn, log, ask, run };
  }

  it('installs with the detected manager and relaunches the same command', async () => {
    const t = setup('', [{ status: 0 }, { status: 3 }]);
    expect(await t.run()).toBe(3);
    expect(t.ask).toHaveBeenCalledWith('Update available: 0.1.0 → 0.2.0. Update now? [Y/n/s(kip this version)] ');
    expect(t.spawn.mock.calls[0].slice(0, 2)).toEqual(['pnpm', ['add', '-g', '@haydenmeloche/guided-review@latest']]);
    expect(t.spawn.mock.calls[1][0]).toBe('/node');
    expect(t.spawn.mock.calls[1][1]).toEqual(['/bin/gr', 'review', '12']);
    expect(t.spawn.mock.calls[1][2]).toMatchObject({ GR_NO_UPDATE_CHECK: '1' });
  });

  it('carries on with this version when the install fails', async () => {
    const t = setup('y', [{ status: 243 }]);
    expect(await t.run()).toBeUndefined();
    expect(t.spawn).toHaveBeenCalledTimes(1);
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining('Could not update (pnpm exited with code 243). Run pnpm add -g @haydenmeloche/guided-review@latest yourself'));

    const missing = setup('y', [{ status: null, error: new Error('spawn pnpm ENOENT') }]);
    expect(await missing.run()).toBeUndefined();
    expect(missing.log).toHaveBeenCalledWith(expect.stringContaining('spawn pnpm ENOENT'));
  });

  it('does nothing on no, and records a skip', async () => {
    const no = setup('n');
    expect(await no.run()).toBeUndefined();
    expect(no.spawn).not.toHaveBeenCalled();
    expect(no.offer.skip).not.toHaveBeenCalled();

    const skip = setup('s');
    expect(await skip.run()).toBeUndefined();
    expect(skip.spawn).not.toHaveBeenCalled();
    expect(skip.offer.skip).toHaveBeenCalled();
  });
});
