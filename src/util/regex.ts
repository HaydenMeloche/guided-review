// Escapes a literal for use in a RegExp source (outside a character class).
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One RegExp matching any of `res`; their own flags are dropped.
export function unionRe(res: RegExp[], flags = ''): RegExp {
  return new RegExp(res.map((r) => r.source).join('|'), flags);
}
