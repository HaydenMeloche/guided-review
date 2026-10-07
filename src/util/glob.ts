// Minimal glob matching: **, *, ?, {a,b}. A pattern with no '/' matches the
// basename anywhere in the tree (like .gitignore).

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let re = '';
  let inBrace = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**/' matches zero or more directories; a trailing '**' matches anything.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      inBrace++;
      re += '(?:';
    } else if (c === '}' && inBrace > 0) {
      inBrace--;
      re += ')';
    } else if (c === ',' && inBrace > 0) {
      re += '|';
    } else if ('\\^$.|+()[]'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  const out = new RegExp('^' + re + '$');
  cache.set(glob, out);
  return out;
}

export function matchGlob(pattern: string, path: string): boolean {
  let p = pattern.trim();
  if (p.startsWith('./')) p = p.slice(2);
  if (p.endsWith('/')) p += '**';
  if (!p.includes('/')) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    return globToRegExp(p).test(base);
  }
  if (p.startsWith('/')) p = p.slice(1);
  return globToRegExp(p).test(path);
}
