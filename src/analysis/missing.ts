import { addedText as added, changedText as changed, removedText as removed } from '../diff/lines.js';
import { escapeRe } from '../util/regex.js';
import { DOC_PATH, MIGRATION_PATH, PUBLIC_API_LINE, ROUTE_LINE } from './patterns.js';
import type { DiffFile, Flag, Hunk } from '../types.js';

// Missing-change check: what the PR did not change but probably should. Each rule
// needs both a trigger in the diff and evidence that the repo follows the practice,
// to keep false positives low.

interface Ctx {
  listFiles: () => string[];
  readHead: (p: string) => string | undefined;
}

const CLI_FLAG = [
  /\.option\(\s*['"]-{1,2}[\w-]+/, // commander/yargs
  /add_argument\(\s*['"]--[\w-]+/, // argparse
  /click\.option\(\s*['"]--/, // click
  /\bflag\.(String|Bool|Int|Int64|Uint|Float64|Duration|Var)\(/, // Go flag
  /\.(Persistent)?Flags\(\)\.\w+(P|Var|VarP)?\(/, // cobra
  /@(Option|Parameters)\(/, // picocli
];

const MODEL_PATH = /(^|\/)models?\.py$|(^|\/)models\/|Entity\.(kt|java)$|(^|\/)prisma\/schema\.prisma$|(^|\/)entities\//;
const MODEL_LINE = /@Entity\b|@Column\b|@Table\b|models\.\w+Field\(|\bColumn\(|gorm:"|@ManyToOne|@OneToMany|@JoinColumn/;
const PRISMA_FIELD = /^\s*\w+\s+[A-Z]\w*(\[\])?\??(\s+@.*)?\s*$/;

const ENV_READ = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  /os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /os\.environ(?:\.get)?\s*[[(]\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /System\.getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  /os\.(?:Getenv|LookupEnv)\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
];
const COMMON_ENV = new Set(['NODE_ENV', 'CI', 'HOME', 'PATH', 'PWD', 'USER', 'TZ', 'LANG', 'SHELL', 'TERM', 'DEBUG', 'TMPDIR']);
const ENV_EXAMPLE = /(^|\/)\.env\.(example|sample|template|dist|defaults)$|(^|\/)(example|sample)\.env$/;

const LOCALE_FILE =
  /(^|\/)(locales?|i18n|lang|translations|messages)\/[^/]+\.(json|ya?ml|po|properties|ts|js|xml|arb|xliff|strings)$|\.po$|(^|\/)messages(_\w+)?\.properties$|(^|\/)res\/values[^/]*\/strings\.xml$|\.xcstrings$/;
const I18N_CALL =
  /(?:\bi18n\.t|\$t|\bt|\bgettext|\bngettext|\b_|intl\.formatMessage|\bformatMessage)\(\s*\{?\s*(?:id:\s*)?['"`]([\w.:-]+)['"`]|stringResource\(\s*R\.string\.(\w+)|getString\(\s*R\.string\.(\w+)/g;

const FLAG_USAGE =
  /launchdarkly|ldclient|unleash|growthbook|flagsmith|statsig|split\.io|optimizely|isEnabled\(|isFeatureEnabled|featureFlag|feature_flag|FeatureFlag|flags\.(get|is|enabled)|variation\(/i;

function hunksOf(files: DiffFile[], hunks: Record<string, Hunk>, kinds: string[]): Hunk[] {
  return files.filter((f) => kinds.includes(f.kind)).flatMap((f) => f.hunkIds.map((id) => hunks[id]).filter(Boolean));
}

function matchesAny(text: string, res: RegExp[]): boolean {
  return res.some((re) => re.test(text));
}

export function findMissingChanges(files: DiffFile[], hunks: Record<string, Hunk>, ctx: Ctx): Flag[] {
  const flags: Flag[] = [];
  const all = ctx.listFiles();
  const changedPaths = new Set(files.flatMap((f) => [f.path, f.oldPath].filter((p): p is string => !!p)));
  const logic = hunksOf(files, hunks, ['logic']).filter((h) => !h.importOnly);

  // (a) CHANGELOG / changesets for public API changes.
  const apiHunks = logic.filter((h) => changed(h).some((l) => PUBLIC_API_LINE.test(l) || ROUTE_LINE.test(l)));
  if (apiHunks.length) {
    const usesChangesets = all.some((p) => p.startsWith('.changeset/'));
    const changelog = all.find((p) => /(^|\/)(CHANGELOG|CHANGES|HISTORY)\.md$/i.test(p));
    if (usesChangesets) {
      const added = files.some((f) => f.path.startsWith('.changeset/') && f.path.endsWith('.md'));
      if (!added) flags.push({ kind: 'missing-change', message: 'Public API changed but no changeset was added (.changeset/).', hunkIds: apiHunks.map((h) => h.id) });
    } else if (changelog && ![...changedPaths].some((p) => /(^|\/)(CHANGELOG|CHANGES|HISTORY)\.md$/i.test(p))) {
      flags.push({ kind: 'missing-change', message: `Public API changed but ${changelog} was not updated.`, hunkIds: apiHunks.map((h) => h.id) });
    }
  }

  // (b) Model/entity change without a migration.
  const hasMigrations = all.some((p) => MIGRATION_PATH.test(p));
  if (hasMigrations) {
    const modelHunks = hunksOf(files, hunks, ['logic', 'config']).filter((h) => {
      const lines = changed(h).filter((l) => l.trim() && !/^\s*(import|from|package|#|\/\/)/.test(l));
      if (!lines.length) return false;
      if (MODEL_PATH.test(h.file)) {
        // Python/Prisma/entity files: require a field-like line, not just a helper method.
        if (h.file.endsWith('.prisma')) return lines.some((l) => PRISMA_FIELD.test(l) || /^\s*(model|enum)\s+\w+/.test(l));
        return lines.some((l) => MODEL_LINE.test(l) || /^\s*\w+\s*(:\s*[\w[\]., ]+)?=\s*(models\.|db\.|sa\.|Column\(|mapped_column\(|fields\.)/.test(l));
      }
      return lines.some((l) => /@Entity\b|@Column\b|@Table\b|models\.\w+Field\(|\bmapped_column\(|gorm:"/.test(l));
    });
    const addsMigration = files.some((f) => f.status !== 'deleted' && MIGRATION_PATH.test(f.path));
    if (modelHunks.length && !addsMigration) {
      flags.push({ kind: 'missing-change', message: 'Model or schema fields changed but no migration was added.', hunkIds: modelHunks.map((h) => h.id) });
    }
  }

  // (c) New environment variables not documented in the env example file.
  const envFiles = all.filter((p) => ENV_EXAMPLE.test(p));
  if (envFiles.length && !files.some((f) => ENV_EXAMPLE.test(f.path))) {
    const documented = envFiles.map((p) => ctx.readHead(p) ?? '').join('\n');
    const newVars = new Map<string, string[]>();
    for (const h of hunksOf(files, hunks, ['logic', 'config'])) {
      const before = new Set<string>();
      for (const l of removed(h)) for (const re of ENV_READ) for (const m of l.matchAll(re)) before.add(m[1]);
      for (const l of added(h)) {
        for (const re of ENV_READ) {
          for (const m of l.matchAll(re)) {
            const v = m[1];
            if (before.has(v) || COMMON_ENV.has(v) || new RegExp(`\\b${v}\\b`).test(documented)) continue;
            newVars.set(v, [...(newVars.get(v) ?? []), h.id]);
          }
        }
      }
    }
    if (newVars.size) {
      flags.push({
        kind: 'missing-change',
        message: `New environment variable${newVars.size > 1 ? 's' : ''} ${[...newVars.keys()].slice(0, 4).join(', ')} not in ${envFiles[0]}.`,
        hunkIds: [...new Set([...newVars.values()].flat())],
      });
    }
  }

  // (d) New translation keys when the repo has locale files and none changed.
  const localeFiles = all.filter((p) => LOCALE_FILE.test(p));
  if (localeFiles.length && !files.some((f) => LOCALE_FILE.test(f.path))) {
    const keys = new Map<string, string[]>();
    for (const h of logic) {
      for (const l of added(h)) {
        for (const m of l.matchAll(I18N_CALL)) {
          const key = m[1] ?? m[2] ?? m[3];
          if (key) keys.set(key, [...(keys.get(key) ?? []), h.id]);
        }
      }
    }
    if (keys.size) {
      const corpus = localeFiles
        .slice(0, 40)
        .map((p) => ctx.readHead(p) ?? '')
        .join('\n');
      const missing = [...keys.entries()].filter(([k]) => {
        const leaf = k.split(/[.:]/).pop()!;
        return !corpus.includes(k) && !new RegExp(`["'>]?${escapeRe(leaf)}["'<]?\\s*[:=>]`).test(corpus);
      });
      if (missing.length) {
        flags.push({
          kind: 'missing-change',
          message: `New translation key${missing.length > 1 ? 's' : ''} ${missing
            .slice(0, 4)
            .map(([k]) => k)
            .join(', ')} not found in locale files.`,
          hunkIds: [...new Set(missing.flatMap(([, ids]) => ids))],
        });
      }
    }
  }

  // (e) New CLI flags or routes without docs, when the repo keeps docs.
  const hasDocs = all.some((p) => /^docs?\//.test(p));
  if (hasDocs && ![...changedPaths].some((p) => DOC_PATH.test(p))) {
    const surface = logic.filter((h) => added(h).some((l) => matchesAny(l, CLI_FLAG) || ROUTE_LINE.test(l)));
    if (surface.length) {
      flags.push({ kind: 'missing-change', message: 'New CLI flag or route added but nothing under docs/ changed.', hunkIds: surface.map((h) => h.id) });
    }
  }

  // (f) Risky new code path without a feature flag, in repos that use flags.
  const flagEvidence = all.some((p) => /(^|\/)(feature[-_]?flags?|flags)\//i.test(p)) || files.some((f) => f.kind === 'logic' && FLAG_USAGE.test(ctx.readHead(f.path) ?? ''));
  if (flagEvidence) {
    const risky = logic.filter((h) => {
      if (h.risk < 2) return false;
      const add = added(h);
      if (add.filter((l) => l.trim()).length < 5) return false;
      const newPath = add.some((l) => /\b(if|else|switch|case|when|match|function|def|func|fun)\b|=>/.test(l));
      return newPath && !h.lines.some((l) => FLAG_USAGE.test(l.text));
    });
    if (risky.length) {
      flags.push({ kind: 'missing-change', message: 'Risky new code path with no feature flag check; consider gating it.', hunkIds: risky.map((h) => h.id) });
    }
  }

  return flags;
}
