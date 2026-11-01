import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';
import { grHome } from './paths.js';
import { sanitizeTerminal } from './util/sanitize.js';

const PACKAGE = '@haydenmeloche/guided-review';
// The abbreviated package document: the latest version, and whether each version is deprecated.
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE.replace('/', '%2f')}`;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;
const execFileP = promisify(execFile);

export interface UpdateCache {
  latest?: string;
  checkedAt: number;
  // Answered "skip": not offered again until something newer than this is out.
  skipped?: string;
  // The last version mentioned as gr exited, so it is mentioned once a day.
  notified?: { version: string; at: number };
  // The last version offered as gr started, so each release is offered there once.
  offered?: string;
  // The maintainer's `npm deprecate` message for a version, when the installed one has it: that
  // version is offered every time gr starts, and can't be skipped.
  deprecated?: { version: string; message: string };
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

// The version to mention as gr exits, or undefined: nothing newer, skipped, or already mentioned today.
export function versionToNotify(installed: string, cache: UpdateCache | undefined, now: number): string | undefined {
  const latest = newerRelease(installed, cache?.latest, deprecationFor(installed, cache) ? undefined : cache?.skipped);
  const notified = cache?.notified;
  if (latest && notified?.version === latest && notified.at <= now && now - notified.at < CHECK_INTERVAL_MS) return undefined;
  return latest;
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'volta';

// The package manager of a global install, from the real path of gr's bin script. Undefined for
// npx/dlx runs, project-local installs, and source checkouts, where a global install would not
// change what runs.
export function detectPackageManager(binPath: string): PackageManager | undefined {
  const p = binPath.replace(/\\/g, '/');
  if (!p.includes(`/node_modules/${PACKAGE}/`) || /\/_npx\/|\/dlx\//.test(p)) return undefined;
  if (/\/\.volta\/tools\/image\/packages\//.test(p)) return 'volta';
  if (/\/\.bun\/install\/global\//.test(p)) return 'bun';
  if (/\/pnpm\/global\//i.test(p)) return 'pnpm';
  if (/\/yarn\/(data\/)?global\//i.test(p)) return 'yarn';
  if (/\/lib\/node_modules\/|\/npm\/node_modules\//i.test(p)) return 'npm';
  return undefined;
}

// npm's global prefix that holds this install: <prefix>/lib/node_modules, or <prefix>/node_modules
// on Windows. Installing there replaces this copy, whichever npm is first on PATH.
export function npmPrefix(binPath: string): string | undefined {
  const p = binPath.replace(/\\/g, '/');
  const at = p.indexOf(`/node_modules/${PACKAGE}/`);
  if (at < 0) return undefined;
  const root = p.slice(0, at);
  return /\/lib$/.test(root) ? root.slice(0, -4) : root;
}

export function installCommand(pm: PackageManager, prefix?: string): [string, string[]] {
  const spec = `${PACKAGE}@latest`;
  if (pm === 'pnpm') return ['pnpm', ['add', '-g', spec]];
  if (pm === 'yarn') return ['yarn', ['global', 'add', spec]];
  if (pm === 'bun') return ['bun', ['add', '-g', spec]];
  if (pm === 'volta') return ['volta', ['install', spec]];
  return ['npm', ['install', '-g', ...(prefix ? ['--prefix', prefix] : []), spec]];
}

export const commandLine = ([command, args]: [string, string[]]) => [command, ...args].join(' ');

// The first executable called name on PATH.
export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

// What gr runs to install a newer version, and how it checks that the next `gr` is that version.
export interface Installer {
  name: string; // the package manager, as the update screen names it
  command: [string, string[]];
  // Once the install has finished: the version the gr on PATH now runs, and where that gr is.
  current(): Promise<{ version?: string; where?: string }>;
  // Starts gr again with these arguments, on the version just installed.
  relaunch(args: string[]): { command: string; args: string[]; env: NodeJS.ProcessEnv };
}

// `guided-review` is the name to look up: `gr` can be some other program, or a shell alias.
const BIN = 'guided-review';

export function globalInstaller(pm: PackageManager, binPath: string): Installer {
  return {
    name: pm,
    command: installCommand(pm, pm === 'npm' ? npmPrefix(binPath) : undefined),
    async current() {
      const where = onPath(BIN);
      if (!where) return {};
      try {
        const { stdout } = await execFileP(where, ['--version'], { env: { ...process.env, GR_NO_UPDATE_CHECK: '1' }, timeout: 10_000, shell: process.platform === 'win32' });
        return { version: stdout.trim() || undefined, where };
      } catch {
        return { where };
      }
    },
    relaunch: (args) => ({ command: onPath(BIN) ?? BIN, args, env: process.env }),
  };
}

// GR_FAKE_UPDATE=<version> in a source checkout: offers that version and "installs" it with
// scripts/fake-update.mjs, so the update can be tried without publishing. GR_FAKE_UPDATE_RESULT
// picks how the install goes: ok (default), fail, eacces, or elsewhere (installs, but the gr on
// PATH stays the old version).
export function fakeInstaller(latest: string, env: NodeJS.ProcessEnv): Installer {
  const marker = path.join(grHome(), 'fake-update-installed');
  fs.rmSync(marker, { force: true });
  const script = fileURLToPath(new URL('../scripts/fake-update.mjs', import.meta.url));
  return {
    name: 'npm',
    command: [process.execPath, [script, latest, env.GR_FAKE_UPDATE_RESULT ?? 'ok', marker]],
    async current() {
      try {
        return { version: fs.readFileSync(marker, 'utf8').trim(), where: process.argv[1] };
      } catch {
        return { version: installedVersion(), where: process.argv[1] };
      }
    },
    relaunch: (args) => {
      // The "new version" is this checkout without the fake update on offer.
      const rest = { ...process.env };
      delete rest.GR_FAKE_UPDATE;
      return { command: process.execPath, args: [...process.execArgv, process.argv[1], ...args], env: rest };
    },
  };
}

// How this gr was installed: a global install gr can update itself, one it can't (npx, a project's
// node_modules), or a source checkout, which hears nothing about releases.
export type Origin = Installer | 'manual' | 'source';

export function detectOrigin(binPath: string): Origin {
  if (!binPath.replace(/\\/g, '/').includes(`/node_modules/${PACKAGE}/`)) return 'source';
  const pm = detectPackageManager(binPath);
  return pm ? globalInstaller(pm, binPath) : 'manual';
}

function binPath(): string {
  try {
    return fs.realpathSync(process.argv[1] ?? '');
  } catch {
    return process.argv[1] ?? '';
  }
}

export function updateNotice(installed: string, latest: string, origin: Installer | 'manual', deprecated?: string): string {
  const how = origin === 'manual' ? `: ${RELEASES_URL}` : '. Run gr update to install it.';
  const why = deprecated ? ` Guided Review ${installed} is deprecated: ${plainText(deprecated)}` : '';
  return `Guided Review ${latest} is out (you have ${installed})${how}${why}`;
}

export function updateCheckDisabled(env: NodeJS.ProcessEnv): boolean {
  return !!env.CI || env.GR_NO_UPDATE_CHECK === '1' || env.NODE_ENV === 'test';
}

// Refreshing the installed Claude Code command and Codex skill is for installed copies of gr only:
// not CI, tests, or a source checkout, whose files are not a release.
export function packagedRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.CI && env.NODE_ENV !== 'test' && detectOrigin(binPath()) !== 'source';
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
    const notified = raw.notified && typeof raw.notified.version === 'string' && typeof raw.notified.at === 'number' ? raw.notified : undefined;
    const deprecated = raw.deprecated && typeof raw.deprecated.version === 'string' && typeof raw.deprecated.message === 'string' ? raw.deprecated : undefined;
    return { checkedAt: raw.checkedAt, latest: str(raw.latest), skipped: str(raw.skipped), notified, offered: str(raw.offered), deprecated };
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

export interface RegistryInfo {
  latest: string;
  deprecated?: string; // the installed version's deprecation message
}

export async function fetchRegistry(installed: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<RegistryInfo | undefined> {
  try {
    const res = await fetchImpl(REGISTRY_URL, { signal, headers: { accept: 'application/vnd.npm.install-v1+json' } });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { 'dist-tags'?: { latest?: unknown }; versions?: Record<string, { deprecated?: unknown } | undefined> };
    const latest = body['dist-tags']?.latest;
    if (typeof latest !== 'string') return undefined;
    const deprecated = body.versions?.[installed]?.deprecated;
    const message = typeof deprecated === 'string' ? plainText(deprecated) : '';
    return { latest, ...(message ? { deprecated: message } : {}) };
  } catch {
    return undefined;
  }
}

// npm's deprecation message as plain text: escape sequences go whole, before the sanitizer would
// strip only their ESC and leave "[31m" behind.
const plainText = (text: string) => sanitizeTerminal(stripVTControlCharacters(text)).trim();

// The cache's record of a deprecation, from what npm said about the installed version.
const deprecationOf = (installed: string, info: RegistryInfo) => (info.deprecated ? { version: installed, message: info.deprecated } : undefined);

export interface UpdateCheckOptions {
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  installed?: string;
  origin?: Origin;
  cacheFile?: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface UpdateOffer {
  installed: string;
  latest: string;
  installer: Installer;
  // Records "skip this version" in the cache.
  skip: () => void;
  // The release notes to show once it is installed; fetched from GitHub when unset.
  notes?: () => Promise<ReleaseNotes[] | undefined>;
  // Why the installed version is deprecated: it can't be skipped.
  deprecated?: string;
}

export interface UpdateCheck {
  // A newer release gr can install itself, from the cache: the PR list offers it.
  available(): UpdateOffer | undefined;
  // The update to offer full screen as gr starts: each release once, and a deprecated version's
  // update every time. Records the offer.
  launchOffer(): UpdateOffer | undefined;
  // The notice printed as gr exits, at most once a day. Waits up to graceMs for a fetch still in
  // flight, then abandons it.
  finish(graceMs?: number): Promise<string | undefined>;
}

const NONE: UpdateCheck = { finish: async () => undefined, available: () => undefined, launchOffer: () => undefined };

function defaultCacheFile(): string | undefined {
  try {
    return path.join(grHome(), 'update-check.json');
  } catch {
    return undefined;
  }
}

const FAKE_NOTES: ReleaseNotes[] = [{ version: 'fake', body: '## Highlights\n\n- This is a fake release from `GR_FAKE_UPDATE`.\n- Nothing was installed: the checkout runs as it was.' }];

function makeOffer(installed: string, latest: string, installer: Installer, save: (patch: Partial<UpdateCache>) => void, fake: boolean, deprecated?: string): UpdateOffer {
  return {
    installed,
    latest,
    installer,
    skip: () => save({ skipped: latest }),
    notes: fake ? async () => FAKE_NOTES.map((n) => ({ ...n, version: latest })) : undefined,
    ...(deprecated ? { deprecated } : {}),
  };
}

// The installed version's deprecation message, if the cache has one for it.
const deprecationFor = (installed: string, cache: UpdateCache | undefined) => (cache?.deprecated?.version === installed ? cache.deprecated.message : undefined);

// The update to offer as gr starts, or undefined: nothing newer, skipped, or offered there already.
// A deprecated version ignores both: it is offered every time.
export function versionToLaunch(installed: string, cache: UpdateCache | undefined): string | undefined {
  if (deprecationFor(installed, cache)) return newerRelease(installed, cache?.latest);
  const latest = newerRelease(installed, cache?.latest, cache?.skipped);
  return latest && cache?.offered !== latest ? latest : undefined;
}

// Starts a background check against npm (at most once per CHECK_INTERVAL_MS) and returns at once.
export function startUpdateCheck(options: UpdateCheckOptions = {}): UpdateCheck {
  const env = options.env ?? process.env;
  const interactive = options.interactive ?? (!!process.stdin.isTTY && !!process.stdout.isTTY && !!process.stderr.isTTY);
  const fake = env.GR_FAKE_UPDATE;
  if (!interactive || (!fake && updateCheckDisabled(env))) return NONE;
  const installed = options.installed ?? installedVersion();
  if (!installed) return NONE;
  const origin = fake ? fakeInstaller(fake, env) : (options.origin ?? detectOrigin(binPath()));
  if (origin === 'source') return NONE;
  const cacheFile = options.cacheFile ?? defaultCacheFile();
  if (!cacheFile) return NONE;
  const now = options.now ?? Date.now;
  let cache = readCache(cacheFile);
  // GR_FAKE_DEPRECATED=<message> marks the installed version deprecated, to try that offer.
  if (fake) cache = { ...cache, checkedAt: now(), latest: fake, deprecated: env.GR_FAKE_DEPRECATED ? { version: installed, message: env.GR_FAKE_DEPRECATED } : undefined };
  let pending: Promise<void> | undefined;
  const controller = new AbortController();
  const checkedAt = cache?.checkedAt;
  if (checkedAt === undefined || now() - checkedAt >= CHECK_INTERVAL_MS || checkedAt > now()) {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS)]);
    pending = fetchRegistry(installed, options.fetch ?? fetch, signal).then((info) => {
      if (controller.signal.aborted) return;
      // Record a failed check too, so an offline machine does not retry on every run.
      cache = info ? { ...cache, latest: info.latest, deprecated: deprecationOf(installed, info), checkedAt: now() } : { ...cache, checkedAt: now() };
      writeCache(cacheFile, cache);
    });
  }
  const save = (patch: Partial<UpdateCache>) => {
    cache = { checkedAt: 0, ...cache, ...patch };
    // The fake's version and deprecation stay out of the real cache.
    writeCache(cacheFile, fake ? { ...cache, latest: readCache(cacheFile)?.latest, deprecated: readCache(cacheFile)?.deprecated } : cache);
  };
  const offerOf = (latest: string) => (origin === 'manual' ? undefined : makeOffer(installed, latest, origin, save, !!fake, deprecationFor(installed, cache)));
  let done = false;
  return {
    available() {
      const latest = newerRelease(installed, cache?.latest, deprecationFor(installed, cache) ? undefined : cache?.skipped);
      return latest ? offerOf(latest) : undefined;
    },
    launchOffer() {
      const latest = versionToLaunch(installed, cache);
      const offer = latest && offerOf(latest);
      if (offer) save({ offered: offer.latest });
      return offer || undefined;
    },
    async finish(graceMs = 0) {
      if (done) return undefined;
      done = true;
      if (pending && graceMs > 0) await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, graceMs).unref())]);
      controller.abort();
      const latest = versionToNotify(installed, cache, now());
      if (!latest) return undefined;
      save({ notified: { version: latest, at: now() } });
      return updateNotice(installed, latest, origin, deprecationFor(installed, cache));
    },
  };
}

// What `gr update` found: an update to offer, or why there is none.
export type UpdateNow =
  { kind: 'offer'; offer: UpdateOffer } | { kind: 'current'; installed: string } | { kind: 'manual'; installed: string; latest?: string } | { kind: 'source' } | { kind: 'offline' };

// Asks npm now, ignoring the daily check and a skipped version: `gr update` is asked for.
export async function updateNow(options: Omit<UpdateCheckOptions, 'interactive'> = {}): Promise<UpdateNow> {
  const env = options.env ?? process.env;
  const installed = options.installed ?? installedVersion();
  const fake = env.GR_FAKE_UPDATE;
  const origin = fake ? fakeInstaller(fake, env) : (options.origin ?? detectOrigin(binPath()));
  if (origin === 'source' || !installed) return { kind: 'source' };
  const cacheFile = options.cacheFile ?? defaultCacheFile();
  const now = options.now ?? Date.now;
  const info = fake ? { latest: fake, deprecated: env.GR_FAKE_DEPRECATED || undefined } : await fetchRegistry(installed, options.fetch ?? fetch, AbortSignal.timeout(options.timeoutMs ?? 5000));
  if (!info) return { kind: 'offline' };
  const { latest } = info;
  const cache = (cacheFile && readCache(cacheFile)) || undefined;
  const save = (patch: Partial<UpdateCache>) => {
    if (cacheFile) writeCache(cacheFile, { ...cache, checkedAt: now(), latest, deprecated: deprecationOf(installed, info), ...patch });
  };
  if (!fake) save({});
  if (origin === 'manual') return { kind: 'manual', installed, latest: newerRelease(installed, latest) };
  const newer = newerRelease(installed, latest);
  return newer ? { kind: 'offer', offer: makeOffer(installed, newer, origin, save, !!fake, info.deprecated) } : { kind: 'current', installed };
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
// reason, both already shown on screen; `quit` on an update means Ctrl+C after it installed.
export type UpdateResult = { kind: 'updated'; output: string[]; quit?: boolean } | { kind: 'later' } | { kind: 'skip' } | { kind: 'failed'; why: string } | { kind: 'quit' };

export type Spawn = (command: string, args: string[], env?: NodeJS.ProcessEnv) => { status: number | null; error?: Error };

const spawnInherit: Spawn = (command, args, env) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  return { status: result.status, error: result.error };
};

export interface PromptDeps {
  // Shows the update offer and installs on yes. Defaults to the full-screen update screen.
  choose?: (offer: UpdateOffer, then: 'restart' | 'exit') => Promise<UpdateResult>;
  spawn?: Spawn;
  log?: (line: string) => void;
}

// Offers the update. With `restart`, gr starts again with those arguments once it is installed.
// Returns the code to exit with (the relaunched new version's, 0 after `gr update`, or 130 for
// Ctrl+C), or undefined to carry on with this version (declined, skipped, or the install failed).
export async function promptForUpdate(offer: UpdateOffer, restart: string[] | undefined, deps: PromptDeps = {}): Promise<number | undefined> {
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const choose = deps.choose ?? (async (o: UpdateOffer, then: 'restart' | 'exit') => (await import('./tui/UpdateScreen.js')).runUpdateScreen(o, then));
  const result = await choose(offer, restart ? 'restart' : 'exit');
  if (result.kind === 'quit') return 130;
  if (result.kind === 'skip') offer.skip();
  // The screen is gone once gr carries on, so the failure stays in the scrollback too.
  if (result.kind === 'failed') log(`Could not update (${result.why}). Run ${commandLine(offer.installer.command)} yourself; continuing with ${offer.installed}.`);
  if (result.kind !== 'updated') return undefined;
  for (const line of result.output) log(line);
  log(`Updated Guided Review ${offer.installed} → ${offer.latest}.`);
  if (!restart || result.quit) return 0;
  const spawn = deps.spawn ?? spawnInherit;
  const next = offer.installer.relaunch(restart);
  // The new version says it was updated, in place of offering it.
  const relaunched = spawn(next.command, next.args, { ...next.env, GR_UPDATED: offer.latest });
  // This process's files were just replaced, so it cannot safely carry on itself.
  if (relaunched.error) log(`Updated to ${offer.latest}, but could not restart (${relaunched.error.message}). Run the command again.`);
  return relaunched.status ?? 1;
}
