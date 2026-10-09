/**
 * Generic parsing utilities for numeric strings and IDs.
 * Consolidates duplicated parsers (parseBbAmount, parseReceiptAmount, parseIdByCustomer).
 */

/**
 * Parse a numeric string (e.g. "-14.85", "1.234,56", "1,234.56") to a number.
 * Returns null if the value is null, empty, or not a valid number.
 *
 * Handles both German (1.234,56) and English (1,234.56) number formats:
 * - If the last separator is a comma → treat comma as decimal (German: "14,85" → 14.85)
 * - If the last separator is a dot → treat dot as decimal (English: "14.85" → 14.85)
 * - Thousands separators are stripped in both cases
 */
export function parseNumericString(s: string | null | undefined): number | null {
  if (s == null || String(s).trim() === '') return null;
  let str = String(s).trim();

  const lastComma = str.lastIndexOf(',');
  const lastDot = str.lastIndexOf('.');

  if (lastComma > lastDot) {
    // German format: "1.234,56" → strip dots, replace comma with dot
    str = str.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    // English format: "1,234.56" → strip commas
    str = str.replace(/,/g, '');
  }
  // No separator or only one type: Number() handles it

  const n = Number(str);
  return Number.isNaN(n) ? null : n;
}

/**
 * Parse a value that may be a number or numeric string to an integer.
 * Returns NaN if the value cannot be parsed. Useful for BB's id_by_customer field.
 */
export function parseIntId(val: number | string | null | undefined): number {
  if (val == null || val === '') return Number.NaN;
  return typeof val === 'number' ? val : parseInt(String(val), 10);
}

/**
 * Parse a number a PERSON typed into a German-language field.
 *
 * Deliberately NOT {@link parseNumericString}, and the difference is one case: a lone dot.
 * `12.500` is twelve and a half thousand to someone typing German, and twelve-point-five to a
 * machine emitting English with three decimals — the same eight characters, two answers a
 * thousandfold apart. Neither reading can be right for both sources, so the SOURCE decides:
 * importers (Amazon, PayPal, Qonto, camt) keep `parseNumericString`, entry fields use this.
 *
 * The rule for the lone dot: thousands grouping only when the whole string IS grouped notation
 * (`12.500`, `1.234.567` — exactly three digits per group). `1.50` therefore stays 1.5.
 *
 * Also strict where `Number.parseFloat` is not: anything that is not entirely a number returns
 * null instead of a partial read, so `12abc` is refused rather than silently stored as 12. That
 * strictness is the point — it is what lets a dialog mark the field and say what is wrong.
 */
export function parseGermanInput(input: string): number | null {
  //   no-break,   narrow no-break: both come along when an amount is copied out of a
  // spreadsheet or a PDF, and both look exactly like a normal space.
  let s = (input ?? '').replace(/[\s  €]/g, '');
  if (s === '') return null;

  let sign = 1;
  if (s.startsWith('-')) {
    sign = -1;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (s === '') return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let decimalAt = -1;
  if (lastDot >= 0 && lastComma >= 0) decimalAt = Math.max(lastDot, lastComma);
  else if (lastComma >= 0) decimalAt = lastComma;
  else if (lastDot >= 0) decimalAt = /^\d{1,3}(\.\d{3})+$/.test(s) ? -1 : lastDot;

  const whole = decimalAt >= 0 ? s.slice(0, decimalAt) : s;
  const fraction = decimalAt >= 0 ? s.slice(decimalAt + 1) : '';

  const groupless = whole.replace(/[.,]/g, '');
  if (!/^\d*$/.test(groupless) || !/^\d*$/.test(fraction)) return null;
  if (groupless === '' && fraction === '') return null;
  // Every remaining separator in the whole part must be a group separator — this rejects `1,2,3`.
  if (/[.,]/.test(whole) && !/^\d{1,3}([.,]\d{3})+$/.test(whole)) return null;

  const value = Number(`${groupless || '0'}.${fraction || '0'}`);
  return Number.isFinite(value) ? sign * value : null;
}
