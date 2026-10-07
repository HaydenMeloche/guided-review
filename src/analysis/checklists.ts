import type { Chapter, ChecklistItem, ChecklistRule, Hunk } from '../types.js';
import { matchGlob } from '../util/glob.js';
import { sha1 } from '../util/hash.js';

// Team checklists: per-path items from repo config. The agent pre-checks each
// item; the reviewer confirms.

export function checklistId(pattern: string, item: string): string {
  return 'ck_' + sha1(`${pattern}\0${item}`).slice(0, 10);
}

export function applicableChecklists(chapters: Chapter[], hunks: Record<string, Hunk>, rules: ChecklistRule[]): Map<string, ChecklistItem[]> {
  const out = new Map<string, ChecklistItem[]>();
  const placed = new Set<string>();
  for (const c of chapters) {
    const files = new Set(c.hunkIds.map((id) => hunks[id]?.file).filter((f): f is string => !!f));
    for (const rule of rules) {
      if (![...files].some((f) => matchGlob(rule.pattern, f))) continue;
      for (const item of rule.items) {
        const id = checklistId(rule.pattern, item);
        if (placed.has(id)) continue;
        placed.add(id);
        const list = out.get(c.id) ?? [];
        list.push({ id, item, pattern: rule.pattern, status: 'unknown' });
        out.set(c.id, list);
      }
    }
  }
  return out;
}
