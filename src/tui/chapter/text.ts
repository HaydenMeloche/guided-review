import { sanitizeTerminal } from '../../util/sanitize.js';

export const clean = (s: string) => sanitizeTerminal(s.replace(/\t/g, '  '));
export const safe = sanitizeTerminal;
export const codeChunks = (text: string, width: number) => {
  const code = clean(text);
  const size = Math.max(1, width);
  return code.match(new RegExp(`.{1,${size}}`, 'g')) ?? [''];
};
