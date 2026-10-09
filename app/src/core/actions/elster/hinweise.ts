/**
 * Assemble the FULL advisory Hinweise for one entity-year — the single place the {@link HinweiseInput}
 * is built from the shared EÜR aggregate + the period's DMS documents.
 *
 * Both surfaces that show Einblicke funnel through here so they CANNOT diverge: the web review cache
 * (presenters/year-snapshot.ts → `/api/hinweise`) and the native app's Auswertungen view
 * (frontends/desktop/data/auswertungen.ts). Before this existed the desktop copy hand-built a REDUCED
 * input (only umsatz/outputVat/unclassified/nachtraeglichNet/afa), silently dropping the USt-, GewSt-,
 * Beleg-Lücke-, Betriebsaufgabe-, Doppelzahlung- and Frist-Hinweise the web showed — the bug this
 * function fixes.
 *
 * Pure of any HTTP itself; it reads the local filings register for the year's already-filed USt-VA
 * Vorauszahlungen (same precedence as {@link usteReport}). Give it the SAME `agg` + `docs` from both
 * frontends and it yields byte-identical Hinweise by construction.
 */

import {
    loadHinweiseGeprueft,
    loadLaufendeKostenEntscheidungen,
    saveHinweisGeprueft,
    type ElsterConfig,
    type HinweisGeprueft,
} from '../../config/index.ts';
import { beitragsZeilen, type EuerTxAggregate } from '../../elster/euer-transactions.ts';
import type { DmsDocument } from '@steuererklaerung/dms';
import { loadStatements, searchAccountKeys, searchTransactions } from '@steuererklaerung/store';
import { round2 } from '../../lib/money.ts';
import { computeHinweise, sortHinweise, type Hinweis, type HinweisBuchung } from '../../elster/hinweise.ts';
import { pruefeKontoauszuege, type KontoauszugKonto } from '../../elster/kontoauszug.ts';
import { pruefeIbanWechsel } from '../../elster/iban-wechsel.ts';
import { pruefeDoppelteRechnungen } from '../../elster/doppelte-rechnung.ts';
import { pruefeLieferantDoppeltBezahlt } from '../../elster/lieferant-doppelt-bezahlt.ts';
import {
    laufendeKostenIds,
    laufendeKostenUebersicht,
    preisaenderungHinweise,
    type LaufendeKosten,
} from '../../elster/laufende-kosten.ts';
import { accountName } from '../../elster/home.ts';
import type { DoppelzahlungHinweisDaten } from '../invoices/doppelzahlung.ts';
import { type ForderungenHinweisDaten, verjaehrungHinweise } from '../../invoices/forderungen-hinweis.ts';
import { aggregateUsteFromEuerTx } from '../../elster/uste-aggregate.ts';
import { computeGewst } from '../../elster/gewst.ts';
import { jahresAbgabefrist } from '../../elster/fristen.ts';
import { erklaerteUstva, prepaidVatFromFilings } from '../filings.ts';
import { listEntityContacts } from '../contacts.ts';
import { pruefeUstAbweichung, ustZeitraeume } from '../../elster/ust-abweichung.ts';
import { pruefeBuchungenOhneUst } from '../../elster/ust-ohne-angabe.ts';
import { reverseChargeKandidaten, type RcPartei } from '../../elster/reverse-charge-kandidat.ts';
import { pruefeAnlagegutKandidaten } from '../../elster/anlagegut-kandidat.ts';
import { totalSonderbetriebsausgaben } from './euer.ts';
import { mapHinz, mapKuerz } from './gewst.ts';

export type { Hinweis } from '../../elster/hinweise.ts';

export interface YearHinweiseInput {
    /** The reporting year. */
    year: number;
    /** The shared EÜR aggregate — build it with `detail: true` so the Beleg-Lücke is derived from the
     *  same per-transaction rows the review list shows. */
    agg: EuerTxAggregate;
    /** The entity's ELSTER config, if any — gates the USt / GewSt / Frist / Betriebsaufgabe hints. */
    elster?: ElsterConfig;
    /** The period's DMS documents — a booking counts as "belegt" when a document links to it. */
    docs: DmsDocument[];
    /** Double-payment counts (+ items) for the year (see `doppelzahlungHinweisCounts`); both callers
     *  (web year cache, desktop Auswertungen) pass it, so both show the same hints. */
    doppelzahlung?: DoppelzahlungHinweisDaten;
    /** The entity's open claims (see `forderungenHinweisDaten`) — feeds the Verjährung hint. */
    forderungen?: ForderungenHinweisDaten;
    /** The entity's store accounts — enables the „Kontoauszug lückenlos?" check. */
    accountKeys?: string[];
    /** The entity id — reads its „in Ordnung" decisions; without it nothing is filtered. */
    entityId?: string;
    /** Reference date YYYY-MM-DD (default: today) — whether the year is over. */
    today?: string;
    /** Also return the hints marked „in Ordnung" (flagged `erledigt`), for the CLI `--alle`. */
    alle?: boolean;
    /** The previous year's aggregate (detail rows) — history for the USt-Abweichung across January. */
    vorjahr?: EuerTxAggregate;
}

/** A hint plus whether the owner marked THIS finding „in Ordnung". */
export type YearHinweis = Hinweis & { erledigt?: true };

/**
 * The audit-relevant Beleg gap: Σ|Vorsteuer| + count of the VAT-bearing expense rows that NO linked
 * receipt covers. DMS-agnostic (`linkedTxIds` already resolved by the provider), and equivalent to the
 * `!receipt` filter the web year-cache applied over the receipt-joined rows.
 */
function belegLuecke(
    agg: EuerTxAggregate,
    docs: DmsDocument[],
): { count: number; sum: number; rows: HinweisBuchung[] } {
    const linked = new Set<string>();
    for (const d of docs) for (const id of d.linkedTxIds) linked.add(id);
    const gap = (agg.detail ?? []).filter((r) => r.kind === 'expense' && Math.abs(r.vat) > 0.005 && !linked.has(r.id));
    return {
        count: gap.length,
        sum: round2(gap.reduce((s, r) => s + Math.abs(r.vat), 0)),
        rows: gap.map((r) => ({
            id: r.id,
            bookingDate: r.bookingDate,
            amount: r.amount,
            counterparty: r.counterparty,
            purpose: r.purpose,
        })),
    };
}

/**
 * The entity's accounts as the Kontoauszug check needs them: every booking (all years) and the
 * stored statement metadata, labelled like the Übersicht labels them.
 */
export function loadKontoauszugKonten(accountKeys: string[], labels?: Record<string, string>): KontoauszugKonto[] {
    const byKey = new Map<string, KontoauszugKonto>();
    for (const t of searchAccountKeys(accountKeys, {})) {
        let k = byKey.get(t.accountKey);
        if (!k) {
            k = {
                accountKey: t.accountKey,
                label: accountName(t.accountKey, t.source, labels),
                source: t.source,
                txs: [],
                statements: loadStatements(t.accountKey),
            };
            byKey.set(t.accountKey, k);
        }
        k.txs.push({ bookingDate: t.bookingDate, amount: t.amount });
    }
    return [...byKey.values()];
}

/** Whether a decision covers this very finding (same key, year and fingerprint). */
export function istErledigt(h: Hinweis, year: number, geprueft: readonly HinweisGeprueft[]): boolean {
    return (
        h.fingerprint != null &&
        geprueft.some((d) => d.hinweis === h.key && d.jahr === year && d.fingerprint === h.fingerprint)
    );
}

/**
 * Mark one finding „in Ordnung": stored per entity with its key, year and fingerprint, so a NEW
 * finding under the same key shows again. Refuses a hint that offers no such action.
 */
export function markHinweisOk(
    entityId: string,
    h: Hinweis,
    year: number,
    opts: { path?: string; today?: string } = {},
): void {
    if (!h.fingerprint || !h.handlungen?.some((a) => a.target.art === 'aktion' && a.target.aktion === 'hinweis-ok')) {
        throw new Error(`Der Hinweis „${h.title}" lässt sich nicht als in Ordnung markieren.`);
    }
    saveHinweisGeprueft(
        entityId,
        {
            hinweis: h.key,
            jahr: year,
            fingerprint: h.fingerprint,
            geprueft_am: opts.today ?? new Date().toISOString().slice(0, 10),
        },
        opts.path,
    );
}

/**
 * Compute the year's Hinweise from the aggregate + documents + ELSTER config. The USt figures, the
 * GewSt-Messbetrag and the next filing deadline are derived exactly as the web review cache derived
 * them inline, so the web `/api/hinweise` output is unchanged while the desktop view now matches it.
 */
export function computeYearHinweise(input: YearHinweiseInput): YearHinweis[] {
    const { year, agg, elster, docs } = input;

    // USt-Jahr figures (Zahllast/Abschluss/Vorauszahlungen) — register-backed prepaid VAT when filed,
    // else the manual config, same precedence as usteReport.
    const prepaidVat = elster ? (prepaidVatFromFilings(elster.entity_id, year) ?? elster.uste?.prepaid_vat ?? 0) : 0;
    const uste = elster ? aggregateUsteFromEuerTx(agg, prepaidVat) : null;

    // Gewerbeertrag → Messbetrag (only the Messbetrag drives a hint; 0 € ⇒ under the Freibetrag).
    const messbetrag = elster?.gewerbe
        ? computeGewst({
              profit: round2(
                  round2(agg.totals.profit) - totalSonderbetriebsausgaben(elster) - agg.totals.nachtraeglichNet,
              ),
              hinzurechnungen: mapHinz(elster.gewerbe.hinzurechnungen),
              kuerzungen: mapKuerz(elster.gewerbe.kuerzungen),
              hebesatz: elster.gewerbe.hebesatz,
              gemeinde: elster.gewerbe.gemeinde,
              year,
          }).messbetrag
        : null;

    // The next annual-declaration deadline. For an ELSTER entity the Steuer-Dashboard always lists at
    // least the Anlage EÜR (its `euerGewinn` is always present) and every Frist shares the one
    // Regelabgabefrist, so it reduces to the statutory jahresAbgabefrist(year, extension).
    const nextDeadline = elster ? jahresAbgabefrist(year, elster.deadline_extension_months ?? 0) : undefined;

    const basis = computeHinweise({
        year,
        umsatz: round2(agg.totals.incomeNet),
        outputVat: round2(agg.totals.outputVat),
        uste: uste
            ? { vatPayable: uste.vatPayable, closingBalance: uste.closingBalance, prepaidVat: uste.prepaidVat }
            : null,
        gewst: messbetrag != null ? { messbetrag } : null,
        belegLuecke: belegLuecke(agg, docs),
        unclassified: agg.coverage.unclassified.length,
        unclassifiedRows: agg.coverage.unclassified,
        businessEndDate: elster?.business_end_date,
        nachtraeglichNet: agg.totals.nachtraeglichNet,
        doppelzahlungen: elster?.adjustments?.doppelzahlungen?.length ?? 0,
        doppelzahlungVerdacht: input.doppelzahlung?.verdacht,
        doppelzahlungVerdachtListe: input.doppelzahlung?.verdachtListe,
        rueckzahlungOffen: input.doppelzahlung?.rueckzahlungOffen,
        rueckzahlungOffenListe: input.doppelzahlung?.rueckzahlungOffenListe,
        afa: agg.expenses.find((c) => c.category.startsWith('4830'))?.net,
        afaCount: elster?.adjustments?.anlageverzeichnis?.length,
        nextDeadline,
    });

    const kontoauszug = input.accountKeys
        ? kontoauszugHinweise({
              year,
              accountKeys: input.accountKeys,
              labels: elster?.account_labels,
              businessEndDate: elster?.business_end_date,
              today: input.today,
          })
        : [];
    const geld = input.accountKeys
        ? geldPruefungen({
              year,
              accountKeys: input.accountKeys,
              docs,
              labels: elster?.account_labels,
              entityId: input.entityId,
          })
        : [];
    const vorAbgabe = elster
        ? vorAbgabePruefungen({
              year,
              agg,
              vorjahr: input.vorjahr,
              docs,
              elster,
              accountKeys: input.accountKeys,
              entityId: input.entityId,
              today: input.today,
          })
        : [];
    return ohneErledigte(
        sortHinweise([...basis, ...kontoauszug, ...geld, ...vorAbgabe, ...verjaehrungHinweise(input.forderungen)]),
        year,
        input.entityId,
        input.alle,
    );
}

/**
 * The Prüfungen vor der Abgabe (Idee 10) over the year's EÜR rows: USt-Abweichung, Buchungen ohne
 * USt-Angabe, § 13b-Kandidat and Anlagegut-Kandidat. „Kleinunternehmer" is read like the Besteuerungsart
 * hint reads it — no USt collected in the year. Fail-soft per source: an unreadable register, contact
 * list or store makes a check see less, never breaks the others.
 */
export function vorAbgabePruefungen(i: {
    year: number;
    agg: EuerTxAggregate;
    vorjahr?: EuerTxAggregate;
    docs: DmsDocument[];
    elster: ElsterConfig;
    accountKeys?: string[];
    entityId?: string;
    today?: string;
}): Hinweis[] {
    const zeilen = i.agg.detail ?? [];
    const kleinunternehmer = i.agg.totals.incomeNet > 0.005 && !(i.agg.totals.outputVat > 0.005);
    const failSoft = <T>(fn: () => T, fallback: T): T => {
        try {
            return fn();
        } catch {
            return fallback;
        }
    };

    const erklaert = failSoft(() => erklaerteUstva(i.elster.entity_id, [i.year - 1, i.year]), []);
    const ustZeilen = [...(i.vorjahr?.detail ?? []), ...zeilen];
    const ust = pruefeUstAbweichung({
        year: i.year,
        zeitraeume: ustZeitraeume({
            zeilen: ustZeilen,
            erklaert,
            rhythmus: i.elster.period.month != null ? 'monat' : 'quartal',
        }),
        zeilen: ustZeilen,
        today: i.today ?? new Date().toISOString().slice(0, 10),
        kleinunternehmer,
    });

    const parteien: RcPartei[] = i.entityId
        ? failSoft(
              () =>
                  listEntityContacts(i.entityId!).map((c) => ({
                      name: c.name,
                      land: c.countryCode,
                      ustId: c.vatNumber,
                      iban: c.iban,
                  })),
              [],
          )
        : [];
    const rc = reverseChargeKandidaten({ year: i.year, zeilen, belege: i.docs, parteien, kleinunternehmer });
    const ohneUst = pruefeBuchungenOhneUst({
        year: i.year,
        zeilen,
        belege: i.docs,
        ausgenommen: rc.ids,
        kleinunternehmer,
    });

    const buchungen = i.accountKeys ? failSoft(() => searchAccountKeys(i.accountKeys!, {}), []) : [];
    const anlage = pruefeAnlagegutKandidaten({
        year: i.year,
        // A split booking counts with its parts: a private part is no asset, a business one may be.
        zeilen: beitragsZeilen(zeilen),
        anlagen: (i.elster.adjustments?.anlageverzeichnis ?? []).map((a) => ({
            anschaffung: a.anschaffung,
            ahk: a.ahk,
            buchungIds: a.buchung_ids,
        })),
        laufendeKostenIds: laufendeKostenIds(bestaetigteLaufendeKosten(i.entityId, buchungen)),
        kleinunternehmer,
    });
    return [...ust, ...ohneUst, ...rc.hinweise, ...anlage];
}

/**
 * The IBANs of every account in the store (all entities): a payment to one of them is an Umbuchung,
 * an Einlage or an Entnahme — never a supplier's new account. A `camt:<IBAN>` key counts too.
 */
export function eigeneIbans(): string[] {
    const out = new Set<string>();
    for (const t of searchTransactions({}).transactions) {
        if (t.iban) out.add(t.iban);
        const m = /^camt:([A-Z]{2}\d{2}[A-Z0-9]{8,30})$/i.exec(t.accountKey);
        if (m) out.add(m[1]);
    }
    return [...out];
}

/**
 * The entity's CONFIRMED laufende Kosten (Idee 8) over its bookings — what the Geld-Prüfungen leave out.
 * Fail-soft: an unreadable manifest confirms nothing, so nothing is excluded that was not decided.
 */
function bestaetigteLaufendeKosten(
    entityId: string | undefined,
    buchungen: Parameters<typeof laufendeKostenUebersicht>[0],
): LaufendeKosten[] {
    if (!entityId) return [];
    try {
        return laufendeKostenUebersicht(buchungen, loadLaufendeKostenEntscheidungen(entityId)).bestaetigt;
    } catch {
        return [];
    }
}

/**
 * The Geld-Prüfungen (Idee 7): IBAN-Wechsel over the entity's bookings of all years, Doppelte Rechnung
 * over the year's incoming documents, Lieferant doppelt bezahlt over both — the last two without the
 * confirmed laufende Kosten (Idee 8), which also bring the „Preisänderung" hint. Fail-soft per check: an
 * unreadable store hides these hints, it never breaks the others.
 */
export function geldPruefungen(i: {
    year: number;
    accountKeys: string[];
    docs: DmsDocument[];
    labels?: Record<string, string>;
    /** Reads the confirmed laufende Kosten; without it none are excluded. */
    entityId?: string;
}): Hinweis[] {
    let buchungen: ReturnType<typeof searchAccountKeys> = [];
    try {
        buchungen = searchAccountKeys(i.accountKeys, {});
    } catch {
        buchungen = [];
    }
    let eigene: string[] = [];
    try {
        eigene = eigeneIbans();
    } catch {
        eigene = [];
    }
    const laufend = bestaetigteLaufendeKosten(i.entityId, buchungen);
    return [
        ...pruefeIbanWechsel({
            year: i.year,
            buchungen,
            eigeneIbans: eigene,
            kontoLabel: (k, source) => accountName(k, source, i.labels),
        }),
        ...pruefeDoppelteRechnungen({ year: i.year, belege: i.docs, laufendeKosten: laufend }),
        ...pruefeLieferantDoppeltBezahlt({
            year: i.year,
            belege: i.docs,
            buchungen,
            laufendeKostenIds: laufendeKostenIds(laufend),
        }),
        ...preisaenderungHinweise(laufend, i.year),
    ];
}

/** The „Kontoauszug lückenlos?" hints for an entity's accounts (store + statement metadata). */
export function kontoauszugHinweise(i: {
    year: number;
    accountKeys: string[];
    labels?: Record<string, string>;
    businessEndDate?: string;
    today?: string;
}): Hinweis[] {
    return pruefeKontoauszuege({
        year: i.year,
        konten: loadKontoauszugKonten(i.accountKeys, i.labels),
        businessEndDate: i.businessEndDate,
        today: i.today ?? new Date().toISOString().slice(0, 10),
    });
}

/**
 * Drop the findings the owner marked „in Ordnung" (or, with `alle`, flag them `erledigt`). Fail-soft:
 * an unreadable manifest hides no hint — it only cannot know what was dismissed.
 */
export function ohneErledigte(hints: Hinweis[], year: number, entityId?: string, alle?: boolean): YearHinweis[] {
    let geprueft: HinweisGeprueft[] = [];
    if (entityId) {
        try {
            geprueft = loadHinweiseGeprueft(entityId);
        } catch {
            geprueft = [];
        }
    }
    const out: YearHinweis[] = [];
    for (const h of hints) {
        if (!istErledigt(h, year, geprueft)) out.push(h);
        else if (alle) out.push({ ...h, erledigt: true });
    }
    return out;
}
