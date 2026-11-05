const isBoundary = (t: string, j: number): boolean => {
  if (j === 0) return true;
  const p = t[j - 1];
  if (p === '/' || p === '.' || p === '_' || p === '-' || p === ' ') return true;
  // camelCase hump
  return p >= 'a' && p <= 'z' && t[j] >= 'A' && t[j] <= 'Z';
};

// Case-insensitive subsequence score, or undefined when `query` is not a subsequence of
// `target`. Rewards matches at segment starts and contiguous runs; each gap costs a little.
export function fuzzyScore(query: string, target: string): number | undefined {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const n = q.length;
  const m = t.length;
  if (!n) return 0;
  let k = 0;
  for (let j = 0; j < m && k < n; j++) if (t[j] === q[k]) k++;
  if (k < n) return undefined;
  // prev[j]: best score with q[i-1] matched at t[j].
  let prev = new Float64Array(m).fill(-Infinity);
  for (let j = 0; j < m; j++) if (t[j] === q[0]) prev[j] = 1 + (isBoundary(target, j) ? 8 : 0);
  for (let i = 1; i < n; i++) {
    const cur = new Float64Array(m).fill(-Infinity);
    let gapBest = -Infinity; // best prev[k] with k <= j - 2
    for (let j = i; j < m; j++) {
      if (j >= 2) gapBest = Math.max(gapBest, prev[j - 2]);
      if (t[j] !== q[i]) continue;
      const via = Math.max(gapBest - 1, prev[j - 1] + 6);
      if (via > -Infinity) cur[j] = via + 1 + (isBoundary(target, j) ? 8 : 0);
    }
    prev = cur;
  }
  let best = -Infinity;
  for (const v of prev) if (v > best) best = v;
  return best > -Infinity ? best : undefined;
}
