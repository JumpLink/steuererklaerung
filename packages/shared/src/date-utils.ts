/**
 * Date normalization and range-checking utilities.
 * Consolidates date logic previously scattered across paperless-helpers, sync-match, and action files.
 */

/**
 * Normalize an ISO date string or arbitrary date value to YYYY-MM-DD.
 * Returns null if the value is missing or invalid.
 */
export function toDateOnly(value: string | null | undefined): string | null {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const s = typeof value === 'string' ? value.trim() : String(value);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Normalize an unknown value to YYYY-MM-DD. Handles strings only; returns null otherwise.
 */
export function normalizeDateValue(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return toDateOnly(v);
  return null;
}

/**
 * Check if a YYYY-MM-DD date string falls within an inclusive range [from, to].
 * Missing bounds are treated as unbounded (always passes).
 * Returns true if the date is null/empty (can't filter what we don't have).
 */
export function isDateInRange(date: string | null | undefined, from?: string, to?: string): boolean {
  if (!date || date.length < 10) return true;
  const d = date.slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

/**
 * Strict version of isDateInRange: returns false if date is null/empty.
 * Used when you need the document to actually have a date within the range.
 */
export function isDateInRangeStrict(date: string | null | undefined, from: string, to: string): boolean {
  if (!date || date.length < 10) return false;
  const d = date.slice(0, 10);
  return d >= from && d <= to;
}

/**
 * Shift a YYYY-MM-DD date by ±days (UTC-safe). The single day-shift helper —
 * callers like qonto's addDays alias this. Throws on an unparseable input.
 */
export function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${dateStr}`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Calendar-year date range: { from: `${year}-01-01`, to: `${year}-12-31` }. */
export function fiscalYearRange(year: number): { from: string; to: string } {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}
