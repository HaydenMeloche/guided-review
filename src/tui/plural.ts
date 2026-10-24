// "1 hunk", "3 hunks": a count with its noun, so text never reads "hunk(s)".
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
