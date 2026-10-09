/**
 * ELSTER Steuerkontoabfrage — ask the Finanzamt what IT has on record.
 *
 * Every other builder here SENDS a declaration. This one asks a question, and the answer is the
 * only authoritative source for two things the rest of the codebase can currently only guess:
 *
 *   - which Voranmeldungen actually reached the Finanzamt, and with which Soll. The
 *     `ustva-vs-uste` cross-check reconstructs this from Paperless documents and is wrong
 *     whenever a booking has no receipt — it had to be downgraded from error to warning
 *     precisely because its own yardstick is unreliable.
 *   - what has been PAID. `paidAt` in the filing register is filled by hand, and a payment made
 *     from an account we do not import (a co-partner's, say) is invisible to us entirely.
 *
 * Three query shapes, all `Verfahren: ElsterKontoabfrage` / `DatenArt: Kontoabfrage`:
 *   - `O`  offene Posten: Steuernummer only → everything still open, across Steuerarten
 *   - `ZS` Sollstellungen: + Steuerart + Zeitraum → what was assessed for one year
 *   - `I`  Einzelabfrage: + Steuerart + Wertstellungsdatum
 *
 * AUTHORISATION IS SERVER-SIDE. Building the request grants nothing: the certificate must be
 * authorised for that Steuernummer. A certificate registered to one Steuernummer can file for
 * another (submission needs no prior authorisation) but cannot read that other account.
 */

import type { ElsterConfig } from '../config/index.ts';
import { buildEdsEnvelope, escapeXml } from './eds-envelope.ts';
import { toElsterSteuernummer, bufaFromElsterSteuernummer } from './steuernummer.ts';

/** ERiC datenartVersion for the Kontoabfrage (schema v6, not year-scoped like the declarations). */
export const KONTOABFRAGE_DATENART_VERSION = 'ElsterKontoabfrage_6';

const NS_KONTOABFRAGE = 'http://finkonsens.de/elster/elsterkontoabfrage/kontoabfrage/v6';
const NS_I = 'http://www.elster.de/KontoAbfrage/I-Abfrage/06';
const NS_O = 'http://www.elster.de/KontoAbfrage/O-Abfrage/06';
const NS_ZS = 'http://www.elster.de/KontoAbfrage/ZS-Abfrage/06';

/** Steuerarten the Kontoabfrage accepts (schema enumeration). */
export type KontoabfrageSteuerart = 'ESt' | 'GewSt' | 'KapESt' | 'KSt' | 'LSt' | 'USt' | 'ZaSt';

/** Offene Posten for a Steuernummer — no further narrowing. */
export interface KontoabfrageOffenePosten {
    art: 'O';
}

/** Sollstellungen for one Steuerart and year — the shape that answers "which VAs are on record". */
export interface KontoabfrageSollstellungen {
    art: 'ZS';
    steuerart: KontoabfrageSteuerart;
    /** Four-digit year. */
    zeitraum: number;
}

/** Einzelabfrage for one Steuerart at a Wertstellungsdatum (`DDMMYYYY`). */
export interface KontoabfrageEinzel {
    art: 'I';
    steuerart: KontoabfrageSteuerart;
    wertstellungsdatum: string;
    /** `V` (vor) / `N` (nach) / `G` (genau) — how to read the date. */
    option: 'V' | 'N' | 'G';
}

export type KontoabfrageQuery = KontoabfrageOffenePosten | KontoabfrageSollstellungen | KontoabfrageEinzel;

/** The `<kontoabfrage-input>` block for one query, at the EDS 24-space indent. */
function inputBlock(query: KontoabfrageQuery, steuernummer: string): string {
    const ind = '                            ';
    const p = query.art === 'O' ? 'o' : query.art === 'ZS' ? 'zs' : 'i';
    const lines = [`${ind}<${p}:kontoabfrage-art>${query.art}</${p}:kontoabfrage-art>`];
    lines.push(`${ind}<${p}:steuernummer>${escapeXml(steuernummer)}</${p}:steuernummer>`);
    if (query.art === 'ZS') {
        lines.push(`${ind}<${p}:steuerart>${query.steuerart}</${p}:steuerart>`);
        lines.push(`${ind}<${p}:zeitraum>${escapeXml(String(query.zeitraum))}</${p}:zeitraum>`);
    } else if (query.art === 'I') {
        lines.push(`${ind}<${p}:steuerart>${query.steuerart}</${p}:steuerart>`);
        lines.push(
            `${ind}<${p}:wertstellungsdatum option="${query.option}">` +
                `${escapeXml(query.wertstellungsdatum)}</${p}:wertstellungsdatum>`,
        );
    }
    return lines.join('\n') + '\n';
}

/**
 * Build the complete EDS request for one Steuerkontoabfrage.
 *
 * `Empfaenger id="L"` carries `CS` (the clearing destination the Kontoabfrage examples use), not
 * the Bundesland the declarations send — this is not a filing, it is a query against the account
 * system. `Empfaenger id="F"` stays the BuFa derived from the Steuernummer, as everywhere else.
 */
export function buildKontoabfrageEds(config: ElsterConfig, query: KontoabfrageQuery): string {
    const steuernummer = toElsterSteuernummer(config.tax_number);
    const nutzdaten =
        `                <kontoabfrage version="6" xmlns="${NS_KONTOABFRAGE}"` +
        ` xmlns:i="${NS_I}" xmlns:o="${NS_O}" xmlns:zs="${NS_ZS}">\n` +
        '                    <kontoabfrage-teil>\n' +
        `                        <${query.art === 'O' ? 'o' : query.art === 'ZS' ? 'zs' : 'i'}:kontoabfrage-input>\n` +
        inputBlock(query, steuernummer) +
        `                        </${query.art === 'O' ? 'o' : query.art === 'ZS' ? 'zs' : 'i'}:kontoabfrage-input>\n` +
        '                    </kontoabfrage-teil>\n' +
        '                </kontoabfrage>\n';

    return buildEdsEnvelope({
        verfahren: 'ElsterKontoabfrage',
        datenArt: 'Kontoabfrage',
        vorgang: 'send-Auth',
        testMode: config.test_mode,
        herstellerId: config.hersteller_id,
        datenLieferant: config.datenlieferant,
        empfaenger: bufaFromElsterSteuernummer(steuernummer),
        empfaengerZiel: 'CS',
        nutzdaten,
    });
}
