import fs from 'node:fs';

// GR_DEBUG_MODEL=1 writes one JSON line per model call to stderr; any other value is a file the
// lines are appended to. Unset, nothing is written.
export function logModelCall(entry: Record<string, unknown>): void {
  const target = process.env.GR_DEBUG_MODEL;
  if (!target) return;
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
  try {
    if (target === '1') process.stderr.write(line);
    else fs.appendFileSync(target, line);
  } catch {
    // A debug log must never fail a call.
  }
}
