import { addedText, removedText } from '../diff/lines.js';
import { unionRe } from '../util/regex.js';
import { MIGRATION_PATH, PUBLIC_API_LINE, ROUTE_LINE, SQL_SCHEMA_PATH } from './patterns.js';
import type { DiffFile, Hunk, Risk } from '../types.js';

interface Rule {
  risk: Risk;
  reason: string;
  path?: RegExp; // matched against the file path
  line?: RegExp; // matched against changed (+/-) lines
  removedOnly?: boolean; // only removed lines count
}

const MIGRATION = unionRe([MIGRATION_PATH, SQL_SCHEMA_PATH], 'i');
const DESTRUCTIVE_SQL = /\b(DROP\s+(TABLE|COLUMN|INDEX|DATABASE)|TRUNCATE|ALTER\s+TABLE\s+\S+\s+DROP|removeColumn|dropTable|drop_column|drop_table)\b/i;

const RULES: Rule[] = [
  // Auth and security
  { risk: 3, reason: 'touches auth', path: /(^|\/)(auth|authn|authz|session|sessions|login|oauth|sso|permissions?|acl|rbac|security)(\/|\.|_|-)/i },
  {
    risk: 3,
    reason: 'touches auth: verifies token',
    line: /\b(verify|validate|decode|sign)\w*(token|jwt|signature)\w*\s*\(|\b(verify|validate|decode)\w*\s*\(.*\b(token|jwt)\b|\bjwt\.\w+\(|\bbearer\b/i,
  },
  { risk: 3, reason: 'touches auth: permission check', line: /\b(isAdmin|hasPermission|hasRole|authorize|canAccess|checkPermission|requireAuth|isAuthenticated|permissions?\s*\.\s*(has|includes))\b/ },
  { risk: 3, reason: 'touches crypto', line: /\b(crypto\.|createHash|createCipher\w*|bcrypt|argon2|scrypt|hmac|randomBytes|encrypt|decrypt|privateKey|secretKey)\b/i },
  { risk: 2, reason: 'handles secrets or credentials', line: /\b(password|passwd|secret|api[_-]?key|credential|access[_-]?token|refresh[_-]?token)\b/i },
  // Payments
  { risk: 3, reason: 'touches payments', path: /(^|\/)(billing|payments?|invoices?|checkout|charges?|subscriptions?|refunds?|stripe|ledger)(\/|\.|_|-)/i },
  { risk: 3, reason: 'touches payments', line: /\b(charge|refund|invoice|payment|stripe|amount_?cents|priceInCents|currency|ledger|payout)\w*\b/i },
  // Data and migrations
  { risk: 3, reason: 'database migration', path: MIGRATION },
  { risk: 3, reason: 'destructive schema change', line: DESTRUCTIVE_SQL },
  { risk: 2, reason: 'schema change', line: /\b(ALTER\s+TABLE|CREATE\s+(TABLE|INDEX)|addColumn|createTable|add_column|create_table|renameColumn)\b/i },
  {
    risk: 2,
    reason: 'builds SQL from strings',
    line: unionRe(
      [
        /(SELECT|INSERT|UPDATE|DELETE)\b[^'"`]*['"`]\s*\+|`[^`]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{|f["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"']*\{|\.raw\(|\$queryRawUnsafe|execute\(\s*f["']/,
        /\.(execute|executemany|raw|extra)\(\s*(f["']|["'][^"']*["']\s*(%|\.format\())|\.(Exec|Query|QueryRow)(Context)?\([^)]*fmt\.Sprintf|createNativeQuery\(\s*"[^"]*"\s*\+|"\s*\+\s*\w+\s*\+\s*"[^"]*\b(WHERE|AND|OR)\b/,
      ],
      'i',
    ),
  },
  // Concurrency
  {
    risk: 2,
    reason: 'concurrency',
    line: /\b(Mutex|RWMutex|Semaphore|Lock\(\)|\.lock\(|\.unlock\(|synchronized|Atomic\w+|atomic\.|sync\.WaitGroup|go\s+func|chan\s+\w+|Promise\.(all|race|allSettled|any)|threading\.|asyncio\.(gather|create_task)|Worker\(|SharedArrayBuffer)\b/,
  },
  { risk: 2, reason: 'coroutines', line: /\b(launch|async)\s*(\([^)]*\))?\s*\{|\b(runBlocking|withContext|GlobalScope|supervisorScope|coroutineScope|Dispatchers\.\w+)\b|@(Synchronized|Volatile)\b/ },
  { risk: 2, reason: 'goroutine', line: /^\s*go\s+[\w.]+\(/ },
  { risk: 2, reason: 'panic recovery', line: /\bdefer\s+func\s*\(\s*\)\s*\{[^}]*recover\(\)|\brecover\(\)/ },
  { risk: 3, reason: 'runs a shell command', line: /subprocess\.\w+\([^)]*shell\s*=\s*True|os\.(system|popen)\(|Runtime\.getRuntime\(\)\.exec|ProcessBuilder\(|exec\.Command\(\s*"(sh|bash)"/ },
  { risk: 2, reason: 'deserializes untrusted data', line: /\b(pickle|marshal|dill)\.loads?\(|yaml\.load\((?![^)]*SafeLoader)|ObjectInputStream\(/ },
  { risk: 2, reason: 'retries or timing', line: /\b(setTimeout|setInterval|retry|retries|backoff|sleep\(|time\.Sleep|debounce|throttle)\w*/i },
  { risk: 2, reason: 'transaction boundary', line: /\b(transaction|BEGIN|COMMIT|ROLLBACK|\$transaction|withTransaction|atomic\(\))\b|@Transactional\b|\.Begin(Tx)?\(|transaction\.atomic/ },
  // Error handling
  { risk: 2, reason: 'removes error handling', line: /\b(catch|except|rescue|recover\(\)|if\s+err\s*!=\s*nil|\.catch\()/, removedOnly: true },
  { risk: 2, reason: 'swallows errors', line: /catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}|except\s*(\w+\s*)?:\s*pass\b|\.catch\(\s*\(\)\s*=>\s*(\{\s*\}|undefined|null)\s*\)|_\s*=\s*err\b/ },
  { risk: 1, reason: 'changes thrown errors', line: /\b(throw\s+new|raise\s+\w+|panic\()/ },
  // Public API
  { risk: 2, reason: 'route or handler change', line: ROUTE_LINE },
  // Shell commands and deserialization have their own, higher rules above.
  { risk: 1, reason: 'unsafe input handling', line: /\b(eval\(|new Function\(|innerHTML|dangerouslySetInnerHTML|exec\(|execSync\(|child_process|subprocess\.)/ },
];

export function scoreRisk(hunk: Hunk, file: DiffFile): { risk: Risk; reasons: string[] } {
  const removed = removedText(hunk);
  const added = addedText(hunk);
  const changed = [...added, ...removed];
  const path = file.path;

  if (file.kind !== 'logic') {
    // Migrations matter wherever they are classified.
    if (MIGRATION.test(path) || (file.oldPath && MIGRATION.test(file.oldPath))) {
      const destructive = changed.some((l) => DESTRUCTIVE_SQL.test(l));
      return { risk: 3, reasons: [destructive ? 'destructive schema change' : 'database migration'] };
    }
    return { risk: 0, reasons: [] };
  }

  const hits = new Map<string, Risk>();
  const add = (reason: string, risk: Risk) => {
    if ((hits.get(reason) ?? -1) < risk) hits.set(reason, risk);
  };
  for (const r of RULES) {
    if (r.path && !r.line) {
      if (r.path.test(path)) add(r.reason, r.risk);
      continue;
    }
    if (!r.line) continue;
    const lines = r.removedOnly ? removed : changed;
    if (!lines.some((l) => r.line!.test(l))) continue;
    if (r.removedOnly && added.some((l) => r.line!.test(l))) continue; // moved, not removed
    add(r.reason, r.risk);
  }

  // Exported signature changes: a public declaration that was removed or rewritten.
  if (removed.some((l) => PUBLIC_API_LINE.test(l))) add('changes a public API signature', 2);
  else if (added.some((l) => PUBLIC_API_LINE.test(l)) && file.status !== 'added') add('adds to the public API', 1);

  // Large deletions.
  if (removed.length >= 30 && removed.length > added.length * 2) add(`deletes ${removed.length} lines`, 2);
  else if (removed.length >= 10 && !added.length) add(`deletes ${removed.length} lines`, 1);

  if (!hits.size) return { risk: 0, reasons: [] };
  const sorted = [...hits.entries()].sort((a, b) => b[1] - a[1]);
  let risk = sorted[0][1];
  // Several independent medium signals compound.
  if (risk === 2 && sorted.filter(([, r]) => r === 2).length >= 3) risk = 3;
  return { risk, reasons: sorted.slice(0, 3).map(([reason]) => reason) };
}

export function applyRisk(files: DiffFile[], hunks: Record<string, Hunk>): void {
  for (const f of files) {
    for (const id of f.hunkIds) {
      const h = hunks[id];
      if (!h) continue;
      const { risk, reasons } = scoreRisk(h, f);
      h.risk = risk;
      h.riskReasons = reasons;
    }
  }
}
