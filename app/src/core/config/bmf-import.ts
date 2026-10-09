/**
 * Import BMF Umsatzsteuer-Umrechnungskurse from the official yearly CSV into
 * `bmf-umrechnungskurse.json`.
 *
 * The BMF publishes NO data API — GovData's CKAN entry (`umsatzsteuer-umrechnungskurse-seit-2010`)
 * carries only metadata (`metadata_modified`, a useful change-signal), and the only machine-readable
 * artifacts are the yearly CSV/XLSX files on bundesfinanzministerium.de, served behind a Radware bot
 * wall. So this module fetches the CSV directly (best-effort, with a full browser header set + a
 * bot-wall detector so a captcha page is never ingested as data) or parses a locally-saved `--file`.
 * The rates originate from the ECB euro reference rates, republished monthly per §16 Abs. 6 UStG.
 *
 * CSV format (yearly "Monatlich fortgeschriebene Übersicht"): Windows-1252, CRLF, `;`-delimited,
 * unquoted, 14 columns. Row 1 = title (carries the year), row 2 = header, then one country row per
 * currency (`col[1]` == "1 Euro"), `col[2..13]` = Jan..Dez cells "wert CUR" (German number:
 * thousands `.`, decimal `,`; ISO code may be glued or trailing-spaced; empty = no rate, e.g. RUB).
 */

import type { BmfRates } from './bmf-rates.ts';
import { writeBmfRates } from './bmf-rates.ts';
import { parseNumericString } from '../lib/parsing.ts';

/** Official yearly CSV. `?__blob=publicationFile` is REQUIRED; the `&v=` cache-buster is ignored. */
export function bmfCsvUrl(year: number): string {
    return (
        'https://www.bundesfinanzministerium.de/Datenportal/Daten/offene-daten/steuern-zoelle/' +
        `umsatzsteuer-umrechnungskurse/datensaetze/uu-kurse-${year}-csv.csv?__blob=publicationFile`
    );
}

/** A rate cell: German number (`1.634,39` / `0,83908` / `1,1677`) + trailing ISO-4217 code. */
const CELL_RE = /(\d[\d.]*,\d+|\d+)\s*([A-Za-z]{3})/;

/** One shared decoder for the Windows-1252 CSV bytes (stateless for one-shot decode). */
const WIN1252 = new TextDecoder('windows-1252');

export interface BmfParseResult {
    /** Calendar year taken from the CSV title row. */
    year: number;
    /** `YYYY-MM` → ISO-4217 currency → rate (1 EUR = rate × currency). */
    rates: BmfRates;
    /** Distinct ISO-4217 codes found, sorted. */
    currencies: string[];
    /** Populated (non-empty) month cells parsed. */
    cells: number;
}

/**
 * Parse a BMF Umrechnungskurse CSV (yearly format) into month-keyed rates. Decodes Windows-1252,
 * keeps rows whose Währung column is exactly `1 Euro`, maps column `m+1` → month `m`, tolerates
 * glued codes / trailing spaces / thousands dots, and skips empty cells (suspended currencies).
 * Throws on input that is not a BMF CSV (e.g. a Radware challenge page).
 */
export function parseBmfCsv(bytes: Uint8Array): BmfParseResult {
    const text = WIN1252.decode(bytes);
    const lines = text.split(/\r?\n/);
    // The title row carries the year, e.g. "… Umrechnungskurse 2025 (Euro-Referenzkurse)".
    const yearMatch = lines[0]?.match(/\b(20\d{2})\b/);
    if (!yearMatch) {
        throw new Error('BMF-CSV: kein Jahr in der Titelzeile — falsche Datei oder Bot-Sperre-Seite?');
    }
    const year = Number.parseInt(yearMatch[1], 10);

    const rates: BmfRates = {};
    const currencies = new Set<string>();
    let cells = 0;
    let dataRows = 0;
    for (const line of lines) {
        const fields = line.split(';');
        // Golden data-row rule: the Währung column is literally "1 Euro" (excludes title, header and
        // all footnote rows, but INCLUDES a currency row with all-empty cells like RUB/Russland).
        if (fields.length < 3 || fields[1].trim() !== '1 Euro') continue;
        dataRows++;
        for (let m = 1; m <= 12; m++) {
            const cell = fields[m + 1]?.trim();
            if (!cell) continue; // empty → no published rate that month
            const mm = cell.match(CELL_RE);
            if (!mm) continue;
            const value = parseNumericString(mm[1]);
            if (value == null || !Number.isFinite(value) || value <= 0) continue;
            const currency = mm[2].toUpperCase();
            const key = `${year}-${String(m).padStart(2, '0')}`;
            (rates[key] ??= {})[currency] = value;
            currencies.add(currency);
            cells++;
        }
    }
    if (dataRows === 0) {
        throw new Error('BMF-CSV: keine Datenzeilen ("1 Euro") gefunden — falsches Format oder Bot-Sperre-Seite?');
    }
    return { year, rates, currencies: [...currencies].sort(), cells };
}

/**
 * Full browser header set. Radware Bot Manager challenges bare requests but reliably passes a
 * complete browser fingerprint (empirically 15/15); it scores the whole set, so send all of it.
 */
const BROWSER_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
    Referer:
        'https://www.bundesfinanzministerium.de/Web/DE/Themen/Steuern/Steuerarten/Umsatzsteuer/' +
        'Umsatzsteuer_Umrechnungskurse/umsatzsteuer_umrechnungskurse.html',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Upgrade-Insecure-Requests': '1',
};

/**
 * Best-effort live fetch of the yearly BMF CSV. Sends the full browser header set to pass the
 * Radware bot wall, then DETECTS a challenge page — the real CSV begins with "Monatlich", a
 * challenge is HTML — so a captcha is never parsed as data; it throws a clear "use --file" error
 * instead. Returns the raw CSV bytes (still Windows-1252 encoded; {@link parseBmfCsv} decodes them).
 */
export async function fetchBmfCsv(year: number, url?: string): Promise<Uint8Array> {
    const target = url ?? bmfCsvUrl(year);
    const res = await fetch(target, { headers: BROWSER_HEADERS, redirect: 'follow' });
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!res.ok) {
        throw new Error(`BMF-CSV-Download fehlgeschlagen: HTTP ${res.status} — ${target}`);
    }
    // A genuine CSV starts with the title "Monatlich …"; anything else is an error/challenge page.
    const head = WIN1252.decode(bytes.slice(0, 400)).trimStart();
    if (!head.startsWith('Monatlich')) {
        throw new Error(
            'BMF-CSV-Download lieferte keine CSV (vermutlich die Radware-Bot-Sperre). ' +
                'Bitte die CSV manuell im Browser laden und mit `--file <pfad>` importieren.',
        );
    }
    return bytes;
}

/** What an import fetched, parsed and wrote. */
export interface BmfImportResult {
    /** The year the CSV itself declares — authoritative over the requested one. */
    year: number;
    currencies: string[];
    cells: number;
    /** Where the rates were written. */
    path: string;
    added: number;
    updated: number;
    unchanged: number;
}

/**
 * Fetch the official BMF conversion-rate CSV for a year, parse it, and write the rates.
 *
 * Extracted from the `bmf-kurse import` CLI handler, which held the only copy of the sequence. The
 * USt-VA export is BLOCKED without these rates — a foreign-currency receipt would otherwise be
 * silently dropped from the figures — and the app could only tell the user to go and run that CLI
 * command, which is precisely the dead end a GUI is supposed to remove.
 *
 * The CSV's own year wins over the requested one: `year` only builds the download URL, and a
 * mismatch is reported rather than silently writing the wrong year's rates.
 */
export async function importBmfRates(
    year: number,
    opts: { url?: string; output?: string } = {},
): Promise<BmfImportResult> {
    const bytes = await fetchBmfCsv(year, opts.url);
    const parsed = parseBmfCsv(bytes);
    const summary = writeBmfRates(parsed.rates, opts.output);
    return {
        year: parsed.year,
        currencies: parsed.currencies,
        cells: parsed.cells,
        path: summary.path,
        added: summary.added,
        updated: summary.updated,
        unchanged: summary.unchanged,
    };
}
