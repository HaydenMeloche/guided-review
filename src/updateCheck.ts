import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grHome } from './paths.js';

const PACKAGE = '@haydenmeloche/guided-review';
const LATEST_URL = `https://registry.npmjs.org/${PACKAGE.replace('/', '%2f')}/latest`;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;

export interface UpdateCache {
  latest?: string;
  checkedAt: number;
  // Answered "skip": not offered again until something newer than this is out.
  skipped?: string;
  // The last version offered before a tour, so "no" is not asked again for a day.
  prompted?: { version: string; at: number };
}

interface SemVer {
  core: [number, number, number];
  pre: string[];
}

function parseVersion(v: string): SemVer | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return undefined;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

// Semver precedence: -1, 0, 1, or undefined when either side is not x.y.z[-pre][+build].
export function compareVersions(a: string, b: string): number | undefined {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return undefined;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  // A release outranks its prereleases.
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// The version to suggest, if `latest` is a newer full release than `installed` and not skipped.
export function newerRelease(installed: string, latest: string | undefined, skipped?: string): string | undefined {
  if (!latest || parseVersion(latest)?.pre.length !== 0) return undefined;
  if (skipped && compareVersions(latest, skipped) !== 1) return undefined;
  return compareVersions(installed, latest) === -1 ? latest : undefined;
}

// The version to offer before a tour, or undefined: nothing newer, skipped, or already offered today.
export function versionToOffer(installed: string, cache: UpdateCache | undefined, now: number): string | undefined {
  const latest = newerRelease(installed, cache?.latest, cache?.skipped);
  const prompted = cache?.prompted;
  if (latest && prompted?.version === latest && prompted.at <= now && now - prompted.at < CHECK_INTERVAL_MS) return undefined;
  return latest;
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

// How gr was installed, from the real path of its bin script. Undefined for npx/dlx runs, project-local
// installs, and source checkouts, where a global install would not change what runs.
export function detectPackageManager(binPath: string): PackageManager | undefined {
  const p = binPath.replace(/\\/g, '/');
  if (!p.includes(`/node_modules/${PACKAGE}/`) || /\/_npx\/|\/dlx\//.test(p)) return undefined;
  if (/\/\.bun\/install\/global\//.test(p)) return 'bun';
  if (/\/pnpm\/global\//i.test(p)) return 'pnpm';
  if (/\/yarn\/(data\/)?global\//i.test(p)) return 'yarn';
  if (/\/lib\/node_modules\/|\/npm\/node_modules\//i.test(p)) return 'npm';
  return undefined;
}

export function installCommand(pm: PackageManager): [string, string[]] {
  const spec = `${PACKAGE}@latest`;
  if (pm === 'pnpm') return ['pnpm', ['add', '-g', spec]];
  if (pm === 'yarn') return ['yarn', ['global', 'add', spec]];
  if (pm === 'bun') return ['bun', ['add', '-g', spec]];
  return ['npm', ['install', '-g', spec]];
}

export const commandLine = (pm: PackageManager) => installCommand(pm).flat().join(' ');

export function updateNotice(installed: string, latest: string, pm: PackageManager): string {
  return `Update available: ${installed} → ${latest}. Run ${commandLine(pm)} to update.`;
}

export function updateCheckDisabled(env: NodeJS.ProcessEnv): boolean {
  return !!env.CI || env.GR_NO_UPDATE_CHECK === '1' || env.NODE_ENV === 'test';
}

// gr's own package.json: its version and description, when they can be read.
export function packageInfo(): { version?: string; description?: string } {
  try {
    const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version?: unknown; description?: unknown };
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return { version: str(pkg.version), description: str(pkg.description) };
  } catch {
    return {};
  }
}

export const installedVersion = (): string | undefined => packageInfo().version;

function readCache(file: string): UpdateCache | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<UpdateCache>;
    if (typeof raw.checkedAt !== 'number') return undefined;
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const prompted = raw.prompted && typeof raw.prompted.version === 'string' && typeof raw.prompted.at === 'number' ? raw.prompted : undefined;
    return { checkedAt: raw.checkedAt, latest: str(raw.latest), skipped: str(raw.skipped), prompted };
  } catch {
    return undefined;
  }
}

function writeCache(file: string, cache: UpdateCache): void {
  try {
    fs.writeFileSync(file, `${JSON.stringify(cache)}\n`);
  } catch {
    // a read-only home just means checking again next run
  }
}

export async function fetchLatest(fetchImpl: typeof fetch, signal: AbortSignal): Promise<string | undefined> {
  try {
    const res = await fetchImpl(LATEST_URL, { signal, headers: { accept: 'application/json' } });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : undefined;
  } catch {
    return undefined;
  }
}

export interface UpdateCheckOptions {
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  installed?: string;
  // null: not a global install we know how to update.
  packageManager?: PackageManager | null;
  cacheFile?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface UpdateOffer {
  installed: string;
  latest: string;
  packageManager: PackageManager;
  // Records "skip this version" in the cache.
  skip: () => void;
}

export interface UpdateCheck {
  // The one-line notice for short commands. Waits up to graceMs for a fetch still in flight, then abandons it.
  finish(graceMs?: number): Promise<string | undefined>;
  // An update to offer before a tour, from the cache only. Records the offer so it is not repeated today.
  offer(): UpdateOffer | undefined;
}

const NONE: UpdateCheck = { finish: async () => undefined, offer: () => undefined };

function binPackageManager(): PackageManager | undefined {
  try {
    return detectPackageManager(fs.realpathSync(process.argv[1] ?? ''));
  } catch {
    return undefined;
  }
}

// Starts a background check against npm (at most once per CHECK_INTERVAL_MS) and returns at once.
// Each run reports at most once, from the cache or a fetch that has already finished.
export function startUpdateCheck(options: UpdateCheckOptions = {}): UpdateCheck {
  const env = options.env ?? process.env;
  const interactive = options.interactive ?? (!!process.stdin.isTTY && !!process.stdout.isTTY && !!process.stderr.isTTY);
  if (!interactive || updateCheckDisabled(env)) return NONE;
  const installed = options.installed ?? installedVersion();
  const pm = options.packageManager === undefined ? binPackageManager() : (options.packageManager ?? undefined);
  if (!installed || !pm) return NONE;
  let cacheFile: string;
  try {
    cacheFile = options.cacheFile ?? path.join(grHome(), 'update-check.json');
  } catch {
    return NONE;
  }
  const now = options.now ?? Date.now;
  let cache = readCache(cacheFile);
  let pending: Promise<void> | undefined;
  const controller = new AbortController();
  const checkedAt = cache?.checkedAt;
  if (checkedAt === undefined || now() - checkedAt >= CHECK_INTERVAL_MS || checkedAt > now()) {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS)]);
    pending = fetchLatest(options.fetch ?? fetch, signal).then((latest) => {
      if (controller.signal.aborted) return;
      // Record a failed check too, so an offline machine does not retry on every run.
      cache = { ...cache, latest: latest ?? cache?.latest, checkedAt: now() };
      writeCache(cacheFile, cache);
    });
  }
  const save = (patch: Partial<UpdateCache>) => {
    cache = { checkedAt: 0, ...cache, ...patch };
    writeCache(cacheFile, cache);
  };
  let done = false;
  return {
    async finish(graceMs = 0) {
      if (done) return undefined;
      done = true;
      if (pending && graceMs > 0) await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, graceMs).unref())]);
      controller.abort();
      const latest = newerRelease(installed, cache?.latest, cache?.skipped);
      return latest && updateNotice(installed, latest, pm);
    },
    offer() {
      if (done) return undefined;
      done = true;
      const latest = versionToOffer(installed, cache, now());
      if (!latest) return undefined;
      save({ prompted: { version: latest, at: now() } });
      return { installed, latest, packageManager: pm, skip: () => save({ skipped: latest }) };
    },
  };
}

export interface ReleaseNotes {
  version: string;
  date?: string;
  body: string;
}

export const RELEASES_URL = 'https://github.com/HaydenMeloche/guided-review/releases';
const RELEASES_API = 'https://api.github.com/repos/HaydenMeloche/guided-review/releases?per_page=30';

// The notes of each full release after `installed` up to `latest`, newest first. Undefined when
// GitHub can't be reached, so the update screen can point at the releases page instead.
export async function fetchReleaseNotes(installed: string, latest: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<ReleaseNotes[] | undefined> {
  try {
    const res = await fetchImpl(RELEASES_API, { signal, headers: { accept: 'application/vnd.github+json' } });
    if (!res.ok) return undefined;
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return undefined;
    const notes: ReleaseNotes[] = [];
    for (const r of body as Record<string, unknown>[]) {
      if (!r || r.draft || r.prerelease || typeof r.tag_name !== 'string') continue;
      const version = r.tag_name.replace(/^v/, '');
      if (compareVersions(version, installed) !== 1 || compareVersions(version, latest) === 1) continue;
      const date = typeof r.published_at === 'string' ? r.published_at.slice(0, 10) : undefined;
      notes.push({ version, date, body: typeof r.body === 'string' ? r.body : '' });
    }
    return notes.sort((a, b) => compareVersions(b.version, a.version) ?? 0);
  } catch {
    return undefined;
  }
}

export type Install = (command: string, args: string[], onOutput: (chunk: string) => void, signal: AbortSignal) => Promise<{ status: number | null; error?: Error }>;

// Runs the package manager with its output piped, so the update screen can show it as it goes.
export const runInstall: Install = (command, args, onOutput, signal) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal, shell: process.platform === 'win32' });
    child.stdout.on('data', (d: Buffer) => onOutput(d.toString()));
    child.stderr.on('data', (d: Buffer) => onOutput(d.toString()));
    child.once('error', (error) => resolve({ status: null, error }));
    child.once('close', (status) => resolve({ status }));
  });

// What the update screen ended with. `updated` carries the installer's summary and `failed` the
// reason, both already shown on screen.
export type UpdateResult = { kind: 'updated'; output: string[] } | { kind: 'later' } | { kind: 'skip' } | { kind: 'failed'; why: string } | { kind: 'quit' };

export type Spawn = (command: string, args: string[], env?: NodeJS.ProcessEnv) => { status: number | null; error?: Error };

const spawnInherit: Spawn = (command, args, env) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  return { status: result.status, error: result.error };
};

export interface PromptDeps {
  // Shows the update offer and installs on yes. Defaults to the full-screen update screen.
  choose?: (offer: UpdateOffer) => Promise<UpdateResult>;
  spawn?: Spawn;
  argv?: string[];
  log?: (line: string) => void;
}

// Offers the update before a tour. Returns the code to exit with (the relaunched new version's,
// or 130 for Ctrl+C), or undefined to carry on with this one (declined, skipped, or the install failed).
export async function promptForUpdate(offer: UpdateOffer, deps: PromptDeps = {}): Promise<number | undefined> {
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const choose = deps.choose ?? (async (o: UpdateOffer) => (await import('./tui/UpdateScreen.js')).runUpdateScreen(o));
  const result = await choose(offer);
  if (result.kind === 'quit') return 130;
  if (result.kind === 'skip') offer.skip();
  // The screen is gone once the tour opens, so the failure stays in the scrollback too.
  if (result.kind === 'failed') log(`Could not update (${result.why}). Run ${commandLine(offer.packageManager)} yourself; continuing with ${offer.installed}.`);
  if (result.kind !== 'updated') return undefined;
  for (const line of result.output) log(line);
  log(`Updated Guided Review ${offer.installed} → ${offer.latest}.`);
  const spawn = deps.spawn ?? spawnInherit;
  // Node's own flags go too, such as the loader tsx adds when running from source.
  const [node, ...rest] = deps.argv ?? [process.argv[0], ...process.execArgv, ...process.argv.slice(1)];
  // The relaunch must not offer again if the install landed somewhere else on PATH.
  const relaunched = spawn(node, rest, { ...process.env, GR_NO_UPDATE_CHECK: '1' });
  // This process's files were just replaced, so it cannot safely carry on with the tour itself.
  if (relaunched.error) log(`Updated to ${offer.latest}, but could not restart (${relaunched.error.message}). Run the command again.`);
  return relaunched.status ?? 1;
}
