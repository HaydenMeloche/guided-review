import { describe, expect, it } from 'vitest';
import type { Hunk } from '../src/types.js';
import { findMissingChanges } from '../src/analysis/missing.js';
import { filesFor, hunkFromDiff } from './fixtures/tour.js';

function check(hunks: Hunk[], repoFiles: string[], heads: Record<string, string> = {}, kinds = {}, status = {}) {
  const files = filesFor(hunks, kinds, status);
  return findMissingChanges(files, Object.fromEntries(hunks.map((h) => [h.id, h])), {
    listFiles: () => [...new Set([...repoFiles, ...files.map((f) => f.path)])],
    readHead: (p) => heads[p],
  });
}
const messages = (flags: { message: string }[]) => flags.map((f) => f.message).join('\n');

describe('findMissingChanges', () => {
  const api = hunkFromDiff('src/lib.ts', '+export function newThing() {', '+  return 1', '+}');

  it('flags a public API change without a CHANGELOG update, only when the repo keeps one', () => {
    expect(messages(check([api], ['CHANGELOG.md']))).toMatch(/CHANGELOG\.md was not updated/);
    expect(check([api], ['README.md'])).toEqual([]);
    const log = hunkFromDiff('CHANGELOG.md', '+- newThing');
    expect(check([api, log], ['CHANGELOG.md'], {}, { 'CHANGELOG.md': 'config' })).toEqual([]);
  });

  it('asks for a changeset in changeset repos', () => {
    expect(messages(check([api], ['.changeset/config.json']))).toMatch(/no changeset/);
    const cs = hunkFromDiff('.changeset/brave-cats.md', '+---');
    expect(check([api, cs], ['.changeset/config.json'], {}, { '.changeset/brave-cats.md': 'config' })).toEqual([]);
  });

  it('flags model field changes without a migration', () => {
    const model = hunkFromDiff('app/models.py', '+    discount = models.DecimalField(max_digits=5)');
    expect(messages(check([model], ['app/migrations/0001_initial.py']))).toMatch(/no migration/);
    const mig = hunkFromDiff('app/migrations/0002_discount.py', '+class Migration: pass');
    expect(check([model, mig], ['app/migrations/0001_initial.py'], {}, {}, { 'app/migrations/0002_discount.py': 'added' })).toEqual([]);
    expect(check([model], [])).toEqual([]); // repo has no migrations: no evidence
    const helper = hunkFromDiff('app/models.py', '+    def label(self):', '+        return self.name');
    expect(check([helper], ['app/migrations/0001_initial.py'])).toEqual([]);
    const entity = hunkFromDiff('src/main/kotlin/Invoice.kt', '+    @Column(name = "discount")', '+    val discount: BigDecimal');
    expect(messages(check([entity], ['src/main/resources/db/migration/V1__init.sql']))).toMatch(/no migration/);
  });

  it('flags new env vars missing from the example file', () => {
    const env = hunkFromDiff('src/config.ts', '+const key = process.env.STRIPE_KEY', '+const mode = process.env.NODE_ENV');
    const flags = check([env], ['.env.example'], { '.env.example': 'DATABASE_URL=\n' });
    expect(messages(flags)).toMatch(/STRIPE_KEY not in \.env\.example/);
    expect(messages(flags)).not.toMatch(/NODE_ENV/);
    expect(check([env], ['.env.example'], { '.env.example': 'STRIPE_KEY=\n' })).toEqual([]);
    expect(check([env], [])).toEqual([]);
  });

  it('flags new translation keys missing from locale files', () => {
    const ui = hunkFromDiff('src/Checkout.tsx', "+  <p>{t('checkout.discountApplied')}</p>");
    expect(messages(check([ui], ['src/locales/en.json'], { 'src/locales/en.json': '{"checkout": {"title": "Pay"}}' }))).toMatch(/checkout\.discountApplied/);
    expect(check([ui], ['src/locales/en.json'], { 'src/locales/en.json': '{"checkout": {"discountApplied": "Done"}}' })).toEqual([]);
    expect(check([ui], [])).toEqual([]);
  });

  it('flags new CLI flags without docs when the repo has docs/', () => {
    const cli = hunkFromDiff('src/cli.ts', "+program.option('--dry-run', 'do nothing')");
    expect(messages(check([cli], ['docs/cli.md']))).toMatch(/CLI flag or route/);
    const doc = hunkFromDiff('docs/cli.md', '+--dry-run');
    expect(check([cli, doc], ['docs/cli.md'], {}, { 'docs/cli.md': 'config' })).toEqual([]);
  });

  it('suggests a feature flag for risky new paths in repos that use flags', () => {
    const risky = { ...hunkFromDiff('src/pay.ts', '+if (amount > 0) {', '+  charge(card)', '+  audit()', '+  notify()', '+  return ok', '+}'), risk: 3 as const };
    const heads = { 'src/pay.ts': "import { isEnabled } from './flags'\n" };
    expect(messages(check([risky], ['src/flags/index.ts'], heads))).toMatch(/feature flag/);
    expect(check([risky], ['src/x.ts'])).toEqual([]);
    const gated = { ...hunkFromDiff('src/pay.ts', "+if (isEnabled('new-pay')) {", '+  charge(card)', '+  audit()', '+  notify()', '+  return ok', '+}'), risk: 3 as const };
    expect(check([gated], ['src/flags/index.ts'], heads)).toEqual([]);
  });
});
