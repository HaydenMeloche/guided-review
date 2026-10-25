// The usage page of the website, docs/usage.html, for the tests that check every key is documented.
import fs from 'node:fs';

export const usage = fs.readFileSync(new URL('../../docs/usage.html', import.meta.url), 'utf8');

// The page from the heading with id `from` up to the heading with id `to`.
export const section = (from: string, to: string) => usage.slice(usage.indexOf(`id="${from}"`), usage.indexOf(`id="${to}"`));

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Whether `html` writes the key as code, as `<code>k</code>`.
export const documents = (html: string, key: string) => html.includes(`<code>${escapeHtml(key)}</code>`);
