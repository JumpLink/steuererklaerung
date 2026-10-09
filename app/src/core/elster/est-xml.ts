/**
 * Einkommensteuererklärung (ESt 1 A, Schema E10-2025) XML builder for ELSTER/ERiC — the
 * private income-tax declaration of a `privat` entity (unbeschränkte Steuerpflicht).
 *
 * Structure from the E10-2025 schema (`elster/ERiC-<ver>/…/ESt_10_2025/Schema/E10-2025.xsd`,
 * reference example `…/Beispiele/est_e10_2025.xml`): Nutzdaten root `<E10 …/est/e10/v2025>`
 * with the Anlagen as top-level children in the FIXED xs:sequence order
 * `ESt1A · SA · AgB · … · G · … · N · … · VOR · … · Vorsatz` (every block minOccurs=0 —
 * only what is backed by data is emitted, but the order is binding). DatenArt `ESt`,
 * datenartVersion `ESt_<year>`, Kompression GZIP, Verfahren ElsterErklaerung.
 *
 * The XML declares the INPUTS of the assessment (Lohnsteuerbescheinigung, Vorsorge,
 * Sonderausgaben, Werbungskosten, §35a) — never a computed tax; the Finanzamt computes.
 * Everything comes from the merged {@link EstInputs} (est-config over transaction
 * aggregate) so the declared figures reconcile with `elster est report` by construction.
 *
 * Betragsformat — two kinds, PER Kennzahl (from the XSD type, not guessed):
 *  - `Ganzzahl…` (GeldBetragOhneCent): whole euros, `775,00` would be INVALID. Amounts
 *    that mirror official eDaten (Lohnsteuerbescheinigung Nr. 22–27) are rounded
 *    kaufmännisch; self-collected Aufwendungen round UP and Einkünfte round DOWN
 *    ("in vollen Euro, zu Ihren Gunsten gerundet" — the Mein-ELSTER guidance). Every
 *    `Sum` is computed from the ROUNDED Einzel values, so Einzel/Summe plausis
 *    (±2 €) hold exactly.
 *  - `Dezimalzahl…MinNK2` (GeldBetragMitCent): cents REQUIRED (`775` would be invalid) —
 *    the Steuerabzugsbeträge Lohnsteuer/Soli/KiSt (E0200301/E0200401/E0200501).
 *
 * Plausi rules honoured (from `Plausipruefungen/…/ESt/UFA10/Jahresdokumentation_10_2025.xml`):
 * Steuerklasse `E0200002` is mandatory once Arbeitslohn is declared; RV-AN `E2000401` and
 * RV-AG `E2000801` must appear together; §35a requires the Einzelaufstellung (Sum from the
 * itemised rows only); Homeoffice `E0204507` (anderer Arbeitsplatz vorhanden) vs `E0206206`
 * (dauerhaft kein anderer) are legally different lines — the config flag
 * `homeoffice_anderer_arbeitsplatz` chooses, generation fails loud without it.
 *
 * Anything the config cannot express is REJECTED (fail loud, all misses listed) instead of
 * silently guessed: Zusammenveranlagung (no Person-B model), Kinder ohne IdNr/Kindergeld-
 * Anspruch, Schulgeld/Kinderbetreuung ohne Kind-Zuordnung, §35a-Beträge ohne Einzel-
 * aufstellung, sonstige Vorsorge ohne AV-Zuordnung. Tax figures are never invented here.
 *
 * Anlage Kind (`Kind`, one block per child): identity (IdNr `E0500406`, Vorname, abw.
 * Familienname, Geburtsdatum), Jahres-Kindergeld-Anspruch `E0500702`, Familienkasse,
 * Wohnsitz-Inland-Zeitraum, Kindschaftsverhältnis (to the declaring person + to the other
 * Elternteil), Schulgeld (`E0505606`/`E0504405`/`E0505607` + Elt_k_ZV `E0504505`) and
 * Kinderbetreuungskosten (`KBK`). The XML amounts are the PAID Aufwendungen — the deductible
 * shares (30 % Schulgeld, 80 % Betreuung from VZ 2025) are computed by the Finanzamt.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EstConfig, EstJahr, EstKind, EstKindJahr } from '../config/index.ts';
import { estJahr, estKindJahr } from '../config/index.ts';
import type { EstInputs } from './est-berechnung.ts';
import type { EstTxAggregate, EstTxDetailRow } from './est-aggregate.ts';
import { buildEdsEnvelope } from './eds-envelope.ts';
import { toElsterSteuernummer, bufaFromElsterSteuernummer } from './steuernummer.ts';
import { leaf, wrap, pad } from './xml-format.ts';

const EST_NS = 'http://finkonsens.de/elster/elstererklaerung/est/e10/v2025';

/** ERiC datenartVersion token for the Einkommensteuererklärung (`ESt_<year>`). */
export function estDatenartVersion(year: number): string {
    return `ESt_${year}`;
}

/** Bundesland name → TransferHeader `<Empfaenger id="L"><Ziel>` code (2-letter Land). */
const LAND_ZIEL: Record<string, string> = {
    'baden-württemberg': 'BW',
    bayern: 'BY',
    berlin: 'BE',
    brandenburg: 'BB',
    bremen: 'HB',
    hamburg: 'HH',
    hessen: 'HE',
    'mecklenburg-vorpommern': 'MV',
    niedersachsen: 'NI',
    'nordrhein-westfalen': 'NW',
    'rheinland-pfalz': 'RP',
    saarland: 'SL',
    sachsen: 'SN',
    'sachsen-anhalt': 'ST',
    'schleswig-holstein': 'SH',
    thüringen: 'TH',
};

/** Bundesland (name or already a 2-letter code) → Ziel code, or undefined when unknown. */
export function bundeslandZiel(bundesland: string | undefined): string | undefined {
    if (!bundesland) return undefined;
    const trimmed = bundesland.trim();
    if (/^[A-Z]{2}$/.test(trimmed)) return trimmed;
    return LAND_ZIEL[trimmed.toLowerCase()];
}

// ---------------------------------------------------------------------------------------
// Amount formatting (GeldBetragOhneCent vs GeldBetragMitCent — see the header)

/** GeldBetragMitCent: `8267.17` → `"8267,17"` (cents mandatory). */
const centDe = (n: number): string => n.toFixed(2).replace('.', ',');

/** Whole euro, kaufmännisch — for figures that mirror official eDaten (Bescheinigung). */
const eurRund = (n: number): string => String(Math.round(n));

/** Whole euro, zu Gunsten aufgerundet — for self-collected Aufwendungen/Abzüge. */
const eurAuf = (n: number): string => String(Math.ceil(n - 1e-9));

/** Whole euro, zu Gunsten abgerundet — for declared Einkünfte (also negative losses). */
const eurAb = (n: number): string => String(Math.floor(n + 1e-9));

/** "YYYY-MM-DD" → "TT.MM.JJJJ" (ELSTER date format). */
const deDate = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/**
 * Within-year period "TT.MM-TT.MM" (E10 `DatumBereichTTpMMbTTpMM`) for a child: from 01.01 —
 * or the birth date, when the child was born during the declared year — through 31.12.
 * Mirrors the officially filed prior-year convention (a child born in-year starts its
 * Wohnsitz/Kindschaftsverhältnis period at the birth date).
 */
export function kindZeitraum(geburtsdatumIso: string, year: number): string {
    const von =
        Number(geburtsdatumIso.slice(0, 4)) === year
            ? `${geburtsdatumIso.slice(8, 10)}.${geburtsdatumIso.slice(5, 7)}`
            : '01.01';
    return `${von}-31.12`;
}

/**
 * The ELSTER free-text character set "Standard_E_V2" (from the StringBaseCType pattern in
 * the E-schemas): ASCII 0x20–0x7e plus a Latin-1/-15 subset — NO middle dot (0xB7), NO
 * typographic dashes/quotes/ellipsis. ERiC rejects anything else with
 * "ZeichenNichtImZeichensatz" (verified against ERiC 43.4.6.0).
 */
const ELSTER_DISALLOWED_RE =
    // eslint-disable-next-line no-control-regex
    /[^\x20-\x7e¡-£¥§ª-¬®-³µ¹-»¿-ÿŒœŠšŸŽž€]/g;

/** Typographic characters we can transliterate losslessly instead of dropping. */
const ELSTER_TRANSLIT: Record<string, string> = {
    '·': '-', // · middle dot (our own tx-label separator)
    '‐': '-',
    '‑': '-',
    '–': '-', // – en dash
    '—': '-', // — em dash
    '‘': "'",
    '’': "'",
    '‚': "'",
    '“': '"',
    '”': '"',
    '„': '"',
    '…': '...',
    '•': '-',
};

/** Sanitise a free-text value to the ELSTER charset + cap it at the field's max length. */
export function freitext(s: string, max = 999): string {
    const clean = s
        .replace(/[‐‑–—‘’‚“”„…•·]/g, (c) => ELSTER_TRANSLIT[c] ?? ' ')
        .replace(ELSTER_DISALLOWED_RE, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return clean.length > max ? clean.slice(0, max).trim() : clean;
}

/** Vorname/Nachname from the config (explicit fields win; else split at the last space). */
export function splitPersonName(person: EstConfig['person']): { vorname: string; nachname: string } {
    if (person.vorname && person.nachname) return { vorname: person.vorname, nachname: person.nachname };
    const parts = person.name.trim().split(/\s+/);
    return {
        vorname: person.vorname ?? parts.slice(0, -1).join(' '),
        nachname: person.nachname ?? parts[parts.length - 1],
    };
}

/** A detail row's human-readable Bezeichnung for an Einzelaufstellung row. */
const rowLabel = (r: EstTxDetailRow): string =>
    freitext(`${r.counterparty ?? 'Zahlung'}${r.purpose ? ` - ${r.purpose}` : ''} (${r.bookingDate})`);

/**
 * Everything the E10 needs beyond the {@link EstInputs}: identity + declaration facts from
 * the config, resolved and validated in ONE place so a miss fails loud with the full list.
 */
interface EstXmlContext {
    config: EstConfig;
    inputs: EstInputs;
    jahr: EstJahr;
    detail: EstTxDetailRow[];
    steuernr13: string;
    vorname: string;
    nachname: string;
    /** Kinder for the Anlage Kind (only those already born in the declared year), with year data. */
    kinder: Array<{ kind: EstKind; kindJahr: EstKindJahr | undefined }>;
}

/**
 * Validate that the config carries everything the E10 needs and resolve the context.
 * Collects EVERY miss and throws once with the full list — a tax XML must never be
 * generated from guessed values.
 */
function resolveContext(config: EstConfig, inputs: EstInputs, aggregate: EstTxAggregate): EstXmlContext {
    const misses: string[] = [];
    const p = config.person;
    const jahr = estJahr(config, inputs.year);

    if (config.veranlagung !== 'einzel') {
        misses.push('veranlagung "splitting" wird vom E10-Builder noch nicht unterstützt (kein Person-B-Datenmodell).');
    }
    if (!p.steuer_id) misses.push('person.steuer_id (11-stellige IdNr, Vorsatz ID)');
    if (!p.steuernummer) misses.push('person.steuernummer (regional FF/BBB/UUUUP oder 13-stellig, Vorsatz StNr)');
    if (!p.geburtsdatum) misses.push('person.geburtsdatum (ESt1A E0100401)');
    if (!p.strasse) misses.push('person.strasse (ESt1A E0101104)');
    if (!p.plz) misses.push('person.plz (ESt1A E0100601)');
    if (!p.ort) misses.push('person.ort (ESt1A E0100602)');
    if ((p.kirchensteuersatz ?? 0) > 0 && !p.religion) {
        misses.push('person.religion (Religionsschlüssel E0100402 — kirchensteuerpflichtig, nicht ableitbar)');
    }
    // ERiC Regel 1016 (ESt1A Zeile 30): either give a Bankverbindung or explicitly
    // declare "keine Bankverbindung vorhanden" — the latter would be a false statement
    // for someone who has an account, so the IBAN is mandatory here.
    if (!p.iban) {
        misses.push('person.iban (ESt1A BV E0102102 — Plausi 1016 verlangt eine Bankverbindung)');
    } else if (!/^DE\d{2}[0-9a-zA-Z]{1,30}$/.test(p.iban.replace(/\s/g, ''))) {
        misses.push('person.iban: nur eine inländische IBAN (DE…) wird unterstützt (E0102102)');
    }
    if (!jahr) misses.push(`jahre[${inputs.year}] (Lohnsteuerbescheinigung-Zeile für das Jahr fehlt)`);
    if (inputs.bruttoarbeitslohn > 0 && jahr?.steuerklasse == null) {
        misses.push('jahre[].steuerklasse (Anlage N E0200002 — Pflicht, sobald Arbeitslohn erklärt ist)');
    }
    if (inputs.werbungskosten.homeofficeTage > 0 && jahr?.werbungskosten?.homeoffice_anderer_arbeitsplatz == null) {
        misses.push(
            'jahre[].werbungskosten.homeoffice_anderer_arbeitsplatz (wählt E0204507 vs. E0206206 — rechtlich verschiedene Zeilen)',
        );
    }
    const pendelEingabe = inputs.werbungskosten.pendel;
    if (pendelEingabe && pendelEingabe.tage > 0 && pendelEingabe.kmEinfach > 0 && !jahr?.werbungskosten?.pendel?.ziel) {
        misses.push(
            'jahre[].werbungskosten.pendel.ziel (erste Tätigkeitsstätte als „PLZ Ort, Straße", Anlage N E0203501 — ERiC verlangt sie zur Entfernungspauschale)',
        );
    }
    if ((jahr?.vorsorge?.sonstige ?? 0) > 0) {
        misses.push(
            'vorsorge.sonstige > 0: für das XML nach Zeilen aufteilen — AV-Beiträge (Bescheinigung Nr. 27) nach vorsorge.av_arbeitnehmer; übrige sonstige Vorsorge ist noch nicht als Einzelaufstellung modelliert',
        );
    }
    if ((inputs.einkuenfteGewerbe ?? 0) !== 0 && !jahr?.gewerbe_bezeichnung) {
        misses.push('jahre[].gewerbe_bezeichnung (Anlage G E0800301 — genaue Bezeichnung des Gewerbes)');
    }
    // Anlage Kind: only children already born are declared; each one needs its identity
    // (IdNr, Geburtsdatum) and the Jahres-Kindergeld-Anspruch (Günstigerprüfung §31).
    const kinder = (config.kinder ?? [])
        .filter((k) => k.geburtsdatum <= `${inputs.year}-12-31`)
        .map((kind) => ({ kind, kindJahr: estKindJahr(kind, inputs.year) }));
    if (kinder.length > 0 && config.person.kinder !== kinder.length) {
        misses.push(
            `person.kinder (${config.person.kinder}) widerspricht der kinder-Liste (${kinder.length} im VZ ${inputs.year}) — die zumutbare Belastung und die Anlagen Kind müssen dieselbe Kinderzahl erklären`,
        );
    }
    for (const { kind, kindJahr } of kinder) {
        const wer = `kinder[${kind.vorname}]`;
        if (!kind.idnr) misses.push(`${wer}.idnr (11-stellige IdNr des Kindes, E0500406)`);
        if (!kindJahr) {
            misses.push(`${wer}.jahre[${inputs.year}] (kindergeld_anspruch fehlt — E0500702, Günstigerprüfung)`);
        }
        // ERiC-Regel 10514160: KBK only with the Angaben zum Haushalt (Ang_HH) — verified empirically.
        const hh = kindJahr?.haushalt;
        const hatHaushalt =
            hh != null &&
            (hh.gemeinsam_zeitraum ||
                hh.gemeinsam_kind_zeitraum ||
                hh.getrennt_zeitraum ||
                hh.kind_bei_mir_zeitraum ||
                hh.kind_beim_anderen_zeitraum);
        if ((kindJahr?.kinderbetreuung ?? []).some((b) => b.betrag > 0) && !hatHaushalt) {
            misses.push(
                `${wer}.jahre[].haushalt (KBK verlangt Angaben zum Haushalt der Elternteile + Haushaltszugehörigkeit — ERiC-Regel 10514160)`,
            );
        }
    }
    // Schulgeld/Kinderbetreuung are declared per child — a yearly lump sum without a
    // child assignment cannot be expressed in the E10 (which Anlage Kind?).
    if ((jahr?.schulgeld ?? 0) > 0) {
        misses.push(
            'jahre[].schulgeld ohne Kind-Zuordnung — nach kinder[].jahre[].schulgeld (schule + gezahlt) verschieben',
        );
    }
    if ((jahr?.kinderbetreuung ?? 0) > 0) {
        misses.push(
            'jahre[].kinderbetreuung ohne Kind-Zuordnung — nach kinder[].jahre[].kinderbetreuung (bezeichnung + betrag) verschieben',
        );
    }
    if (
        ((inputs.sonderausgaben.schulgeld ?? 0) > 0 || (inputs.sonderausgaben.kinderbetreuung ?? 0) > 0) &&
        kinder.length === 0
    ) {
        misses.push('Schulgeld/Kinderbetreuung ohne kinder-Liste — die Anlage Kind braucht die Kind-Identität');
    }
    if ((jahr?.par35a_manuell?.handwerker ?? 0) > 0 || (jahr?.par35a_manuell?.haushaltsnah ?? 0) > 0) {
        misses.push(
            'par35a_manuell ohne Einzelaufstellung: §35a verlangt Art + Betrag je Posten — per par35a_arbeitskosten (Transaktions-Override) erfassen',
        );
    }
    if (inputs.par35a.minijob > 0) {
        misses.push('par35a.minijob: die Minijob-Einzelaufstellung (HA_35a/St_Erm/Minijobs) ist noch nicht modelliert');
    }
    // Transaction-derived Krankheitskosten need the per-transaction rows for the
    // Einzelaufstellung — the callers pass `detail: true` to the aggregate.
    const detail = aggregate.detail ?? [];
    if (aggregate.krankheitskosten > 0 && detail.length === 0) {
        misses.push('Krankheitskosten aus Transaktionen ohne Detailzeilen — Aggregat mit detail: true erzeugen');
    }

    if (misses.length > 0) {
        throw new Error(
            `ESt-XML (${inputs.year}): fehlende/nicht abbildbare Angaben — nichts wird geraten:\n` +
                misses.map((m) => `  - ${m}`).join('\n'),
        );
    }

    const { vorname, nachname } = splitPersonName(p);
    return {
        config,
        inputs,
        jahr: jahr as EstJahr,
        detail,
        steuernr13: toElsterSteuernummer(p.steuernummer as string),
        vorname,
        nachname,
        kinder,
    };
}

// ---------------------------------------------------------------------------------------
// Blocks (each returns '' when it has no data — minOccurs=0, order handled by the caller)

/** `<ESt1A>` Hauptvordruck: Art der Erklärung, Meldedaten (Allg/A), Bankverbindung. */
function buildESt1A(ctx: EstXmlContext): string {
    const p = ctx.config.person;
    // Religion: kirchensteuersatz 0 → '11' (nicht kirchensteuerpflichtig); else the
    // configured amtlicher Schlüssel (validated present in resolveContext).
    const religion = (p.kirchensteuersatz ?? 0) === 0 ? '11' : (p.religion as string);
    // NOTE: the IdNr field ESt1A/Allg/A/E0100081 is a SYSTEM-inserted field (Eingefügt-
    // Kennzeichen — ERiC rejects user XML carrying it with
    // ERIC_IO_READER_UNERWARTETE_ELEMENTE, verified against ERiC 43.4.6.0); the IdNr is
    // transmitted via the Vorsatz <ID> only.
    // Hausnummer: E0101206 takes DIGITS only (max 4); a letter suffix goes into the
    // Zusatz E0101207 (max 6).
    const hnr = (p.hausnummer ?? '').match(/^(\d{1,4})\s*(.*)$/);
    const aBlock = wrap(
        28,
        'A',
        leaf(32, 'E0100401', deDate(p.geburtsdatum as string)) +
            leaf(32, 'E0100201', freitext(ctx.nachname, 25)) +
            leaf(32, 'E0100301', freitext(ctx.vorname, 25)) +
            leaf(32, 'E0100402', religion) +
            (p.beruf ? leaf(32, 'E0100403', freitext(p.beruf, 25)) : '') +
            leaf(32, 'E0101104', freitext(p.strasse as string, 25)) +
            (hnr ? leaf(32, 'E0101206', hnr[1]) : '') +
            (hnr?.[2] ? leaf(32, 'E0101207', freitext(hnr[2], 6)) : '') +
            leaf(32, 'E0100601', p.plz as string) +
            leaf(32, 'E0100602', freitext(p.ort as string, 25)),
    );
    // Vlg_Art: an unmarried person does NOT fill the Veranlagungsart at all (E0102602 is
    // the Einzelveranlagung OF SPOUSES, not the everyday single assessment).
    const bv = p.iban
        ? wrap(
              28,
              'BV',
              leaf(32, 'E0102102', p.iban.replace(/\s/g, '')) + wrap(32, 'Kto_Inh', leaf(36, 'E0101601', 'X')),
          )
        : '';
    // §32b: Einkommensersatzleistungen subject to the Progressionsvorbehalt (net, in whole €;
    // may be negative = repaid amounts outweigh them). Sequence position after `Allg`
    // (ESt1A_67907: …Allg, Mitwirk, AN_Sp_Zul, Eink_Ers, …). Person A, inländische Sum/E0104801.
    const progNetto = Math.round(ctx.inputs.progressionseinkuenfte ?? 0);
    const einkErs = progNetto
        ? wrap(
              24,
              'Eink_Ers',
              leaf(28, 'Person', 'PersonA') + wrap(28, 'Inl', wrap(32, 'Sum', leaf(36, 'E0104801', String(progNetto)))),
          )
        : '';
    return wrap(
        20,
        'ESt1A',
        wrap(24, 'Art_Erkl', leaf(28, 'E0100001', 'X')) +
            wrap(24, 'Allg', (p.telefon ? leaf(28, 'E0100008', freitext(p.telefon, 25)) : '') + aBlock + bv) +
            einkErs,
    );
}

/** `<SA>` Sonderausgaben: Kirchensteuer paid + Zuwendungen (Spenden, §34g Parteien). */
function buildSA(ctx: EstXmlContext): string {
    const sa = ctx.inputs.sonderausgaben;
    const kist =
        sa.gezahlteKirchensteuer > 0
            ? wrap(
                  24,
                  'KiSt',
                  wrap(28, 'Gezahlt', wrap(32, 'Sum', leaf(36, 'E0107601', eurAuf(sa.gezahlteKirchensteuer)))),
              )
            : '';

    // Spenden: itemise the transaction-derived rows; the config extra is part of the Sum
    // (the Zuwendungsbestätigungen stay the Nachweis — Belege are never invented along with them).
    const spendenRows = ctx.detail.filter((r) => r.bucket === 'spenden' && r.betrag > 0);
    const spendenEinz = spendenRows
        .map((r) => wrap(36, 'Einz', leaf(40, 'E0108102', rowLabel(r)) + leaf(40, 'E0108103', eurAuf(r.betrag))))
        .join('');
    // Sum = itemised tx rows (rounded) + the manual config extra (inputs.spenden already
    // carries aggregate + config, so the extra is the difference to the raw tx total).
    const manualExtra = Math.max(0, sa.spenden - spendenRows.reduce((s, r) => s + r.betrag, 0));
    const spendenSum = spendenRows.reduce((s, r) => s + Number(eurAuf(r.betrag)), 0) + Number(eurAuf(manualExtra));
    const inl =
        sa.spenden > 0
            ? wrap(
                  32,
                  'Foerd_st_beg_Zw_Inl',
                  spendenEinz + wrap(36, 'Sum_Best', leaf(40, 'E0108105', String(spendenSum))),
              )
            : '';
    const politP =
        (ctx.inputs.par34g?.parteibeitrag ?? 0) > 0
            ? wrap(
                  32,
                  'Polit_P',
                  wrap(36, 'Sum_Best', leaf(40, 'E0108701', eurAuf(ctx.inputs.par34g?.parteibeitrag ?? 0))),
              )
            : '';
    const zuw = inl || politP ? wrap(24, 'Zuw', wrap(28, 'Sp_MB', inl + politP)) : '';

    return kist || zuw ? wrap(20, 'SA', kist + zuw) : '';
}

/** `<AgB>` außergewöhnliche Belastungen: Krankheitskosten (§33) as an Einzelaufstellung. */
function buildAgB(ctx: EstXmlContext): string {
    const total = ctx.inputs.agb.krankheitskosten;
    if (total <= 0) return '';
    const rows = ctx.detail.filter((r) => r.bucket === 'gesundheit' && r.betrag > 0);
    const manuell = ctx.jahr.krankheitskosten ?? 0;
    const einz =
        rows
            .map((r) =>
                wrap(
                    32,
                    'Einz',
                    leaf(36, 'E0161301', rowLabel(r)) +
                        leaf(36, 'E0161302', eurAuf(r.betrag)) +
                        leaf(36, 'E0161303', '0'),
                ),
            )
            .join('') +
        (manuell > 0
            ? wrap(
                  32,
                  'Einz',
                  leaf(36, 'E0161301', 'Weitere Krankheitskosten laut Belegaufstellung') +
                      leaf(36, 'E0161302', eurAuf(manuell)) +
                      leaf(36, 'E0161303', '0'),
              )
            : '');
    const sum = rows.reduce((s, r) => s + Number(eurAuf(r.betrag)), 0) + (manuell > 0 ? Number(eurAuf(manuell)) : 0);
    const krankh = wrap(
        28,
        'Krankh',
        einz + wrap(32, 'Sum', leaf(36, 'E0161304', String(sum)) + leaf(36, 'E0161305', '0')),
    );
    return wrap(20, 'AgB', wrap(24, 'And_Aufw', krankh));
}

/** `<HA_35a>` haushaltsnahe Dienst-/Handwerkerleistungen — itemised rows only (plausi). */
function buildHA35a(ctx: EstXmlContext): string {
    // Only rows WITH an explicit Arbeitskosten override count (the gross bank amount
    // includes non-qualifying Material) — mirrors the est-aggregate claim logic.
    const handw = ctx.detail.filter((r) => r.bucket === 'handwerker' && (r.arbeitskostenOverride ?? 0) > 0);
    const hhn = ctx.detail.filter((r) => r.bucket === 'haushaltsnah' && (r.arbeitskostenOverride ?? 0) > 0);
    if (handw.length === 0 && hhn.length === 0) return '';

    const hhnEinz = hhn
        .map((r) =>
            wrap(
                32,
                'Einz',
                leaf(36, 'E0107206', rowLabel(r)) + leaf(36, 'E0107207', eurAuf(r.arbeitskostenOverride as number)),
            ),
        )
        .join('');
    const hhnSum = hhn.reduce((s, r) => s + Number(eurAuf(r.arbeitskostenOverride as number)), 0);
    const hhnBlock = hhn.length
        ? wrap(28, 'Hhn_BV_DL', hhnEinz + wrap(32, 'Sum', leaf(36, 'E0107208', String(hhnSum))))
        : '';

    // Handw_L: E0170601 = Rechnungsbetrag, E0111214 = darin enthaltene Lohn-/Maschinen-/
    // Fahrtkosten; the Sum E0111215 adds the LOHN parts, not the Rechnungsbeträge.
    const handwEinz = handw
        .map((r) =>
            wrap(
                32,
                'Einz',
                leaf(36, 'E0111217', rowLabel(r)) +
                    leaf(36, 'E0170601', eurAuf(r.betrag)) +
                    leaf(36, 'E0111214', eurAuf(r.arbeitskostenOverride as number)),
            ),
        )
        .join('');
    const handwSum = handw.reduce((s, r) => s + Number(eurAuf(r.arbeitskostenOverride as number)), 0);
    const handwBlock = handw.length
        ? wrap(28, 'Handw_L', handwEinz + wrap(32, 'Sum', leaf(36, 'E0111215', String(handwSum))))
        : '';

    return wrap(20, 'HA_35a', wrap(24, 'St_Erm', hhnBlock + handwBlock));
}

/**
 * `<Kind>` Anlage Kind — one block PER child (E10 sequence position: after HA_35a, before
 * L/G). Inner sequence per XSD `Kind_67907_CType`: Ang_Kind · K_Verh · … · Schulgeld · KBK.
 * Amounts are the PAID "berücksichtigungsfähigen Gesamtaufwendungen" — the Finanzamt
 * computes the deductible share (30 % Schulgeld / 80 % Betreuung ab VZ 2025) and the caps.
 */
function buildKindBlocks(ctx: EstXmlContext): string {
    return ctx.kinder
        .map(({ kind, kindJahr }) => {
            const zeitraum = kindZeitraum(kind.geburtsdatum, ctx.inputs.year);
            // Allg: IdNr, Vorname, differing Familienname (only when it really differs),
            // Geburtsdatum, Jahres-Kindergeld-Anspruch (whole €), the Familienkasse in charge.
            const allg = wrap(
                28,
                'Allg',
                leaf(32, 'E0500406', kind.idnr as string) +
                    leaf(32, 'E0500107', freitext(kind.vorname)) +
                    (kind.nachname && kind.nachname !== ctx.nachname
                        ? leaf(32, 'E0500108', freitext(kind.nachname))
                        : '') +
                    leaf(32, 'E0500701', deDate(kind.geburtsdatum)) +
                    leaf(32, 'E0500702', eurRund((kindJahr as EstKindJahr).kindergeld_anspruch)) +
                    (kind.familienkasse ? leaf(32, 'E0500706', freitext(kind.familienkasse)) : ''),
            );
            const ws = wrap(28, 'WS', wrap(32, 'Inl', leaf(36, 'E0500703', zeitraum)));
            const angKind = wrap(24, 'Ang_Kind', allg + ws);

            // K_Verh_A = relationship to the declaring person; K_Verh_and_P = the other Elternteil
            // (name/Geburtsdatum/last address), where applicable with E0501513 (Wohnsitz cannot be
            // determined → full Kinderfreibetrag).
            const kVerhA = wrap(
                28,
                'K_Verh_A',
                leaf(32, 'E0500807', kind.kindschaftsverhaeltnis) + leaf(32, 'E0500601', zeitraum),
            );
            const ae = kind.anderer_elternteil;
            const kVerhAndP = ae
                ? wrap(
                      28,
                      'K_Verh_and_P',
                      wrap(
                          32,
                          'Ang_Pers',
                          leaf(36, 'E0501103', freitext(ae.name)) +
                              (ae.geburtsdatum ? leaf(36, 'E0501104', deDate(ae.geburtsdatum)) : '') +
                              leaf(36, 'E0501903', zeitraum) +
                              (ae.adresse ? leaf(36, 'E0501105', freitext(ae.adresse)) : '') +
                              leaf(36, 'E0501106', ae.kindschaftsverhaeltnis),
                      ) + (ae.wohnsitz_unbekannt ? wrap(32, 'Weit_Ang', leaf(36, 'E0501513', '1')) : ''),
                  )
                : '';
            const kVerh = wrap(24, 'K_Verh', kVerhA + kVerhAndP);

            // Schulgeld (§10 Abs. 1 Nr. 9): Einz (Schule + the parents' Gesamtaufwendungen) + Sum
            // + Elt_k_ZV ("das von mir übernommene Schulgeld" — parents not zusammenveranlagt).
            const sg = kindJahr?.schulgeld;
            const schulgeld =
                sg && sg.gezahlt > 0
                    ? wrap(
                          24,
                          'Schulgeld',
                          wrap(
                              28,
                              'Einz',
                              leaf(32, 'E0505606', freitext(sg.schule)) + leaf(32, 'E0504405', eurAuf(sg.gezahlt)),
                          ) +
                              wrap(28, 'Sum', leaf(32, 'E0505607', eurAuf(sg.gezahlt))) +
                              wrap(28, 'Elt_k_ZV', leaf(32, 'E0504505', eurAuf(sg.von_mir ?? sg.gezahlt))),
                      )
                    : '';

            // KBK (§10 Abs. 1 Nr. 5): Art/Einz per service provider + Sum; tax-free Ersatz;
            // Elt_k_ZV/Kosten = the share borne by oneself (parents not zusammenveranlagt).
            const betreuung = (kindJahr?.kinderbetreuung ?? []).filter((b) => b.betrag > 0);
            const artEinz = betreuung
                .map((b) =>
                    wrap(
                        32,
                        'Einz',
                        leaf(36, 'E0506101', freitext(b.bezeichnung)) +
                            leaf(36, 'E0506103', `${b.zeitraum_von}-${b.zeitraum_bis}`) +
                            leaf(36, 'E0506104', eurAuf(b.betrag)),
                    ),
                )
                .join('');
            const artSum = betreuung.reduce((s, b) => s + Number(eurAuf(b.betrag)), 0);
            const erstattet = betreuung.reduce((s, b) => s + b.erstattet, 0);
            const ersatz =
                erstattet > 0
                    ? wrap(
                          28,
                          'Ersatz_Erstatt',
                          betreuung
                              .filter((b) => b.erstattet > 0)
                              .map((b) =>
                                  wrap(
                                      32,
                                      'Einz',
                                      leaf(36, 'E0506506', `${b.zeitraum_von}-${b.zeitraum_bis}`) +
                                          leaf(36, 'E0506505', eurRund(b.erstattet)),
                                  ),
                              )
                              .join('') + wrap(32, 'Sum', leaf(36, 'E0506504', eurRund(erstattet))),
                      )
                    : '';
            // Ang_HH (Haushalt of the Elternteile + Haushaltszugehörigkeit) — demanded by ERiC
            // as soon as Betreuungskosten are declared (Regel 10514160, verified empirically).
            const hh = kindJahr?.haushalt;
            const gemHH =
                hh && (hh.gemeinsam_zeitraum || hh.gemeinsam_kind_zeitraum)
                    ? wrap(
                          32,
                          'Gem_HH_Elt',
                          (hh.gemeinsam_zeitraum ? leaf(36, 'E0504807', hh.gemeinsam_zeitraum) : '') +
                              (hh.gemeinsam_kind_zeitraum ? leaf(36, 'E0504808', hh.gemeinsam_kind_zeitraum) : ''),
                      )
                    : '';
            const getrenntHH =
                hh && (hh.getrennt_zeitraum || hh.kind_bei_mir_zeitraum || hh.kind_beim_anderen_zeitraum)
                    ? wrap(
                          32,
                          'K_gem_HH_Elt',
                          (hh.getrennt_zeitraum ? leaf(36, 'E0505201', hh.getrennt_zeitraum) : '') +
                              (hh.kind_bei_mir_zeitraum ? leaf(36, 'E0505202', hh.kind_bei_mir_zeitraum) : '') +
                              (hh.kind_beim_anderen_zeitraum
                                  ? leaf(36, 'E0508901', hh.kind_beim_anderen_zeitraum)
                                  : ''),
                      )
                    : '';
            const angHH = gemHH || getrenntHH ? wrap(28, 'Ang_HH', gemHH + getrenntHH) : '';
            const eigenanteil = betreuung.reduce(
                (s, b) => s + Number(eurAuf(b.von_mir ?? Math.max(0, b.betrag - b.erstattet))),
                0,
            );
            const kbk =
                betreuung.length > 0
                    ? wrap(
                          24,
                          'KBK',
                          wrap(28, 'Art', artEinz + wrap(32, 'Sum', leaf(36, 'E0506105', String(artSum)))) +
                              ersatz +
                              angHH +
                              wrap(
                                  28,
                                  'Elt_k_ZV',
                                  wrap(
                                      32,
                                      'Kosten',
                                      betreuung
                                          .map((b) =>
                                              wrap(
                                                  36,
                                                  'Einz',
                                                  leaf(40, 'E0506606', `${b.zeitraum_von}-${b.zeitraum_bis}`) +
                                                      leaf(
                                                          40,
                                                          'E0506605',
                                                          eurAuf(b.von_mir ?? Math.max(0, b.betrag - b.erstattet)),
                                                      ),
                                              ),
                                          )
                                          .join('') + wrap(36, 'Sum', leaf(40, 'E0506604', String(eigenanteil))),
                                  ),
                              ),
                      )
                    : '';

            // §24b Entlastungsbetrag für Alleinerziehende: with EINZELVERANLAGUNG there is no E10 field —
            // the Finanzamt grants it from the Anlage Kind (child in the household) + the einzelveranlagt
            // single status, as long as no year-round Haushaltsgemeinschaft (E0107606) is declared.
            // The field EfA/ZV_Pers/E0505002 is meant EXCLUSIVELY for the Zusammenveranlagung transition
            // (marriage/separation/death within the VZ) — ERiC error 100500061 with Einzelveranlagung.
            // So NOT emitted here; the FA determines the pro-rata reduction. The Schätzung uses `monate`.
            return wrap(20, 'Kind', angKind + kVerh + schulgeld + kbk);
        })
        .join('');
}

/** `<G>` Anlage G: profit of the Einzelunternehmen + shares from gesonderte Feststellungen. */
function buildG(ctx: EstXmlContext): string {
    const gewinn = ctx.inputs.einkuenfteGewerbe ?? 0;
    const beteiligungen = ctx.jahr.gewerbe_beteiligungen ?? [];
    if (gewinn === 0 && beteiligungen.length === 0) return '';

    const einzU =
        gewinn !== 0
            ? wrap(
                  28,
                  'Einz_U',
                  wrap(
                      32,
                      'Betr_1_2',
                      leaf(36, 'E0800301', freitext(ctx.jahr.gewerbe_bezeichnung as string)) +
                          leaf(36, 'E0800302', eurAb(gewinn)),
                  ),
              )
            : '';
    const gesFestEinz = beteiligungen
        .map((b) =>
            wrap(
                32,
                'Einz',
                // Order per the E10-2025 XSD (Einz_28509101): E0800501 → E0800704 → E0800804 → E0800504.
                // E0800804 (Steuernummer of the Feststellung, 13-digit ELSTER) is demanded by ERiC on top
                // of the Finanzamt (Hinweis 100800068) — without it the Ges_Fest entry stays incomplete.
                leaf(36, 'E0800501', freitext(b.bezeichnung)) +
                    leaf(36, 'E0800704', freitext(b.finanzamt)) +
                    (b.steuernummer ? leaf(36, 'E0800804', toElsterSteuernummer(b.steuernummer)) : '') +
                    leaf(36, 'E0800504', eurAb(b.betrag)),
            ),
        )
        .join('');
    const gesFestSum = beteiligungen.reduce((s, b) => s + Number(eurAb(b.betrag)), 0);
    const gesFest = beteiligungen.length
        ? wrap(28, 'Ges_Fest', gesFestEinz + wrap(32, 'Sum', leaf(36, 'E0800502', String(gesFestSum))))
        : '';

    return wrap(20, 'G', leaf(24, 'Person', 'PersonA') + wrap(24, 'Gew', einzU + gesFest));
}

/** `<N>` Anlage N: Lohnsteuerbescheinigung (Sum) + Werbungskosten (EP/Homeoffice/further). */
function buildN(ctx: EstXmlContext): string {
    const inputs = ctx.inputs;
    if (inputs.bruttoarbeitslohn <= 0) return '';
    const e = inputs.einbehalten;

    // LStB_1_5_Sum: Bruttoarbeitslohn is GeldBetragOhneCent, the Steuerabzugsbeträge are
    // GeldBetragMitCent — same row, different Betragsformate (see the file header).
    const arbL = wrap(
        24,
        'ArbL',
        wrap(
            28,
            'LStB_1_5_Sum',
            leaf(32, 'E0200002', String(ctx.jahr.steuerklasse)) +
                leaf(32, 'E0200201', eurAb(inputs.bruttoarbeitslohn)) +
                leaf(32, 'E0200301', centDe(e.lohnsteuer)) +
                (e.soli > 0 ? leaf(32, 'E0200401', centDe(e.soli)) : '') +
                (e.kirchensteuer > 0 ? leaf(32, 'E0200501', centDe(e.kirchensteuer)) : ''),
        ),
    );

    // EP (Entfernungspauschale): declared as INPUTS — Tage + einfache Entfernung; the FA
    // computes the Pauschale. Ziel '1' = erste Tätigkeitsstätte.
    const pendel = inputs.werbungskosten.pendel;
    const ep =
        pendel && pendel.tage > 0 && pendel.kmEinfach > 0
            ? wrap(
                  28,
                  'EP',
                  wrap(
                      32,
                      'Erste_Taetig',
                      leaf(36, 'E0203003', '1') +
                          leaf(36, 'E0203501', ctx.jahr.werbungskosten?.pendel?.ziel ?? '') +
                          leaf(36, 'E0203503', String(pendel.tage)) +
                          leaf(36, 'E0203504', String(Math.floor(pendel.kmEinfach))),
                  ),
              )
            : '';

    // Homeoffice-Tagespauschale: E0204507 (ein anderer Arbeitsplatz steht zur Verfügung)
    // vs E0206206 (dauerhaft kein anderer Arbeitsplatz) — config-driven, never guessed.
    const hoTage = inputs.werbungskosten.homeofficeTage;
    const homeoffice =
        hoTage > 0
            ? wrap(
                  28,
                  'Homeoffice',
                  ctx.jahr.werbungskosten?.homeoffice_anderer_arbeitsplatz
                      ? leaf(32, 'E0204507', String(hoTage))
                      : leaf(32, 'E0206206', String(hoTage)),
              )
            : '';

    // All generic Posten (config + transaction-derived) go to Weitere_Wk/Sonst — the
    // catch-all line with free Bezeichnung; no Posten is re-labelled into a specific
    // category it may not belong to.
    const posten = inputs.werbungskosten.posten;
    const sonst = posten
        .map((p) =>
            wrap(32, 'Sonst', leaf(36, 'E0205405', freitext(p.bezeichnung)) + leaf(36, 'E0205406', eurAuf(p.betrag))),
        )
        .join('');
    const sonstSum = posten.reduce((s, p) => s + Number(eurAuf(p.betrag)), 0);
    const weitereWk = posten.length
        ? wrap(28, 'Weitere_Wk', sonst + wrap(32, 'Sum', leaf(36, 'E0204803', String(sonstSum))))
        : '';

    const wk = ep || homeoffice || weitereWk ? wrap(24, 'Wk', ep + homeoffice + weitereWk) : '';
    return wrap(20, 'N', leaf(24, 'Person', 'PersonA') + arbL + wk);
}

/** `<VOR>` Anlage Vorsorgeaufwand: RV (AN+AG together), statutory KV/PV, AV-Beiträge. */
function buildVOR(ctx: EstXmlContext): string {
    const v = ctx.inputs.vorsorge;
    const av = ctx.jahr.vorsorge?.av_arbeitnehmer ?? 0;

    // Plausi [950020]: E2000401 (AN) and E2000801 (AG) must be given TOGETHER.
    const aVor =
        v.rvArbeitnehmer > 0 || v.rvArbeitgeberSteuerfrei > 0
            ? wrap(
                  24,
                  'AVor',
                  leaf(28, 'Person', 'PersonA') +
                      leaf(28, 'E2000401', eurRund(v.rvArbeitnehmer)) +
                      leaf(28, 'E2000801', eurRund(v.rvArbeitgeberSteuerfrei)),
              )
            : '';
    const kvPv =
        v.kvBasis > 0 || v.pvBasis > 0
            ? wrap(
                  24,
                  'Beitr_g_KV_PV_Inl',
                  leaf(28, 'Person', 'PersonA') +
                      wrap(
                          28,
                          'AN',
                          (v.kvBasis > 0 ? leaf(32, 'E2001203', eurRund(v.kvBasis)) : '') +
                              (v.pvBasis > 0 ? leaf(32, 'E2001505', eurRund(v.pvBasis)) : ''),
                      ),
              )
            : '';
    // AV-Beiträge (Bescheinigung Nr. 27) — the dedicated Zeile E2004403.
    const weitere =
        av > 0
            ? wrap(
                  24,
                  'Weit_Sons_VorAW',
                  wrap(28, 'Pers', leaf(32, 'Person', 'PersonA') + leaf(32, 'E2004403', eurRund(av))),
              )
            : '';

    return aVor || kvPv || weitere ? wrap(20, 'VOR', aVor + kvPv + weitere) : '';
}

/** `<Vorsatz>`: master data of the Verfahren (Unterfallart 10, StNr, IdNr, Absender). */
function buildVorsatz(ctx: EstXmlContext): string {
    const p = ctx.config.person;
    const absStr = `${p.strasse}${p.hausnummer ? ` ${p.hausnummer}` : ''}`;
    return wrap(
        20,
        'Vorsatz',
        leaf(24, 'Unterfallart', '10') +
            leaf(24, 'Vorgang', '01') +
            leaf(24, 'StNr', ctx.steuernr13) +
            leaf(24, 'ID', p.steuer_id as string) +
            leaf(24, 'Zeitraum', String(ctx.inputs.year)) +
            leaf(24, 'AbsName', freitext(`${ctx.nachname} ${ctx.vorname}`, 45)) +
            leaf(24, 'AbsStr', freitext(absStr, 30)) +
            leaf(24, 'AbsPlz', p.plz as string) +
            leaf(24, 'AbsOrt', freitext(p.ort as string, 29)) +
            leaf(24, 'Copyright', '(C) 2025 Bayerisches Landesamt für Steuern') +
            leaf(24, 'OrdNrArt', 'S') +
            wrap(24, 'Rueckuebermittlung', leaf(28, 'Bescheid', '2')),
    );
}

/**
 * Build the inner `<E10>` Nutzdaten block (16-space base indent for the EDS envelope).
 * Block order is the binding E10 xs:sequence: ESt1A · SA · AgB · HA_35a · Kind · G · N ·
 * VOR · Vorsatz.
 */
export function buildEstNutzdaten(config: EstConfig, inputs: EstInputs, aggregate: EstTxAggregate): string {
    const ctx = resolveContext(config, inputs, aggregate);
    return (
        `${pad(16)}<E10 xmlns="${EST_NS}" version="2025">\n` +
        buildESt1A(ctx) +
        buildSA(ctx) +
        buildAgB(ctx) +
        buildHA35a(ctx) +
        buildKindBlocks(ctx) +
        buildG(ctx) +
        buildN(ctx) +
        buildVOR(ctx) +
        buildVorsatz(ctx) +
        `${pad(16)}</E10>\n`
    );
}

/** Build the complete EDS document for the Einkommensteuererklärung. */
export function buildEstEds(config: EstConfig, inputs: EstInputs, aggregate: EstTxAggregate): string {
    const nutzdaten = buildEstNutzdaten(config, inputs, aggregate);
    const steuernr13 = toElsterSteuernummer(config.person.steuernummer as string);
    return buildEdsEnvelope({
        verfahren: 'ElsterErklaerung',
        datenArt: 'ESt',
        vorgang: 'send-Auth',
        testMode: config.test_mode,
        herstellerId: config.hersteller_id,
        datenLieferant: config.datenlieferant,
        empfaenger: bufaFromElsterSteuernummer(steuernr13),
        // The E10 reference example carries the Land-Ziel in the TransferHeader; ERiC
        // 43.4.6.0 validates the ESt with AND without it (verified empirically) — we emit
        // it to match the official example.
        empfaengerZiel: bundeslandZiel(config.person.bundesland),
        produktName: 'steuererklaerung-cli',
        produktVersion: '0.1.0',
        nutzdatenLieferant: config.person.name,
        nutzdaten,
    });
}

export function getEstOutputFilename(entityId: string, year: number): string {
    return `est-${entityId}-${year}.xml`;
}

/** Write the Einkommensteuererklärung EDS XML to the configured output directory. */
export function writeEstXml(
    config: EstConfig,
    inputs: EstInputs,
    aggregate: EstTxAggregate,
    outputPath?: string,
): string {
    const xml = buildEstEds(config, inputs, aggregate);
    const dir = config.output_directory;
    const filename = outputPath || join(dir, getEstOutputFilename(config.entity_id, inputs.year));
    mkdirSync(dir, { recursive: true });
    writeFileSync(filename, xml, 'utf-8');
    return filename;
}
