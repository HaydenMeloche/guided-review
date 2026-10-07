import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../src/diff/parse.js';
import { scoreRisk } from '../src/analysis/risk.js';
import type { FileKind } from '../src/types.js';

function score(path: string, body: string, kind: FileKind = 'logic') {
  const { files, hunks } = parseUnifiedDiff(`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`);
  files[0].kind = kind;
  return scoreRisk(hunks[0], files[0]);
}

describe('scoreRisk', () => {
  it('scores auth high', () => {
    const r = score('src/api/user.ts', '@@ -1,2 +1,2 @@\n const t = req.headers.x;\n-const ok = verifyToken(t);\n+const ok = verifyToken(t, { ignoreExpiry: true });\n');
    expect(r.risk).toBe(3);
    expect(r.reasons).toContain('touches auth: verifies token');
  });

  it('scores payments by path', () => {
    expect(score('src/billing/invoice.ts', '@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n')).toEqual({ risk: 3, reasons: ['touches payments'] });
  });

  it('flags removed and swallowed error handling', () => {
    const removed = score('src/x.ts', '@@ -1,4 +1,1 @@\n-try {\n   run();\n-} catch (e) {\n-  log(e);\n-}\n');
    expect(removed.reasons).toContain('removes error handling');
    const swallowed = score('src/x.ts', '@@ -1 +1 @@\n-run();\n+try { run(); } catch {}\n');
    expect(swallowed.reasons).toContain('swallows errors');
  });

  it('flags concurrency, SQL building and public API changes', () => {
    expect(score('src/x.ts', '@@ -1 +1 @@\n-await a(); await b();\n+await Promise.all([a(), b()]);\n').reasons).toContain('concurrency');
    expect(score('src/x.ts', '@@ -0,0 +1 @@\n+db.query(`SELECT * FROM users WHERE id = ${id}`);\n').reasons).toContain('builds SQL from strings');
    expect(score('src/x.ts', '@@ -1 +1 @@\n-export function get(id: string) {\n+export function get(id: number) {\n').reasons).toContain('changes a public API signature');
  });

  it('is zero for plain logic and non-logic kinds, except migrations', () => {
    expect(score('src/format.ts', '@@ -1 +1 @@\n-const label = "a";\n+const label = "b";\n')).toEqual({ risk: 0, reasons: [] });
    expect(score('src/billing/x.ts', '@@ -1 +1 @@\n-a\n+b\n', 'generated').risk).toBe(0);
    expect(score('db/migrations/001.sql', '@@ -0,0 +1 @@\n+ALTER TABLE users DROP COLUMN name;\n', 'config')).toEqual({
      risk: 3,
      reasons: ['destructive schema change'],
    });
  });
});
