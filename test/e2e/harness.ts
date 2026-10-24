import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import pty from 'node-pty';
import xterm from '@xterm/headless';

const GR = path.resolve(import.meta.dirname, '../../bin/gr.js');

// An isolated world for one test: its own GR_HOME, HOME, CODEX_HOME, and a fake
// `gh` first on PATH that logs its arguments and fails, as if no remote exists.
export interface Sandbox {
  root: string;
  env: NodeJS.ProcessEnv;
  ghCalls: () => string[];
  cleanup: () => void;
}

export function sandbox(): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gr-e2e-')));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const ghLog = path.join(root, 'gh.log');
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "$*" >> "$GH_LOG"\necho "gh: not available in e2e tests" >&2\nexit 1\n', { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HOME: path.join(root, 'home'),
    GR_HOME: path.join(root, 'gr-home'),
    CODEX_HOME: path.join(root, 'codex-home'),
    GH_LOG: ghLog,
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GR_NO_UPDATE_CHECK: '1',
  };
  fs.mkdirSync(env.HOME!);
  return {
    root,
    env,
    ghCalls: () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean) : []),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// Fixed commit dates, so a fixture's SHAs (and every screen that shows one) are the same each run.
const FIXED_DATE = '2026-01-15T12:00:00Z';

function fixtureGit(box: Sandbox, repo: string) {
  const env = { ...box.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE };
  return (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' });
}

// A repo on `feature/discount` one commit ahead of origin/main, which is what `gr preview` diffs against.
export function fixtureRepo(box: Sandbox): string {
  const repo = path.join(box.root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const git = fixtureGit(box, repo);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'src/invoice.ts'), 'export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n');
  fs.writeFileSync(path.join(repo, 'src/invoice.test.ts'), "import { total } from './invoice';\ntest('total sums items', () => { expect(total([1, 2])).toBe(3); });\n");
  git('add', '.');
  git('commit', '-m', 'Add invoice totals');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-b', 'feature/discount');
  fs.writeFileSync(
    path.join(repo, 'src/invoice.ts'),
    'export function total(items: number[], discount = 0): number {\n  const sum = items.reduce((a, b) => a + b, 0);\n  return sum - sum * discount;\n}\n',
  );
  git('commit', '-am', 'Apply a discount to invoice totals');
  return repo;
}

// A repo whose branch changes several files: a pricing module with a hunk longer than a 36-row
// terminal, the order code that calls it, a test that names the changed function, a manifest
// changed without its lockfile, and a doc. Enough to show the chapter list, linked tests beside
// the code, scrolling, and the briefing's flags.
export function richFixtureRepo(box: Sandbox): string {
  const repo = path.join(box.root, 'rich');
  for (const dir of ['src', 'test']) fs.mkdirSync(path.join(repo, dir), { recursive: true });
  const git = fixtureGit(box, repo);
  const write = (file: string, text: string) => fs.writeFileSync(path.join(repo, file), text);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  write('package.json', JSON.stringify({ name: 'shop', version: '0.3.0', dependencies: { express: '^4.19.0' } }, null, 2) + '\n');
  write('pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      express:\n        specifier: ^4.19.0\n        version: 4.19.2\n");
  write('README.md', '# shop\n\nA small order service.\n');
  write(
    'src/pricing.ts',
    [
      'export interface LineItem {',
      '  sku: string;',
      '  cents: number;',
      '  qty: number;',
      '}',
      '',
      'const TAX_RATE = 0.13;',
      '',
      'export function subtotal(items: LineItem[]): number {',
      '  return items.reduce((n, i) => n + i.cents * i.qty, 0);',
      '}',
      '',
      'export function tax(subtotalCents: number): number {',
      '  return Math.round(subtotalCents * TAX_RATE);',
      '}',
      '',
      'export function quote(items: LineItem[]) {',
      '  const subtotalCents = subtotal(items);',
      '  const taxCents = tax(subtotalCents);',
      '  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };',
      '}',
      '',
    ].join('\n'),
  );
  write(
    'src/orders.ts',
    [
      "import { quote, type LineItem } from './pricing';",
      '',
      'export function createOrder(items: LineItem[]) {',
      '  const price = quote(items);',
      "  return { id: Date.now().toString(36), items, price, status: 'open' as const };",
      '}',
      '',
    ].join('\n'),
  );
  write(
    'test/pricing.test.ts',
    ["import { quote } from '../src/pricing';", '', "test('quote adds tax', () => {", "  expect(quote([{ sku: 'a', cents: 1000, qty: 1 }]).totalCents).toBe(1130);", '});', ''].join('\n'),
  );
  git('add', '.');
  git('commit', '-m', 'Price orders');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-b', 'feature/discounts');
  const codes = Array.from({ length: 30 }, (_, i) => `  { code: 'SAVE${String(i + 1).padStart(2, '0')}', percent: ${(i % 5) * 5 + 5}, minCents: ${(i % 4) * 1000} },`);
  write(
    'src/pricing.ts',
    [
      'export interface LineItem {',
      '  sku: string;',
      '  cents: number;',
      '  qty: number;',
      '}',
      '',
      'const TAX_RATE = 0.13;',
      '',
      'interface Discount {',
      '  code: string;',
      '  percent: number;',
      '  minCents: number;',
      '}',
      '',
      'const DISCOUNTS: Discount[] = [',
      ...codes,
      '];',
      '',
      'export function subtotal(items: LineItem[]): number {',
      '  return items.reduce((n, i) => n + i.cents * i.qty, 0);',
      '}',
      '',
      'export function tax(subtotalCents: number): number {',
      '  return Math.round(subtotalCents * TAX_RATE);',
      '}',
      '',
      'export function discountAmount(code: string, subtotalCents: number): number {',
      '  const d = DISCOUNTS.find((x) => x.code === code);',
      '  if (!d || subtotalCents < d.minCents) return 0;',
      '  return Math.round((subtotalCents * d.percent) / 100);',
      '}',
      '',
      'export function quote(items: LineItem[], discountCode?: string) {',
      '  const subtotalCents = subtotal(items);',
      '  const discountCents = discountCode ? discountAmount(discountCode, subtotalCents) : 0;',
      '  const taxCents = tax(subtotalCents - discountCents);',
      '  return { subtotalCents, discountCents, taxCents, totalCents: subtotalCents - discountCents + taxCents };',
      '}',
      '',
    ].join('\n'),
  );
  write(
    'src/orders.ts',
    [
      "import { quote, type LineItem } from './pricing';",
      '',
      'export function createOrder(items: LineItem[], discountCode?: string) {',
      '  const price = quote(items, discountCode);',
      "  return { id: Date.now().toString(36), items, price, status: 'open' as const };",
      '}',
      '',
    ].join('\n'),
  );
  write(
    'test/pricing.test.ts',
    [
      "import { quote } from '../src/pricing';",
      '',
      "test('quote adds tax', () => {",
      "  expect(quote([{ sku: 'a', cents: 1000, qty: 1 }]).totalCents).toBe(1130);",
      '});',
      '',
      "test('quote applies a discount code', () => {",
      "  expect(quote([{ sku: 'a', cents: 2000, qty: 1 }], 'SAVE01').discountCents).toBe(100);",
      '});',
      '',
    ].join('\n'),
  );
  write('package.json', JSON.stringify({ name: 'shop', version: '0.4.0', dependencies: { express: '^4.19.0', zod: '^3.23.0' } }, null, 2) + '\n');
  write('README.md', '# shop\n\nA small order service.\n\nOrders take an optional discount code (`SAVE01` to `SAVE30`).\n');
  git('commit', '-am', 'Add discount codes to quotes and orders');
  return repo;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Runs gr without a terminal, for the commands that print and exit.
export function runGr(box: Sandbox, args: string[], cwd = box.root): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [GR, ...args], { cwd, env: box.env, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

export interface Session {
  screen: () => string;
  screenWithAttrs: () => string; // the screen with its colors and styles marked up (see markRow)
  title: () => string; // the last window title gr set (OSC 0)
  press: (...keys: string[]) => void;
  type: (text: string) => void;
  waitFor: (match: string | RegExp, timeoutMs?: number) => Promise<string>;
  idle: () => Promise<string>; // waits for the output to go quiet, then returns the screen
  exited: Promise<number>;
  kill: () => void;
}

const QUIET_MS = 100;

export const KEY = { enter: '\r', escape: '\u001b', tab: '\t' } as const;

// Runs gr in a pseudo-terminal and mirrors its output into a headless xterm,
// so tests read the screen the way a user would see it.
export function startGr(box: Sandbox, args: string[], opts: { cwd: string; cols?: number; rows?: number }): Session {
  const cols = opts.cols ?? 120;
  const rows = opts.rows ?? 36;
  const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
  const proc = pty.spawn(process.execPath, [GR, ...args], { cols, rows, cwd: opts.cwd, env: box.env });
  let lastData = Date.now();
  let title = '';
  term.onTitleChange((t) => (title = t));
  proc.onData((data) => {
    lastData = Date.now();
    term.write(data);
  });
  let alive = true;
  const exited = new Promise<number>((resolve) =>
    proc.onExit(({ exitCode }) => {
      alive = false;
      resolve(exitCode);
    }),
  );

  const screen = () => {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < rows; i++) lines.push(buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '');
    return lines.join('\n');
  };

  const screenWithAttrs = () => {
    const buffer = term.buffer.active;
    const cell = buffer.getNullCell();
    const lines: string[] = [];
    for (let i = 0; i < rows; i++) {
      const line = buffer.getLine(buffer.viewportY + i);
      lines.push(line ? markRow(line, cols, cell) : '');
    }
    return lines.join('\n');
  };

  // A match can land mid-frame (a header painted before the panel under it), and Ink binds its
  // input handlers in effects that run after the first paint. Wait for the output to go quiet so
  // assertions see the whole frame and the next key press is not dropped.
  const settle = async () => {
    const until = Date.now() + 2000;
    while (Date.now() - lastData < QUIET_MS && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise<void>((resolve) => term.write('', resolve));
    return screen();
  };

  const waitFor = async (match: string | RegExp, timeoutMs = 10_000) => {
    const hit = (s: string) => (typeof match === 'string' ? s.includes(match) : match.test(s));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // Flush pending writes into the buffer before reading it.
      await new Promise<void>((resolve) => term.write('', resolve));
      const current = screen();
      if (hit(current)) return settle();
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${String(match)}. Screen:\n${current}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  return {
    screen,
    screenWithAttrs,
    title: () => title,
    press: (...keys) => {
      for (const k of keys) proc.write(k);
    },
    type: (text) => proc.write(text),
    waitFor,
    idle: settle,
    exited,
    kill: () => {
      if (alive) proc.kill();
    },
  };
}

type Line = NonNullable<ReturnType<xterm.Terminal['buffer']['active']['getLine']>>;
type Cell = ReturnType<xterm.Terminal['buffer']['active']['getNullCell']>;

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const colorName = (mode: 'fg' | 'bg', c: Cell): string | undefined => {
  const fg = mode === 'fg';
  if (fg ? c.isFgDefault() : c.isBgDefault()) return undefined;
  const v = fg ? c.getFgColor() : c.getBgColor();
  if (fg ? c.isFgRGB() : c.isBgRGB()) return '#' + v.toString(16).padStart(6, '0');
  return v < 8 ? ANSI[v] : v < 16 ? `bright-${ANSI[v - 8]}` : `c${v}`;
};

// One row as text with its styles marked: ‹cyan,b›n/p‹/› is bold cyan, ‹bg:#1e1e2e›…‹/› a
// background. Unstyled text is bare, and trailing unstyled blanks are dropped.
function markRow(line: Line, cols: number, cell: Cell): string {
  let out = '';
  let open = '';
  for (let x = 0; x < cols; x++) {
    if (!line.getCell(x, cell)) break;
    if (cell.getWidth() === 0) continue; // the second half of a wide character
    const fg = colorName('fg', cell);
    const bg = colorName('bg', cell);
    const style = [fg, bg && `bg:${bg}`, cell.isBold() && 'b', cell.isDim() && 'dim', cell.isItalic() && 'i', cell.isUnderline() && 'u', cell.isInverse() && 'inv'].filter(Boolean).join(',');
    if (style !== open) {
      if (open) out += '‹/›';
      if (style) out += `‹${style}›`;
      open = style;
    }
    out += cell.getChars() || ' ';
  }
  if (open) out += '‹/›';
  return out.replace(/ +$/, '');
}
