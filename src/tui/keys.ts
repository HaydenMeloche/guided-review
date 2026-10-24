import type { Hint } from './KeyBar.js';

// A screen's keys, once: what each key is, how docs/usage.md names it, its entry in the key bar
// (its label can depend on the screen's state), and its row in the help. The screens' useInput
// handlers run the actions; tests check every key a handler reads is listed and every listed
// key is in the docs.

export type Bar<C> = { shown: string; label: string | ((c: C) => string); when?: (c: C) => boolean };

export interface KeyDef<C> {
  keys: string[]; // the characters the handler reads
  doc?: string[]; // how docs/usage.md writes them in backticks, if not the same as `keys`
  alias?: boolean; // another key's twin: the docs need not name it
  bar?: Bar<C>; // absent: not in the key bar
  help?: string; // its line in the help; absent: left out of the help
  group?: string; // the help section it is listed under
  name?: string; // the key as the help shows it, if not the bar's or the keys'
}

// The key bar of a screen: the entries whose condition holds, in the table's order, each with
// its help group so the bar can separate the groups.
export function barOf<C>(defs: KeyDef<C>[], ctx: C): Hint[] {
  const out: Hint[] = [];
  for (const d of defs) {
    const b = d.bar;
    if (!b || (b.when && !b.when(ctx))) continue;
    out.push([b.shown, typeof b.label === 'function' ? b.label(ctx) : b.label, d.group]);
  }
  return out;
}

// The key names the docs must mention.
export function docKeys<C>(defs: KeyDef<C>[]): string[] {
  return [...new Set(defs.filter((d) => !d.alias).flatMap((d) => d.doc ?? d.keys))];
}

// One section of the help: a group's rows, each a key and what it does.
export interface HelpSection {
  title: string;
  rows: [string, string][];
}

const shown = (k: string) => (k === ' ' ? 'space' : k);

// A table's help, grouped in the order the groups first appear.
export function helpOf<C>(defs: KeyDef<C>[]): HelpSection[] {
  const sections: HelpSection[] = [];
  for (const d of defs) {
    if (!d.help) continue;
    const title = d.group ?? 'Keys';
    let section = sections.find((s) => s.title === title);
    if (!section) sections.push((section = { title, rows: [] }));
    section.rows.push([d.name ?? d.bar?.shown ?? d.keys.map(shown).join('/'), d.help]);
  }
  return sections;
}
