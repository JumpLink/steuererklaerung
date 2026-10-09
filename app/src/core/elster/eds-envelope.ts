/**
 * Shared ELSTER EDS (DatenSatz) envelope builder.
 *
 * Wraps a Nutzdaten payload in the TransferHeader + NutzdatenHeader envelope
 * required by ERiC's EricBearbeiteVorgang. Extracted from buildUstvaEds so that
 * the USt-VA, Anlage-EÜR (EUER) and USt-Jahres (UStE) XML builders share one
 * envelope — only the Verfahren/DatenArt and the inner Nutzdaten block differ.
 */

/**
 * The ELSTER placeholder Hersteller-ID: "no registered software id". Exported because three places
 * need to agree on it — the envelope's default, Kz09 in the USt-VA, and the guard that refuses to
 * transmit a snapshot still carrying it ({@link hasPlaceholderHerstellerId}).
 */
export const PLACEHOLDER_HERSTELLER_ID = '00000';

/** XML-escape a text value for safe insertion into element content/attributes. */
export function escapeXml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export interface EdsEnvelopeOptions {
    /**
     * `ElsterAnmeldung` for UStVA; `ElsterErklaerung` for the annual returns (EUER, UStE);
     * `ElsterKontoabfrage` for a Steuerkonto query, which asks rather than declares.
     */
    verfahren: 'ElsterAnmeldung' | 'ElsterErklaerung' | 'ElsterKontoabfrage';
    /** e.g. `UStVA`, `UStE`, `EUER`. */
    datenArt: string;
    /** e.g. `send-NoSig`. */
    vorgang: string;
    /** When true, stamps the ELSTER Testmerker (700000004). */
    testMode: boolean;
    /** Datei compression; GZIP for most forms, NO_BASE64 for the Feststellung (FEIN). */
    kompression?: 'GZIP' | 'NO_BASE64';
    /** Registered software HerstellerID; ELSTER placeholder `00000` by default. */
    herstellerId?: string;
    /** DatenLieferant (free-form); empty by default. */
    datenLieferant?: string;
    /** Empfaenger (BuFa) id, inserted into `<Empfaenger id="F">…</Empfaenger>`. */
    empfaenger: string;
    /**
     * TransferHeader Land-Ziel `<Empfaenger id="L"><Ziel>…</Ziel></Empfaenger>` (2-letter
     * Bundesland code, e.g. `NI`). The ESt (E10) reference example carries it; the other
     * declarations (EUER/UStE/GewSt/FEIN) don't. Omitted when unset.
     */
    empfaengerZiel?: string;
    /**
     * NutzdatenHeader `<Hersteller>` ProduktName. When set, the Hersteller block +
     * `<DatenLieferant>` are emitted in the NutzdatenHeader (required by the
     * ElsterErklaerung NutzdatenHeader; omitted for UStVA to keep its byte output).
     */
    produktName?: string;
    /** NutzdatenHeader `<Hersteller>` ProduktVersion (paired with produktName). */
    produktVersion?: string;
    /** NutzdatenHeader `<DatenLieferant>` (paired with produktName). */
    nutzdatenLieferant?: string;
    /**
     * The fully-formed inner Nutzdaten block (e.g. `<Anmeldungssteuern …>…</…>`),
     * INCLUDING its 16-space indentation and trailing newline. Inserted verbatim
     * between `<Nutzdaten>` and `</Nutzdaten>`.
     */
    nutzdaten: string;
}

/** Build the complete `<Elster>` EDS document around a Nutzdaten block. */
export function buildEdsEnvelope(opts: EdsEnvelopeOptions): string {
    const testmerker = opts.testMode ? '        <Testmerker>700000004</Testmerker>\n' : '';
    // TH sequence: the Land-Empfänger sits between Testmerker and HerstellerID (like the
    // official est_e10_2025.xml example).
    const empfaengerZiel = opts.empfaengerZiel
        ? '        <Empfaenger id="L">\n' +
          `            <Ziel>${escapeXml(opts.empfaengerZiel)}</Ziel>\n` +
          '        </Empfaenger>\n'
        : '';
    const herstellerId = escapeXml(opts.herstellerId ?? PLACEHOLDER_HERSTELLER_ID);
    // Must be escaped like every other text field: a Datenlieferant is a free-form company
    // name, and a real filing failed on one shaped like "Meier & Schulz GbR" — the bare `&` made
    // ERiC reject the whole EDS with ERIC_IO_PARSE_FEHLER, "expected entity name for reference".
    const datenLieferant = escapeXml(opts.datenLieferant ?? '');
    const ndhHersteller = opts.produktName
        ? '                <Hersteller>\n' +
          `                    <ProduktName>${escapeXml(opts.produktName)}</ProduktName>\n` +
          `                    <ProduktVersion>${escapeXml(opts.produktVersion ?? '')}</ProduktVersion>\n` +
          '                </Hersteller>\n' +
          (opts.nutzdatenLieferant
              ? `                <DatenLieferant>${escapeXml(opts.nutzdatenLieferant)}</DatenLieferant>\n`
              : '')
        : '';
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<Elster xmlns="http://www.elster.de/elsterxml/schema/v11">\n' +
        '    <TransferHeader version="11">\n' +
        `        <Verfahren>${opts.verfahren}</Verfahren>\n` +
        `        <DatenArt>${opts.datenArt}</DatenArt>\n` +
        `        <Vorgang>${opts.vorgang}</Vorgang>\n` +
        testmerker +
        empfaengerZiel +
        `        <HerstellerID>${herstellerId}</HerstellerID>\n` +
        `        <DatenLieferant>${datenLieferant}</DatenLieferant>\n` +
        '        <Datei>\n' +
        '            <Verschluesselung>CMSEncryptedData</Verschluesselung>\n' +
        `            <Kompression>${opts.kompression ?? 'GZIP'}</Kompression>\n` +
        '        </Datei>\n' +
        '    </TransferHeader>\n' +
        '    <DatenTeil>\n' +
        '        <Nutzdatenblock>\n' +
        '            <NutzdatenHeader version="11">\n' +
        '                <NutzdatenTicket>1</NutzdatenTicket>\n' +
        `                <Empfaenger id="F">${escapeXml(opts.empfaenger)}</Empfaenger>\n` +
        ndhHersteller +
        '            </NutzdatenHeader>\n' +
        '            <Nutzdaten>\n' +
        opts.nutzdaten +
        '            </Nutzdaten>\n' +
        '        </Nutzdatenblock>\n' +
        '    </DatenTeil>\n' +
        '</Elster>\n'
    );
}
