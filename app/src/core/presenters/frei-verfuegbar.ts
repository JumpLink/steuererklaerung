/**
 * Frei-verfügbar presenter — loads the figures {@link computeFreiVerfuegbar} combines, for ONE entity.
 * Shared by the desktop Übersicht, the CLI (`frei-verfuegbar`) and the MCP tool (`frei_verfuegbar`).
 *
 * Every input is scoped to the entity, so a dissolved GbR and its successor never mix: the balance
 * and the GewSt payments come from the entity's own accounts, the USt from its own EÜR bookings,
 * the filings from its register ids, the open invoices from its own DMS. A loader that fails turns
 * into a "nicht berechenbar, weil …" term, never into a silent 0 €.
 *
 * Pure TS (core + `@steuererklaerung/*` only) — no gi://, GTK/Adwaita, DOM, Hono, yargs or zod.
 */

import { entityIdAliases, searchAccountKeys, type Filing } from '@steuererklaerung/store';
import {
    computeFreiVerfuegbar,
    ustZeitraum,
    type EingangsrechnungenInput,
    type EstSchaetzung,
    type FreiVerfuegbarModel,
    type GewstSchaetzung,
    type KontoSaldo,
    type LaufendeKostenInput,
    type Teil,
    type UstBuchung,
    type UstSeitVaInput,
    type UstVaStand,
} from '../elster/frei-verfuegbar.ts';
import { computeOffeneSteuerzahlungen, type OffeneSteuerzahlung } from '../elster/steuerzahlungen.ts';
import { accountName } from '../elster/home.ts';
import { estReport } from '../actions/elster/est.ts';
import { listFilings } from '../actions/filings.ts';
import { listOpenItems } from '../actions/fristen.ts';
import { estJahr } from '../config/index.ts';
import { loadGewst, loadSteuerkonto } from './steuer.ts';
import { loadLaufendeKosten } from './laufende-kosten.ts';
import type { PresenterSession } from './session.ts';
import type { EntityModel } from './workspace.ts';

export type { FreiVerfuegbarModel } from '../elster/frei-verfuegbar.ts';

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Close a "weil …" clause with exactly one full stop. */
const satz = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

const STEUER_AUS =
    'die deutschen Steuerfunktionen für diese Entität ausgeschaltet sind (Einstellungen → Land & Steuern).';

function konten(entity: EntityModel): KontoSaldo[] {
    const byKey = new Map<string, KontoSaldo>();
    for (const t of searchAccountKeys(entity.accountKeys, {})) {
        const k = byKey.get(t.accountKey) ?? {
            name: accountName(t.accountKey, t.source, entity.elster?.account_labels),
            accountKey: t.accountKey,
            saldo: 0,
            letzteBuchung: null,
        };
        k.saldo += t.amount;
        if (!k.letzteBuchung || t.bookingDate > k.letzteBuchung) k.letzteBuchung = t.bookingDate;
        byKey.set(t.accountKey, k);
    }
    return [...byKey.values()];
}

function ownFilings(entity: EntityModel): Teil<Filing[]> {
    try {
        const ids = new Set(entityIdAliases(entity.id));
        return { status: 'ok', daten: listFilings().filter((f) => ids.has(f.entityId)) };
    } catch (err) {
        return { status: 'nicht-berechenbar', grund: `das Fristen-Register nicht lesbar ist: ${satz(errText(err))}` };
    }
}

async function ust(
    session: PresenterSession,
    entity: EntityModel,
    filings: Teil<Filing[]>,
    stichtag: string,
): Promise<Teil<UstSeitVaInput>> {
    if (!entity.capabilities.vatReturn) return { status: 'entfaellt', grund: STEUER_AUS };
    const elster = entity.elster;
    if (!elster) return { status: 'entfaellt', grund: 'hier keine Umsatzsteuer anfällt (keine ELSTER-Angaben).' };
    if (filings.status !== 'ok') return filings;
    const stand: UstVaStand = {
        // Released from Voranmeldungen → no period was declared, the whole year is still open.
        cadence: elster.ust_va_befreit
            ? null
            : elster.period.quarter != null
              ? 'quarter'
              : elster.period.month != null
                ? 'month'
                : null,
        dauerfrist: elster.ust_dauerfristverlaengerung ?? false,
        eingereicht: filings.daten
            .filter((f) => f.kind === 'ustva' && f.filedAt)
            .map((f) => ({ period: f.period, filedAt: f.filedAt! })),
        businessStart: elster.business_start_date,
        businessEnd: elster.business_end_date,
        basis: elster.taxation_basis,
    };
    const { von } = ustZeitraum(stand, stichtag);
    let buchungen: Teil<UstBuchung[]>;
    try {
        const rows: UstBuchung[] = [];
        for (let y = Number(von.slice(0, 4)); y <= Number(stichtag.slice(0, 4)); y++) {
            const agg = await session.aggregate(entity, y);
            // Synthetic year-end rows (AfA, Privatanteil) carry no payment date — not "since the VA".
            for (const r of agg.detail ?? []) if (r.accountKey !== 'adjustment') rows.push(r);
        }
        buchungen = { status: 'ok', daten: rows };
    } catch (err) {
        buchungen = {
            status: 'nicht-berechenbar',
            grund: `die Buchungen nicht geladen werden konnten: ${satz(errText(err))}`,
        };
    }
    return { status: 'ok', daten: { ...stand, buchungen } };
}

function steuerzahlungen(entity: EntityModel, filings: Teil<Filing[]>, stichtag: string): Teil<OffeneSteuerzahlung[]> {
    if (!entity.capabilities.taxDeadlines) return { status: 'entfaellt', grund: STEUER_AUS };
    if (filings.status !== 'ok') return filings;
    const self = {
        ids: entityIdAliases(entity.id),
        entityId: entity.id,
        entityName: entity.name,
        dauerfrist: entity.elster?.ust_dauerfristverlaengerung ?? false,
    };
    return { status: 'ok', daten: computeOffeneSteuerzahlungen(filings.daten, [self], stichtag) };
}

/**
 * Open supplier invoices. Paperless knows "offen" explicitly (custom field payment_status); the
 * built-in DMS has no payment status, so there an incoming invoice counts as open while no payment
 * is linked to it. Both are limited to this entity's documents of the current and previous year.
 */
async function eingangsrechnungen(
    session: PresenterSession,
    entity: EntityModel,
    stichtag: string,
): Promise<Teil<EingangsrechnungenInput>> {
    const year = Number(stichtag.slice(0, 4));
    try {
        const [prev, cur] = await Promise.all([session.documents(entity, year - 1), session.documents(entity, year)]);
        const incoming = [...prev.docs, ...cur.docs].filter((d) => d.direction === 'incoming');
        if (cur.dmsKind === 'paperless') {
            const ids = new Set(incoming.map((d) => d.id));
            const open = (await listOpenItems({ today: stichtag })).filter((i) => ids.has(String(i.id)));
            const gross = new Map(incoming.map((d) => [d.id, d.gross]));
            return {
                status: 'ok',
                daten: {
                    regel: `Paperless: Eingangsrechnungen ${year - 1}–${year} mit Zahlungsstatus „offen“ (Betrag: zu zahlen, sonst brutto).`,
                    posten: open.map((i) => ({
                        id: String(i.id),
                        label: [i.correspondent, i.title].filter(Boolean).join(' — ') || `Dokument ${i.id}`,
                        betrag: i.amount ?? gross.get(String(i.id)) ?? null,
                        dueDate: i.dueDate,
                    })),
                },
            };
        }
        return {
            status: 'ok',
            daten: {
                regel: `Eingebautes DMS: Eingangsrechnungen ${year - 1}–${year} ohne verknüpfte Zahlung. Wer im Beleg-Eingang die Zahlung verknüpft, nimmt die Rechnung hier heraus.`,
                posten: incoming
                    .filter((d) => d.linkedTxIds.length === 0)
                    .map((d) => ({
                        id: d.id,
                        label:
                            [d.correspondent, d.invoiceNumber ?? d.title].filter(Boolean).join(' — ') ||
                            'Beleg ohne Titel',
                        betrag: d.gross,
                        dueDate: null,
                    })),
            },
        };
    } catch (err) {
        return { status: 'nicht-berechenbar', grund: `die Belege nicht geladen werden konnten: ${satz(errText(err))}` };
    }
}

/** The confirmed laufende Kosten (Idee 8) and how many proposals are still undecided. */
function laufendeKosten(session: PresenterSession, entity: EntityModel): Teil<LaufendeKostenInput> {
    try {
        const u = loadLaufendeKosten(session, entity);
        return {
            status: 'ok',
            daten: { bestaetigt: u.bestaetigt, offen: u.vorschlaege.length, datenstand: u.datenstand },
        };
    } catch (err) {
        return {
            status: 'nicht-berechenbar',
            grund: `die laufenden Kosten nicht geladen werden konnten: ${satz(errText(err))}`,
        };
    }
}

function est(entity: EntityModel, year: number): Teil<EstSchaetzung> {
    if (!entity.capabilities.taxForecast) return { status: 'entfaellt', grund: STEUER_AUS };
    if (!entity.est) {
        if (entity.elster?.gesellschafter.length) {
            return {
                status: 'entfaellt',
                grund: 'die Gesellschafter ihre Einkommensteuer persönlich zahlen — wie in der Steuer-Prognose.',
            };
        }
        return {
            status: 'nicht-berechenbar',
            grund: 'für diese Entität keine ESt-Angaben hinterlegt sind (Einstellungen → Privat).',
        };
    }
    if (!estJahr(entity.est, year)) {
        return {
            status: 'nicht-berechenbar',
            grund: `für ${year} keine ESt-Angaben hinterlegt sind (Einstellungen → Privat).`,
        };
    }
    try {
        const r = estReport(entity.est, year, { txs: searchAccountKeys(entity.accountKeys, {}) });
        const a = r.result.abrechnung;
        const vorauszahlungen = r.inputs.einbehalten.estVorauszahlung ?? 0;
        return {
            status: 'ok',
            daten: {
                soll: a.est.soll + a.soli.soll + a.kirchensteuer.soll,
                einbehalten: a.est.einbehalten + a.soli.einbehalten + a.kirchensteuer.einbehalten - vorauszahlungen,
                vorauszahlungen,
            },
        };
    } catch (err) {
        return { status: 'nicht-berechenbar', grund: `die ESt-Schätzung fehlschlug: ${satz(errText(err))}` };
    }
}

async function gewst(session: PresenterSession, entity: EntityModel, year: number): Promise<Teil<GewstSchaetzung>> {
    if (!entity.capabilities.tradeTax) return { status: 'entfaellt', grund: STEUER_AUS };
    const elster = entity.elster;
    if (!elster) return { status: 'entfaellt', grund: 'kein Gewerbebetrieb hinterlegt ist (keine ELSTER-Angaben).' };
    if (elster.business_end_date && elster.business_end_date < `${year}-01-01`) {
        return { status: 'entfaellt', grund: `der Betrieb vor ${year} aufgegeben wurde.` };
    }
    if (elster.business_start_date && elster.business_start_date > `${year}-12-31`) {
        return { status: 'entfaellt', grund: `der Betrieb erst nach ${year} begann.` };
    }
    if (!elster.gewerbe) {
        return { status: 'nicht-berechenbar', grund: 'Gemeinde und Hebesatz fehlen (Einstellungen → Gewerbesteuer).' };
    }
    try {
        const report = await loadGewst(session, entity, year);
        const zahlungen = loadSteuerkonto(session, entity, year)
            .groups.filter((g) => g.art === 'GewSt')
            .flatMap((g) => g.items)
            .filter((i) => i.bezugsjahr == null || i.bezugsjahr === year)
            .map((i) => ({
                datum: i.bookingDate,
                betrag: i.amount,
                text: i.purpose || i.counterparty || 'Gewerbesteuer',
            }));
        return {
            status: 'ok',
            daten: {
                gewerbesteuer: report.result.gewerbesteuer,
                messbetrag: report.result.messbetrag,
                hebesatz: elster.gewerbe.hebesatz,
                zahlungen,
            },
        };
    } catch (err) {
        return { status: 'nicht-berechenbar', grund: `die Gewerbesteuer-Schätzung fehlschlug: ${satz(errText(err))}` };
    }
}

/**
 * Frei verfügbar (as of `today`) + the Steuerrücklage of `year` (default: the year of `today`) for one
 * entity. `today` is YYYY-MM-DD; it defaults to the current date.
 */
export async function loadFreiVerfuegbar(
    session: PresenterSession,
    entity: EntityModel,
    opts: { year?: number; today?: string } = {},
): Promise<FreiVerfuegbarModel> {
    const stichtag = opts.today ?? new Date().toISOString().slice(0, 10);
    const jahr = opts.year ?? Number(stichtag.slice(0, 4));
    const filings = ownFilings(entity);
    const [ustTeil, belege, gewstTeil] = await Promise.all([
        ust(session, entity, filings, stichtag),
        eingangsrechnungen(session, entity, stichtag),
        gewst(session, entity, jahr),
    ]);
    return computeFreiVerfuegbar({
        stichtag,
        entityId: entity.id,
        entityName: entity.name,
        konten: konten(entity),
        ust: ustTeil,
        steuerzahlungen: steuerzahlungen(entity, filings, stichtag),
        eingangsrechnungen: belege,
        laufendeKosten: laufendeKosten(session, entity),
        ruecklage: { jahr, est: est(entity, jahr), gewst: gewstTeil },
    });
}
