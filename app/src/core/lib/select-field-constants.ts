/**
 * Select field option definitions and helper functions.
 * Single source of truth for all Paperless select field options.
 *
 * Paperless-NGX select fields store values as option ID strings (random, per-installation).
 * The label → optionId mapping is stored in sync-config.json under `select_field_options`.
 */

// ---------------------------------------------------------------------------
// Option labels (the canonical values)
// ---------------------------------------------------------------------------

export const SALE_TYPE_OPTIONS = ['GOODS', 'SERVICES'] as const;
export type SaleType = (typeof SALE_TYPE_OPTIONS)[number];

export const TAX_RATE_OPTIONS = ['0%', '5%', '7%', '16%', '19%'] as const;
export type TaxRate = (typeof TAX_RATE_OPTIONS)[number];

export const SUPPLIER_COUNTRY_OPTIONS = [
  // Germany
  'DE',
  // EU-27 (alphabetical by code)
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DK', 'EE', 'ES', 'FI', 'FR',
  'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
  // Common non-EU
  'AU', 'CA', 'CH', 'CN', 'GB', 'IN', 'JP', 'NO', 'US',
] as const;
export type SupplierCountry = (typeof SUPPLIER_COUNTRY_OPTIONS)[number];

/** SKR03-style booking categories for the Steuererklärung (EÜR, USt-VA). */
export const ACCOUNTING_CATEGORY_OPTIONS = [
  // Betriebseinnahmen
  '8400 Erlöse 19% USt',
  '8300 Erlöse 7% USt',
  '8336 Erlöse Reverse Charge',
  '8125 Steuerfreie Auslandsumsätze',
  '8500 Sonstige Erträge/Zinsen',
  // Betriebsausgaben
  '4946 Fremdleistungen',
  '4950 Rechts-/Beratungskosten',
  '4100 Personalkosten (Löhne/Gehälter)',
  '4138 Soziale Abgaben',
  '4210 Miete/Raumkosten',
  '4240 Gas/Strom/Wasser',
  '4360 Versicherungen',
  '4380 Beiträge/Künstlersozialkasse',
  '4500 Kfz-Kosten',
  '4600 Werbe-/Marketingkosten',
  '4670 Reisekosten',
  '4654 Bewirtungskosten',
  '4806 Hosting/Cloud',
  '4921 Telefon/Internet',
  '4930 Bürobedarf',
  '4940 Fortbildung/Fachliteratur',
  '4955 Domains',
  '4964 Software/Lizenzen',
  '4970 Nebenkosten Geldverkehr',
  '4650 Sonstige Betriebsausgaben',
  '0420 Büroeinrichtung/GWG',
  '4830 Abschreibungen (AfA)',
  // Not affecting the GuV
  '1800 Privatentnahme',
  '1810 Privateinlage',
  '1360 Interne Überweisung',
  '1789 Umsatzsteuer-Zahllast (Finanzamt)',
  '2150 Gewerbesteuer',
] as const;

/** Accounting categories that don't require an external receipt/invoice. */
export const NO_RECEIPT_CATEGORIES: readonly string[] = [
  '1800 Privatentnahme',
  '1810 Privateinlage',
  '4970 Nebenkosten Geldverkehr',
  '1360 Interne Überweisung',
  '1789 Umsatzsteuer-Zahllast (Finanzamt)',
  '2150 Gewerbesteuer',
];
export type AccountingCategory = (typeof ACCOUNTING_CATEGORY_OPTIONS)[number];

/** Payment status for a document (used across business + private documents). */
export const PAYMENT_STATUS_OPTIONS = [
  'offen',
  'bezahlt',
  'verrechnet',
  'storniert',
  'nicht-zahlungsrelevant',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUS_OPTIONS)[number];

/** Confidence of an AI-produced annotation. */
export const AI_CONFIDENCE_OPTIONS = ['high', 'medium', 'low'] as const;
export type AiConfidence = (typeof AI_CONFIDENCE_OPTIONS)[number];

/** Whether a document belongs to business, private, or mixed accounting. */
export const DATA_SCOPE_OPTIONS = ['privat', 'geschäftlich', 'gemischt'] as const;
export type DataScope = (typeof DATA_SCOPE_OPTIONS)[number];

// ---------------------------------------------------------------------------
// extra_data for Paperless API (used by setup + migration when creating fields)
// ---------------------------------------------------------------------------

export const SALE_TYPE_EXTRA_DATA = {
  select_options: SALE_TYPE_OPTIONS.map((label) => ({ label })),
};

export const TAX_RATE_EXTRA_DATA = {
  select_options: TAX_RATE_OPTIONS.map((label) => ({ label })),
};

export const SUPPLIER_COUNTRY_EXTRA_DATA = {
  select_options: SUPPLIER_COUNTRY_OPTIONS.map((label) => ({ label })),
};

export const ACCOUNTING_CATEGORY_EXTRA_DATA = {
  select_options: ACCOUNTING_CATEGORY_OPTIONS.map((label) => ({ label })),
};

// Send labels only. setup-fields then ensures each option gets an id (the web UI
// needs ids to render values) and stores a label->index map (the API client pins a
// version that serializes select values as the option index). See setup.ts.
export const PAYMENT_STATUS_EXTRA_DATA = {
  select_options: PAYMENT_STATUS_OPTIONS.map((label) => ({ label })),
};

export const AI_CONFIDENCE_EXTRA_DATA = {
  select_options: AI_CONFIDENCE_OPTIONS.map((label) => ({ label })),
};

export const DATA_SCOPE_EXTRA_DATA = {
  select_options: DATA_SCOPE_OPTIONS.map((label) => ({ label })),
};

// ---------------------------------------------------------------------------
// Label ↔ Option ID mapping helpers
// ---------------------------------------------------------------------------

/** Mapping of label → Paperless option ID. Stored in sync-config.json per select field. */
export type SelectFieldOptionMap = Record<string, string>;

/**
 * Convert a label (e.g. "GOODS") to its Paperless option ID using the stored mapping.
 * Returns null if the label is not in the mapping.
 */
export function selectLabelToOptionId(
  optionMap: SelectFieldOptionMap | undefined,
  label: string,
): string | null {
  if (!optionMap) return null;
  return optionMap[label] ?? null;
}

/**
 * Convert a Paperless option ID back to its label using the stored mapping.
 * Returns null if the ID is not found.
 */
export function selectOptionIdToLabel(
  optionMap: SelectFieldOptionMap | undefined,
  optionId: string,
): string | null {
  if (!optionMap) return null;
  for (const [label, id] of Object.entries(optionMap)) {
    if (id === optionId) return label;
  }
  return null;
}

/**
 * Backward-compatible reader: accepts both pre-migration string labels (e.g. "GOODS")
 * and post-migration option ID strings (e.g. "SynRtAAxDeFup2eQ").
 *
 * - If rawValue is a string that matches a label directly → returns that label
 * - If rawValue is a string that matches an option ID in the map → returns the label
 * - Otherwise → null
 */
export function getSelectFieldLabel(
  validLabels: readonly string[],
  optionMap: SelectFieldOptionMap | undefined,
  rawValue: unknown,
): string | null {
  if (rawValue == null) return null;
  const s = String(rawValue).trim();
  if (s === '') return null;

  // Direct label match (pre-migration or already a known label)
  const upper = s.toUpperCase();
  const directMatch = validLabels.find((l) => l.toUpperCase() === upper);
  if (directMatch) return directMatch;

  // Option ID lookup (post-migration)
  if (optionMap) {
    const label = selectOptionIdToLabel(optionMap, s);
    if (label) return label;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tax rate specific helpers
// ---------------------------------------------------------------------------

/** Parse a tax rate label string (e.g. "19%", "7%", "0%") to its numeric value. */
export function taxRateLabelToNumber(label: string): number | null {
  const trimmed = label.trim().replace(/\s*%\s*$/, '');
  const n = Number(trimmed);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Read a raw tax_rate custom field value (option ID or legacy string) and return the numeric rate.
 * Handles both pre-migration ("19%") and post-migration (option ID) formats.
 */
export function parseTaxRateValue(
  optionMap: SelectFieldOptionMap | undefined,
  rawValue: unknown,
): number | null {
  const label = getSelectFieldLabel(TAX_RATE_OPTIONS, optionMap, rawValue);
  if (label) return taxRateLabelToNumber(label);

  // Fallback: try parsing the raw string as a number (e.g. "19" without %)
  if (typeof rawValue === 'string') {
    return taxRateLabelToNumber(rawValue);
  }

  return null;
}

/**
 * Normalize LLM output like "19%", "19 %", "19" to the canonical label "19%".
 * Returns null if the value doesn't match a known rate.
 */
export function normalizeTaxRateLabel(raw: string | undefined): TaxRate | null {
  if (!raw) return null;
  const n = taxRateLabelToNumber(raw);
  if (n == null) return null;
  const label = `${Math.round(n)}%`;
  return TAX_RATE_OPTIONS.includes(label as TaxRate) ? (label as TaxRate) : null;
}

// ---------------------------------------------------------------------------
// Tolerant label matching
// ---------------------------------------------------------------------------

/**
 * Fold a select label for comparison: trim, lowercase, and transliterate the German umlauts the
 * way a German keyboard-less writer does (ä→ae, ö→oe, ü→ue, ß→ss).
 *
 * Eleven of these labels carry an umlaut — `geschäftlich`, `4930 Bürobedarf`,
 * `8400 Erlöse 19% USt` and friends — and they are typed by hand on the command line. An exact
 * comparison then rejects `--data-scope geschaeftlich` and passes the raw string on to Paperless,
 * which answers with an opaque "Value must be an id of an element in [{…}]". Nothing about that
 * message says "you wrote ae instead of ä".
 */
function foldSelectLabel(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss');
}

/**
 * The canonical label from `labels` that `input` means, or undefined when none does.
 *
 * Tried in order: exact (so existing behaviour is untouched and the common case costs nothing),
 * case-insensitive, then umlaut-folded. A folded match that is AMBIGUOUS — two labels folding to
 * the same string — returns undefined rather than picking one: guessing which category a booking
 * belongs to is exactly the kind of silent decision a tax figure must not rest on.
 */
export function canonicalSelectLabel(labels: readonly string[], input: string): string | undefined {
    if (labels.includes(input)) return input;

    const lower = input.trim().toLowerCase();
    const ciMatches = labels.filter((l) => l.trim().toLowerCase() === lower);
    if (ciMatches.length === 1) return ciMatches[0];

    const folded = foldSelectLabel(input);
    const foldedMatches = labels.filter((l) => foldSelectLabel(l) === folded);
    return foldedMatches.length === 1 ? foldedMatches[0] : undefined;
}
