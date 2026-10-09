/**
 * Parse the Finanzamt's answer to a {@link buildKontoabfrageEds} query.
 *
 * The answer is grouped per Steuerart, each carrying a list of Teilbeträge — one per period. The
 * field that matters most is `teilbetrag-erlaeuterung`: the Finanzamt writes plain text there,
 * and `"Anmeldung fehlt"` is its own answer to "was this Voranmeldung ever filed?". Nothing in
 * this codebase can establish that on its own; the register only knows what we told it.
 *
 * Parsed with regexes rather than an XML parser, like the other ERiC answer readers here: the
 * shape is fixed by the schema and the runtime has no DOM.
 */

/** One period's entry within a Steuerart. */
export interface KontoabfrageTeilbetrag {
    /** `2025`, `2025-Q1`, … as the Finanzamt writes it. */
    zeitraum: string;
    /** `DD.MM.YYYY`, when present. */
    faelligkeit?: string;
    /** EUR, signed as delivered; absent when the entry only carries an explanation. */
    wert?: number;
    /** Plain text from the Finanzamt — e.g. `Anmeldung fehlt`. */
    erlaeuterung?: string;
}

/** All entries the Finanzamt holds for one Steuerart. */
export interface KontoabfrageSteuerartGruppe {
    steuerart: string;
    gesamtbetrag?: number;
    teilbetraege: KontoabfrageTeilbetrag[];
}

/** The whole answer. */
export interface KontoabfrageErgebnis {
    /** Query timestamp as the Finanzamt stamped it. */
    tagesdatum?: string;
    /** Steuernummer in the readable `FF/BBB/UUUUP` form. */
    steuernummer?: string;
    gesamtsumme?: number;
    /** Free-text note on the whole answer (e.g. why it is empty). */
    erlaeuterung?: string;
    steuerarten: KontoabfrageSteuerartGruppe[];
}

/** Text of the first `<…name>` element in `xml`, namespace prefix ignored. */
function tag(xml: string, name: string): string | undefined {
    const m = xml.match(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`));
    return m ? m[1].trim() || undefined : undefined;
}

/**
 * German decimal to number: `1.234,56` → 1234.56.
 *
 * Returns undefined rather than NaN for anything unparseable — a NaN silently poisons every sum
 * it reaches, and a missing amount is a normal case here (an entry may carry only an explanation).
 */
export function parseGermanAmount(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const n = Number(
        raw
            .replace(/\./g, '')
            .replace(',', '.')
            .replace(/\s|€/g, ''),
    );
    return Number.isFinite(n) ? n : undefined;
}

/** Every `<…outer>…</…outer>` block, namespace prefix ignored. */
function blocks(xml: string, outer: string): string[] {
    const re = new RegExp(`<(?:\\w+:)?${outer}>([\\s\\S]*?)</(?:\\w+:)?${outer}>`, 'g');
    return [...xml.matchAll(re)].map((m) => m[1]);
}

/** Read a Kontoabfrage answer. Unknown/missing fields are omitted, never guessed. */
export function parseKontoabfrage(xml: string): KontoabfrageErgebnis {
    const steuerarten: KontoabfrageSteuerartGruppe[] = [];
    for (const gruppe of blocks(xml, 'abfrage-steuerart')) {
        const teilbetraege: KontoabfrageTeilbetrag[] = [];
        for (const t of blocks(gruppe, 'steuerart-teilbetrag')) {
            const zeitraum = tag(t, 'teilbetrag-zeitraum');
            if (zeitraum === undefined) continue; // a Teilbetrag without a period says nothing
            teilbetraege.push({
                zeitraum,
                faelligkeit: tag(t, 'teilbetrag-faelligkeit'),
                wert: parseGermanAmount(tag(t, 'teilbetrag-wert')),
                erlaeuterung: tag(t, 'teilbetrag-erlaeuterung'),
            });
        }
        steuerarten.push({
            steuerart: tag(gruppe, 'steuerart-klartext') ?? '(unbenannt)',
            gesamtbetrag: parseGermanAmount(tag(gruppe, 'steuerart-gesamtbetrag')),
            teilbetraege,
        });
    }
    return {
        tagesdatum: tag(xml, 'abfrage-tagesdatum'),
        steuernummer: tag(xml, 'abfrage-steuernummer'),
        gesamtsumme: parseGermanAmount(tag(xml, 'abfrage-gesamtsumme')),
        erlaeuterung: tag(xml, 'abfrage-erlaeuterung'),
        steuerarten,
    };
}

/**
 * The periods the Finanzamt marks as never filed, for one Steuerart.
 *
 * This is the question the register cannot answer: it records what WE told it, so a return filed
 * by someone else — a former Steuerberater, a co-partner — leaves no trace in it. A period listed
 * here is one the Finanzamt is still waiting for.
 */
export function fehlendeAnmeldungen(result: KontoabfrageErgebnis, steuerart?: string): string[] {
    const out: string[] = [];
    for (const g of result.steuerarten) {
        if (steuerart && !g.steuerart.toLowerCase().includes(steuerart.toLowerCase())) continue;
        for (const t of g.teilbetraege) {
            if (t.erlaeuterung?.toLowerCase().includes('anmeldung fehlt')) out.push(t.zeitraum);
        }
    }
    return out;
}
