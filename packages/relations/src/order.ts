// Deterministic ordering: plain UTF-16 code unit comparison, never
// localeCompare (its result depends on the runtime's ICU data).

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Orders relations and candidates by `(type, from, to)`. */
export function compareTriples(
  a: { type: string; from: string; to: string },
  b: { type: string; from: string; to: string },
): number {
  return (
    compareStrings(a.type, b.type) || compareStrings(a.from, b.from) || compareStrings(a.to, b.to)
  );
}

/** Rounds a score to four decimals so that equal inputs give byte-identical output. */
export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
