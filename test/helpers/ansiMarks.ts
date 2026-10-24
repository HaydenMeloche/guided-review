// Terminal output as text with its styles marked, in the form the e2e golden screens use:
// ‹cyan,b›n/p‹/› is bold cyan, ‹bg:#1e1e2e›…‹/› a background. Reads the SGR codes Ink writes.

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

interface Style {
  fg?: string;
  bg?: string;
  b?: boolean;
  dim?: boolean;
  i?: boolean;
  u?: boolean;
  inv?: boolean;
}

const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

function apply(s: Style, codes: number[]): Style {
  const out = { ...s };
  for (let k = 0; k < codes.length; k++) {
    const c = codes[k];
    if (c === 0) for (const key of Object.keys(out)) delete out[key as keyof Style];
    else if (c === 1) out.b = true;
    else if (c === 2) out.dim = true;
    else if (c === 3) out.i = true;
    else if (c === 4) out.u = true;
    else if (c === 7) out.inv = true;
    else if (c === 22) out.b = out.dim = false;
    else if (c === 23) out.i = false;
    else if (c === 24) out.u = false;
    else if (c === 27) out.inv = false;
    else if (c >= 30 && c <= 37) out.fg = ANSI[c - 30];
    else if (c >= 90 && c <= 97) out.fg = `bright-${ANSI[c - 90]}`;
    else if (c >= 40 && c <= 47) out.bg = ANSI[c - 40];
    else if (c >= 100 && c <= 107) out.bg = `bright-${ANSI[c - 100]}`;
    else if (c === 39) out.fg = undefined;
    else if (c === 49) out.bg = undefined;
    else if (c === 38 || c === 48) {
      const key = c === 38 ? 'fg' : 'bg';
      if (codes[k + 1] === 5) {
        out[key] = `c${codes[k + 2]}`;
        k += 2;
      } else if (codes[k + 1] === 2) {
        out[key] = hex(codes[k + 2], codes[k + 3], codes[k + 4]);
        k += 4;
      }
    }
  }
  return out;
}

const name = (s: Style) => [s.fg, s.bg && `bg:${s.bg}`, s.b && 'b', s.dim && 'dim', s.i && 'i', s.u && 'u', s.inv && 'inv'].filter(Boolean).join(',');

export function ansiMarks(frame: string): string {
  return frame
    .split('\n')
    .map((row) => {
      let style: Style = {};
      let open = '';
      let out = '';
      for (const part of row.split(/(\u001b\[[\d;]*m)/)) {
        const m = part.match(/^\u001b\[([\d;]*)m$/);
        if (m) {
          style = apply(style, (m[1] || '0').split(';').map(Number));
          continue;
        }
        if (!part) continue;
        const next = name(style);
        if (next !== open) {
          if (open) out += '‹/›';
          if (next) out += `‹${next}›`;
          open = next;
        }
        out += part;
      }
      if (open) out += '‹/›';
      return out.replace(/ +$/, '');
    })
    .join('\n');
}
