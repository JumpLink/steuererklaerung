/**
 * BMF Umsatzsteuer-Umrechnungskurse — the monthly average exchange rates the Finanzamt
 * mandates for converting foreign-currency turnover/input tax to EUR in the USt-VA /
 * USt-Jahreserklärung (§ 16 Abs. 6 UStG). Rates are stated as "1 EUR = `rate` foreign
 * currency" (monatliche Durchschnittskurse), published monthly by the BMF:
 *   https://www.bundesfinanzministerium.de → Steuern → Umsatzsteuer → Umsatzsteuer-Umrechnungskurse
 *
 * To convert a foreign amount to EUR: `eur = amount / rate`.
 *
 * Rates live in a plain `bmf-umrechnungskurse.json` (cwd) so they can be extended each month
 * WITHOUT a rebuild; {@link DEFAULT_BMF_RATES} is the bundled fallback when the file is absent.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { ConfigError } from '../lib/errors.ts';

const FILENAME = 'bmf-umrechnungskurse.json';

/** Provenance note written into a freshly-created file (matches the checked-in file's `_comment`). */
const BMF_FILE_COMMENT =
    'BMF Umsatzsteuer-Umrechnungskurse — monatliche Durchschnittskurse (1 EUR = kurs Fremdwaehrung). ' +
    'Quelle: bundesfinanzministerium.de -> Steuern -> Umsatzsteuer -> Umsatzsteuer-Umrechnungskurse. ' +
    'EUR-Umrechnung: betrag / kurs. Aktualisieren mit `bmf-kurse import` (oder Monate/Waehrungen hier ' +
    'von Hand ergaenzen — kein Rebuild noetig).';

/** month key `YYYY-MM` → ISO-4217 currency → rate (1 EUR = rate × currency). */
export type BmfRates = Record<string, Record<string, number>>;

/** Seed rates from the amtliche BMF table (verified 2026-07). Extend via bmf-umrechnungskurse.json. */
export const DEFAULT_BMF_RATES: BmfRates = {
    '2025-12': { USD: 1.1709 },
    '2026-01': { USD: 1.1738 },
    '2026-02': { USD: 1.1824 },
    '2026-03': { USD: 1.1558 },
};

const BmfFileSchema = z.object({
    rates: z.record(z.string(), z.record(z.string(), z.number().positive())),
});

/**
 * Load the BMF rate table, merging the user-maintained `bmf-umrechnungskurse.json`
 * (cwd or `BMF_RATES` env) over the bundled defaults. Falls back to defaults on any error.
 */
export function loadBmfRates(path?: string): BmfRates {
    const p = resolveBmfPath(path);
    if (!existsSync(p)) return DEFAULT_BMF_RATES;
    try {
        const parsed = BmfFileSchema.safeParse(JSON.parse(readFileSync(p, 'utf-8')));
        if (!parsed.success) return DEFAULT_BMF_RATES;
        return { ...DEFAULT_BMF_RATES, ...parsed.data.rates };
    } catch {
        return DEFAULT_BMF_RATES;
    }
}

/** Resolve the `bmf-umrechnungskurse.json` path exactly as {@link loadBmfRates} does. */
export function resolveBmfPath(path?: string): string {
    return path ?? process.env.BMF_RATES ?? join(process.cwd(), FILENAME);
}

/** What a {@link writeBmfRates} merge changed. */
export interface BmfWriteSummary {
    path: string;
    /** Month keys (`YYYY-MM`) touched, sorted. */
    months: string[];
    /** ISO-4217 currencies touched, sorted. */
    currencies: string[];
    /** New `(month, currency)` cells written. */
    added: number;
    /** Existing cells whose value changed. */
    updated: number;
    /** Existing cells already carrying the identical value. */
    unchanged: number;
}

/**
 * Merge `newRates` into `bmf-umrechnungskurse.json`, PRESERVING the file's `_comment` (and any
 * other unknown top-level keys) — modelled on {@link mutateEstConfig}: read the raw JSON, mutate
 * `raw.rates` in place, re-validate the raw object against {@link BmfFileSchema} BEFORE writing, then
 * write pretty JSON (never round-tripping through the zod-normalised object, so `_comment` survives).
 * The CSV/import source is authoritative → existing cells are overwritten; months and currencies not
 * present in `newRates` are left untouched. Creates the file (with the provenance note) when absent.
 * Idempotent: a second identical import reports all cells `unchanged` and rewrites byte-identically.
 */
export function writeBmfRates(newRates: BmfRates, path?: string): BmfWriteSummary {
    const p = resolveBmfPath(path);
    let raw: Record<string, unknown>;
    if (existsSync(p)) {
        try {
            raw = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
        } catch (err) {
            throw new ConfigError(
                `${FILENAME} ist kein gültiges JSON: ${err instanceof Error ? err.message : String(err)}`,
                p,
            );
        }
    } else {
        raw = { _comment: BMF_FILE_COMMENT, rates: {} };
    }
    if (raw.rates == null || typeof raw.rates !== 'object') raw.rates = {};
    const rates = raw.rates as Record<string, Record<string, number>>;

    const months = new Set<string>();
    const currencies = new Set<string>();
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    // New months/currencies are appended in sorted order; the order of keys already on disk is
    // preserved, so a second identical import rewrites byte-identically. (Not a global re-sort.)
    for (const month of Object.keys(newRates).sort()) {
        // The on-disk value came from JSON.parse, so a hand-edit could make it a primitive/array —
        // narrow it (the `in` check below would otherwise throw). The import source is authoritative.
        const onDisk: unknown = rates[month];
        let target: Record<string, number>;
        if (onDisk == null || typeof onDisk !== 'object' || Array.isArray(onDisk)) {
            target = {};
            rates[month] = target;
        } else {
            target = onDisk as Record<string, number>;
        }
        // Canonicalise existing currency keys to uppercase so a hand-typed lowercase key reconciles
        // (last-wins) instead of spawning a duplicate uppercase sibling.
        for (const existing of Object.keys(target)) {
            const up = existing.toUpperCase();
            if (up === existing) continue;
            if (!(up in target)) target[up] = target[existing];
            Reflect.deleteProperty(target, existing);
        }
        for (const currency of Object.keys(newRates[month]).sort()) {
            const value = newRates[month][currency];
            const c = currency.toUpperCase();
            months.add(month);
            currencies.add(c);
            if (!(c in target)) added++;
            else if (target[c] !== value) updated++;
            else {
                unchanged++;
                continue;
            }
            target[c] = value;
        }
    }

    const check = BmfFileSchema.safeParse(raw);
    if (!check.success) {
        const issues = check.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new ConfigError(`Weigere mich, ungültige ${FILENAME} zu schreiben:\n${issues}`, p);
    }
    writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`);
    return { path: p, months: [...months].sort(), currencies: [...currencies].sort(), added, updated, unchanged };
}

/** `YYYY-MM` month key from a `YYYY-MM-DD` date string. */
export function monthKey(date: string): string {
    return date.slice(0, 7);
}

/** BMF rate for a currency in a given month (`YYYY-MM`), or null if not on file. */
export function bmfRateFor(rates: BmfRates, currency: string, month: string): number | null {
    const r = rates[month]?.[currency.toUpperCase()];
    return typeof r === 'number' && r > 0 ? r : null;
}

/**
 * Convert a foreign-currency amount to EUR using the BMF month rate (`eur = amount / rate`).
 * EUR passes through unchanged. Returns null when no rate is on file for that currency+month,
 * so the caller can surface the gap instead of silently dropping or mis-summing the amount.
 */
export function convertToEur(rates: BmfRates, amount: number, currency: string, month: string): number | null {
    if (currency.toUpperCase() === 'EUR') return amount;
    const rate = bmfRateFor(rates, currency, month);
    if (rate == null) return null;
    return Math.round((amount / rate) * 100) / 100;
}
