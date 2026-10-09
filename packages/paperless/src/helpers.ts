/**
 * Shared helpers for working with Paperless documents and custom fields.
 * Used by paperless-extract-invoice, paperless-find-duplicates, sync-match, and sync-import.
 */

import { isDateInRange } from '@steuererklaerung/shared';

/** Minimal document-like type: anything with optional custom_fields. */
export interface DocumentWithCustomFields {
  custom_fields?: Array<{ field: number; value: unknown }>;
}

/**
 * Get the value of a custom field by ID. Returns undefined if field is missing or ID is invalid.
 */
export function getCustomFieldValue(
  doc: DocumentWithCustomFields,
  fieldId: number,
): unknown {
  if (!doc.custom_fields || fieldId <= 0) return undefined;
  const entry = doc.custom_fields.find((c) => c.field === fieldId);
  return entry?.value;
}

/** A custom-field value coerced to a trimmed string (`''` when unset/empty). */
export function getStringField(doc: DocumentWithCustomFields, fieldId: number): string {
  return String(getCustomFieldValue(doc, fieldId) ?? '').trim();
}

/**
 * Return true if the value is considered empty (null, blank string, or NaN for numbers).
 */
export function isEmptyValue(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'number') return Number.isNaN(v);
  return false;
}

/**
 * Normalize a monetary/numeric value to 2 decimal places for consistent grouping.
 * Handles both plain numbers and Paperless monetary strings (e.g. "USD57.60").
 * Returns null if the value cannot be parsed as a number.
 */
export function normalizeAmountValue(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') {
    return Number.isNaN(v) ? null : Math.round(v * 100) / 100;
  }
  if (typeof v === 'string') {
    // Try parsing as monetary value first (e.g. "USD57.60")
    const parsed = parseMonetaryValue(v);
    if (parsed) return Math.round(parsed.amount * 100) / 100;
    return null;
  }
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Paperless-NGX monetary field helpers (since v2.6.0 / PR #5858)
// ---------------------------------------------------------------------------
//
// The monetary custom field stores values in two formats:
//   - Legacy:  plain number, e.g.  57.60   (currency comes from field's default_currency)
//   - Current: "CUR123.45", e.g. "USD57.60" (3-letter ISO 4217 code prefixed to the number)
//
// We always *write* in the current format and *read* both.

/** Parsed monetary value: amount (number) + ISO 4217 currency code. */
export interface MonetaryValue {
  amount: number;
  currency: string;
}

/** Regex: optional 3-letter currency code followed by a number (with optional sign and decimals). */
const MONETARY_RE = /^([A-Z]{3})?\s*(-?\d[\d,]*(?:\.\d+)?)$/;

/**
 * Parse a Paperless monetary custom field value.
 *
 * Accepted inputs:
 *   - number:  57.60  → { amount: 57.60, currency: defaultCurrency }
 *   - string:  "USD57.60"  → { amount: 57.60, currency: "USD" }
 *   - string:  "57.60"     → { amount: 57.60, currency: defaultCurrency }
 *
 * Returns null if the value cannot be parsed.
 */
export function parseMonetaryValue(
  v: unknown,
  defaultCurrency = 'EUR',
): MonetaryValue | null {
  if (v == null) return null;

  if (typeof v === 'number') {
    if (Number.isNaN(v)) return null;
    return { amount: v, currency: defaultCurrency };
  }

  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    const m = MONETARY_RE.exec(s);
    if (m) {
      const currency = m[1] || defaultCurrency;
      const num = Number(m[2].replace(/,/g, ''));
      if (Number.isNaN(num)) return null;
      return { amount: num, currency };
    }
    // Fallback: try parsing as a plain number
    const n = Number(s);
    if (!Number.isNaN(n)) return { amount: n, currency: defaultCurrency };
    return null;
  }

  return null;
}

/**
 * Format a monetary value for writing to a Paperless monetary custom field.
 * Returns e.g. "USD57.60" or "EUR100.00" (always two decimal places as required by Paperless).
 */
export function formatMonetaryValue(amount: number, currency: string): string {
  return `${currency.toUpperCase()}${amount.toFixed(2)}`;
}

/**
 * Check if a document has a given custom field set (non-empty) and another field NOT set.
 * Used by sync actions to find candidates: e.g. has qonto_transaction_id but no norman_attachment_id.
 */
export function hasSyncField(doc: DocumentWithCustomFields, fieldId: number): boolean {
  const val = getCustomFieldValue(doc, fieldId);
  if (val == null) return false;
  const s = String(val).trim();
  return s !== '' && s !== '0';
}

/**
 * Merge new custom field entries into an existing custom fields array.
 * Replaces entries with matching field IDs, appends new ones.
 */
export function mergeCustomFields(
  existing: Array<{ field: number; value: unknown }>,
  updates: Array<{ field: number; value: unknown }>,
): Array<{ field: number; value: unknown }> {
  const merged = [...existing];
  for (const entry of updates) {
    const idx = merged.findIndex((e) => e.field === entry.field);
    if (idx >= 0) {
      merged[idx] = entry;
    } else {
      merged.push(entry);
    }
  }
  return merged;
}

/**
 * Check if a document's date custom field falls within [dateFrom, dateTo] (inclusive).
 */
export function isDocInDateRange(
  doc: DocumentWithCustomFields,
  dateFieldId: number,
  dateFrom?: string,
  dateTo?: string,
): boolean {
  if (!dateFrom && !dateTo) return true;
  const raw = getCustomFieldValue(doc, dateFieldId);
  const d = raw != null ? String(raw).slice(0, 10) : '';
  return isDateInRange(d || null, dateFrom, dateTo);
}
