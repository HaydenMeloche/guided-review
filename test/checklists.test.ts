import { describe, expect, it } from 'vitest';
import { applicableChecklists, checklistId } from '../src/analysis/checklists.js';
import { chapter, hunkFromDiff } from './fixtures/tour.js';

describe('checklists', () => {
  const m = hunkFromDiff('db/migrations/001_add.sql', '+ALTER TABLE x ADD y int;');
  const s = hunkFromDiff('src/api/routes.ts', '+app.get("/x", h)');
  const hunks = { [m.id]: m, [s.id]: s };
  const rules = [
    { pattern: 'db/**', items: ['Migrations are reversible', 'Large tables use online DDL'] },
    { pattern: 'src/**', items: ['New routes have auth'] },
    { pattern: 'ios/**', items: ['Never applies'] },
  ];

  it('places each item on the first chapter it applies to', () => {
    const chapters = [chapter('c1', [s.id]), chapter('c2', [m.id, s.id])];
    const map = applicableChecklists(chapters, hunks, rules);
    expect(map.get('c1')?.map((i) => i.item)).toEqual(['New routes have auth']);
    expect(map.get('c2')?.map((i) => i.item)).toEqual(['Migrations are reversible', 'Large tables use online DDL']);
    const all = [...map.values()].flat();
    expect(all.every((i) => i.status === 'unknown' && /^ck_[0-9a-f]{10}$/.test(i.id))).toBe(true);
    expect(all[0].id).toBe(checklistId('src/**', 'New routes have auth'));
  });
});
