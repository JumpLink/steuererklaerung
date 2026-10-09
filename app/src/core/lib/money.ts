/** Monetary helpers shared across the ELSTER aggregators. */

/** Round a EUR amount to 2 decimal places (cents). Single source for financial rounding. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Format a number as a de-DE amount with 2 decimals (no currency symbol), e.g. `1.234,50`. */
export function fmtDe(n: number): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
