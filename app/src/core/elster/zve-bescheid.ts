/**
 * Read the **zu versteuerndes Einkommen** (zvE, §2 Abs. 5 EStG) out of the OCR text of an
 * Einkommensteuerbescheid. Pure — text in, candidates out, no I/O — so it is fully unit-testable
 * against synthetic Bescheid text.
 *
 * This module PROPOSES, it never decides: it returns every line that looks like the zvE line plus a
 * single `vorschlag` only when all hits agree, and the caller shows those lines to a human who
 * confirms before anything is written (the same "vorschlagen und bestätigen" shape as the Beleg
 * intake). A silently mis-parsed Bescheid figure would be worse than no figure at all — it would
 * look binding.
 *
 * Source of the term + where it sits in the Bescheid: docs/references/tax-sources.md
 * ("§2 Abs. 5 EStG — zu versteuerndes Einkommen").
 */

/** A line of the Bescheid that carries a zvE candidate, kept verbatim for human confirmation. */
export interface ZvEBescheidTreffer {
    /** Parsed amount in EUR. */
    betrag: number;
    /** The source line (whitespace-collapsed) — shown so a human can check it against the PDF. */
    zeile: string;
}

export interface ZvEBescheidScan {
    /** The value to propose — set ONLY when at least one hit exists and all hits agree. */
    vorschlag: number | null;
    /** Veranlagungsjahr read off the Bescheid heading, if it states one. */
    jahr: number | null;
    treffer: ZvEBescheidTreffer[];
    /** Why there is no proposal / what a human has to decide. Always safe to print. */
    hinweise: string[];
}

/**
 * The zvE label as a Bescheid spells it, in any grammatical case: "zu versteuerndes Einkommen",
 * "zu versteuernden Einkommens", "zu versteuernde Einkommen". `\w*` also swallows the OCR-common
 * merged endings.
 */
const ZVE_LABEL = /zu\s+versteuernde\w*\s+einkommen\w*/i;

/**
 * A German money amount that is unambiguously one: it must carry a decimal comma (`45678,00`) or a
 * thousands dot (`45.678`). A bare run of digits is deliberately NOT accepted — on a Bescheid line
 * that would just as happily match a Veranlagungsjahr, a Kennziffer or a Steuernummer fragment, and
 * proposing one of those as the zvE is exactly the failure this whole module exists to prevent.
 * Reporting "nichts erkannt" is the safe outcome; the human then types the figure.
 */
const GERMAN_AMOUNT = /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+/g;

/**
 * Parse a German-formatted amount ("45.678,00", "45.678", "45678,90") to a number.
 *
 * Deliberately NOT `lib/parsing.ts parseNumericString`: that one decides German-vs-English by which
 * separator comes last, so "45.678" (the exact shape a Bescheid prints for a full-euro figure) is
 * read as English and yields 45.678 instead of 45678. A Bescheid is always German, so the format is
 * known here and needs no heuristic.
 */
function parseGermanAmount(raw: string): number | null {
    const n = Number(raw.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

/** Every German amount in a string, in order of appearance. */
function amountsIn(text: string): number[] {
    const matches = text.match(GERMAN_AMOUNT) ?? [];
    return matches.map(parseGermanAmount).filter((n): n is number => n != null);
}

/**
 * The amounts that FOLLOW the zvE label on a line, in order.
 *
 * Taking the FIRST of them, not the last one on the line, is what makes the prose form safe: a
 * Bescheid also writes "Steuer laut Grundtabelle für ein zu versteuerndes Einkommen von 41.234 EUR:
 * 7.000,00 EUR" — the last amount there is the assessed TAX, not the income. In the table form
 * ("zu versteuerndes Einkommen … 41.234,00") first and last are the same value, so nothing is lost.
 */
function amountsAfterLabel(line: string): number[] {
    const label = ZVE_LABEL.exec(line);
    if (!label) return [];
    return amountsIn(line.slice(label.index + label[0].length));
}

/** Veranlagungsjahr from the Bescheid heading ("Einkommensteuerbescheid für 2024"). */
function scanJahr(lines: string[]): number | null {
    for (const line of lines) {
        if (!/einkommensteuerbescheid|veranlagungszeitraum/i.test(line)) continue;
        const year = /\b(19|20)\d{2}\b/.exec(line);
        if (year) return Number(year[0]);
    }
    return null;
}

/**
 * Scan Bescheid OCR text for the zvE. Returns every candidate line with its amount; `vorschlag` is
 * set only when the candidates agree, so a Bescheid that states the figure twice with different
 * numbers (an Änderungsbescheid printing alt/neu side by side) forces a human decision instead of
 * silently picking one.
 */
export function scanZvEFromBescheid(text: string): ZvEBescheidScan {
    const lines = (text ?? '')
        .split(/\r?\n/)
        .map((l) => l.replace(/\s+/g, ' ').trim())
        .filter((l) => l.length > 0);

    const treffer: ZvEBescheidTreffer[] = [];
    const hinweise: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!ZVE_LABEL.test(line)) continue;
        const onLine = amountsAfterLabel(line);
        if (onLine.length > 0) {
            treffer.push({ betrag: onLine[0], zeile: line });
            // An Änderungsbescheid prints alt and neu in two columns of ONE row; we cannot tell that
            // apart from the harmless prose form, so we propose the first and say the line is not
            // self-evident. Silently picking a column is what this module must never do.
            if (onLine.length > 1) {
                hinweise.push(
                    `Die Zeile „${line}" enthält ${onLine.length} Beträge — die Fundstelle gegen den Bescheid gegenlesen.`,
                );
            }
            continue;
        }
        // Two-column OCR splits label and value across lines. Only accept a NEXT line that is
        // nothing but an amount (optionally with a currency) — anything else and we would be
        // guessing which of the following numbers belongs to the label.
        const next = lines[i + 1];
        if (next && /^-?[\d.,]+\s*(?:eur|€)?$/i.test(next)) {
            const below = amountsIn(next);
            if (below.length > 0) treffer.push({ betrag: below[0], zeile: `${line} ⏎ ${next}` });
        }
    }

    const werte = [...new Set(treffer.map((t) => t.betrag))];
    let vorschlag: number | null = null;
    if (werte.length === 1) {
        vorschlag = werte[0];
    } else if (werte.length === 0) {
        hinweise.push(
            'Kein „zu versteuerndes Einkommen" mit eindeutigem Betrag im Text gefunden — Wert von Hand aus dem Bescheid übernehmen.',
        );
    } else {
        hinweise.push(
            `Mehrdeutig: ${werte.length} verschiedene Beträge zum „zu versteuernden Einkommen" gefunden — den gültigen Wert aus dem Bescheid wählen.`,
        );
    }

    return { vorschlag, jahr: scanJahr(lines), treffer, hinweise };
}
