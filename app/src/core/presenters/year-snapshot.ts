/**
 * Year-snapshot presenter — the full per-(entity,year) {@link YearCache} the web review server prefetches.
 *
 * This is the composition point: it fetches the period's EÜR aggregate + DMS documents ONCE and derives
 * every view from them (transactions, reconciliation, EÜR/BWA/USt/GewSt/Feststellung, the Assistent plan,
 * the Steuer-Dashboard, Home, Hinweise, Steuerkonto). The receipt-join + row enrichment are delegated to
 * the buchungen presenter ({@link buildDocByTx} / {@link enrichRows}) — the ONE implementation the native
 * Buchungen view shares. It formerly lived at core/actions/year-cache.ts as a "proto-presenter"; the web's
 * fill-ordering / readiness policy stays in frontends/web/server.ts (this only builds one snapshot).
 *
 * Outbound libsoup `fetch` (Paperless) deadlocks when issued INSIDE the libsoup HTTP server handler on
 * GJS once the server is past the ~10–13 s GC window. So the web fetches everything ONCE at startup
 * (before `serve()`), derives every view from a single EÜR aggregate, and the request handlers only read
 * the cache — no fetch during serving.
 *
 * Pure TS (core + `@steuererklaerung/*` only) — no gi://, GTK/Adwaita, DOM, Hono, yargs or zod.
 */

import type { SyncConfig } from '../config/index.ts';
import type { ElsterConfig } from '../config/index.ts';
import {
    euerReportByTransactions,
    buildEuerKennzahlen,
    sonderbetriebsausgabenMap,
    totalSonderbetriebsausgaben,
    buildAufgabegewinn,
} from '../actions/elster/euer.ts';
import { reconciliationFromDocs, type DmsProvider, type DmsDocument } from '@steuererklaerung/dms';
import { loadSteuerkontoScope, steuerkontoReport } from '../actions/elster/steuerkonto.ts';
import { mapHinz, mapKuerz } from '../actions/elster/gewst.ts';
import { toGesellschafter } from '../actions/elster/feststellung.ts';
import { assembleTaxReturnPlan, assembleEstPlan } from '../actions/elster/wizard.ts';
import { estReport } from '../actions/elster/est.ts';
import type { EstConfig } from '../config/index.ts';
import { aggregateUsteFromEuerTx } from '../elster/uste-aggregate.ts';
import { prepaidVatFromFilings } from '../actions/filings.ts';
import { computeBwa } from '../elster/bwa.ts';
import { computeSteuerDashboard } from '../elster/fristen.ts';
import { computeYearHinweise } from '../actions/elster/hinweise.ts';
import { doppelzahlungHinweisCounts } from '../actions/invoices/doppelzahlung.ts';
import { forderungenHinweisDaten } from '../actions/forderungen.ts';
import { computeGewst } from '../elster/gewst.ts';
import { computeFeststellung } from '../elster/feststellung.ts';
import { buildHomeModel, type HomeModel } from '../elster/home.ts';
import { round2 } from '../lib/money.ts';
import { searchTransactions, searchAccountKeys } from '../actions/transactions.ts';
import { buildDocByTx, enrichRows } from './buchungen.ts';

export interface YearCache {
    year: number;
    transactions: unknown;
    reconciliation: unknown;
    euer: unknown;
    bwa: unknown;
    uste: unknown | null;
    gewst: unknown | null;
    feststellung: unknown | null;
    /** The Steuererklärungs-Assistent plan (steps + form previews + readiness). For a `privat`
     *  entity this is the ESt plan; for a business entity the EÜR/USt/GewSt/Feststellung plan. */
    wizard: unknown | null;
    /** The private-ESt report (Steuer-Themen + Wasserfall) for a `privat` entity; null otherwise. */
    est: unknown | null;
    dashboard: unknown | null;
    /** Home / Übersicht dashboard model (KPIs, monthly series, categories, liquidity, tasks). */
    home: HomeModel | null;
    hinweise: unknown;
    steuerkonto: unknown;
    /** The period's DMS documents (same source as the receipt join) — for the Belege cards. */
    documents: DmsDocument[];
    /** Which back-end served them (drives the upload/inline-view UI). */
    dmsKind: 'builtin' | 'paperless';
}
/** Keyed by `${entityId}:${year}`. */
export type Cache = Map<string, YearCache>;

// snake_case config → camelCase compute shapes: shared with the CLI actions
// (mapHinz/mapKuerz from actions/elster/gewst, toGesellschafter from actions/elster/feststellung).
// The receipt-join (buildDocByTx/enrichRows) lives in presenters/buchungen.ts — the ONE implementation
// the native Buchungen view shares.

/**
 * Fetch + derive every view for one entity-year. Three Paperless fetches, then pure
 * derivations. `accountKeys` scopes the whole report to the entity's store accounts
 * (the EÜR aggregate, the tax-payment overview, and the raw-field lookup).
 */
export async function buildYearCache(
    config: SyncConfig,
    elster: ElsterConfig | undefined,
    year: number,
    accountKeys: string[],
    dms: DmsProvider,
    estConfig?: EstConfig,
    /** The workspace entity — its „in Ordnung" decisions filter the Hinweise. */
    entityId?: string,
): Promise<YearCache> {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const agg = await euerReportByTransactions(config, year, { detail: true, elster, accountKeys });
    const dmsDocs = await dms.list({ from, to });
    // The entity's store transactions for this period (reused for the raw-field lookup below).
    const entityStoreTxs = searchAccountKeys(accountKeys, { from, to });
    // Reconciliation derived from the docs we already fetched — no second outbound fetch.
    const reconciliation = reconciliationFromDocs(entityStoreTxs, dmsDocs, { from, to });
    const profit = round2(agg.totals.profit);
    const sbvTotal = elster ? totalSonderbetriebsausgaben(elster) : 0;
    const nachtraeglichNet = agg.totals.nachtraeglichNet;
    const aufgabe = elster ? buildAufgabegewinn(elster, year) : null;

    // The three tax sub-results, shared by their own cache fields AND the Steuer-Dashboard.
    // Prepaid VAT: register-backed (filed USt-VA) when available, else the manual config —
    // same precedence as usteReport, so the dashboard and the CLI/XML agree on the closing balance.
    const prepaidVat = elster ? (prepaidVatFromFilings(elster.entity_id, year) ?? elster.uste?.prepaid_vat ?? 0) : 0;
    const usteRes = elster ? aggregateUsteFromEuerTx(agg, prepaidVat) : null;
    const gewstRes = elster?.gewerbe
        ? computeGewst({
              profit: round2(profit - sbvTotal - nachtraeglichNet),
              hinzurechnungen: mapHinz(elster.gewerbe.hinzurechnungen),
              kuerzungen: mapKuerz(elster.gewerbe.kuerzungen),
              hebesatz: elster.gewerbe.hebesatz,
              gemeinde: elster.gewerbe.gemeinde,
              year,
          })
        : null;
    const festRes =
        elster && elster.gesellschafter.length
            ? computeFeststellung(
                  profit,
                  elster.gesellschafter.map(toGesellschafter),
                  year,
                  sonderbetriebsausgabenMap(elster),
                  aufgabe?.aufgabegewinn ?? 0,
              )
            : null;
    // A `privat` entity (est config, no ELSTER) uses the private-ESt report + plan; reuse the
    // entity's already-fetched store transactions so no store read happens during serving.
    // Guarded: an unsourced tax year (no §32a constants) must not sink the whole year cache
    // (transactions/home still work) — the Einkommensteuer view just shows nothing for that year.
    let estRep: ReturnType<typeof estReport> | null = null;
    if (estConfig) {
        try {
            estRep = estReport(estConfig, year, { txs: entityStoreTxs, detail: true });
        } catch (err) {
            console.error(`[data] ESt ${year}: ${err instanceof Error ? err.message : err}`);
        }
    }
    // The Steuererklärungs-Assistent plan — the ESt plan for a privat entity, else the business plan
    // assembled from the already-computed reports (no recompute).
    const wizard = estRep
        ? assembleEstPlan(estRep)
        : elster && usteRes
          ? assembleTaxReturnPlan({
                entityId: elster.entity_id,
                year,
                euer: agg,
                uste: usteRes,
                gewst: gewstRes ? { result: gewstRes, euer: agg } : null,
                feststellung: festRes ? { result: festRes, euer: agg, aufgabe: aufgabe ?? undefined } : null,
                hasBetrieb: !!elster.betrieb,
                betriebsaufgabeSchaetzung: !!elster.adjustments?.betriebsaufgabe,
            })
          : null;
    const dashboard =
        elster || estConfig
            ? computeSteuerDashboard({
                  year,
                  deadlineExtensionMonths: elster?.deadline_extension_months,
                  uste: usteRes
                      ? {
                            vatPayable: usteRes.vatPayable,
                            closingBalance: usteRes.closingBalance,
                            prepaidVat: usteRes.prepaidVat,
                        }
                      : null,
                  gewst: gewstRes ? { messbetrag: gewstRes.messbetrag, gewerbesteuer: gewstRes.gewerbesteuer } : null,
                  feststellung: festRes
                      ? {
                            einkuenfteGesamt: festRes.einkuenfteGesamt,
                            partner: festRes.allocations.map((a) => ({
                                name: a.gesellschafter.name,
                                anteil: a.gesamtAnteil,
                            })),
                        }
                      : null,
                  // EÜR-Gewinn only for a business entity; a privat entity's ESt drives the KPI instead.
                  euerGewinn: elster ? profit : null,
                  est: estConfig ? { erstattung: estRep?.result.erstattung ?? null } : null,
              })
            : null;

    // Display-only enrichment: account labels, internal-transfer pairing, PayPal linkage,
    // and the raw bank fields (for the transaction detail view) — scoped to the entity.
    const rawById = new Map(entityStoreTxs.map((t) => [t.id, t]));
    const docByTx = buildDocByTx(dmsDocs);
    const enrichOpts = {
        labels: elster?.account_labels,
        paypalTxs: searchTransactions({ source: 'paypal' }).transactions,
        rawById,
    };
    const rows = enrichRows(agg.detail ?? [], docByTx, enrichOpts);
    // The post-Betriebsaufgabe (§24/excluded) rows, enriched + receipt-joined the same way
    // so the review UI can render and link them like the laufende list.
    const aufgabeRows = enrichRows(agg.coverage.outsidePeriod, docByTx, enrichOpts);

    // Advisory Hinweise — the FULL set, assembled by the shared core function the desktop Auswertungen
    // view calls too (identical `agg` + `docs` ⇒ identical Hinweise; no divergent hand-built input).
    const doppelzahlung = elster ? await doppelzahlungHinweisCounts(elster.entity_id, year) : undefined;
    const forderungen = elster ? await forderungenHinweisDaten(elster.entity_id) : undefined;
    const hinweise = computeYearHinweise({
        year,
        agg,
        elster,
        docs: dmsDocs,
        doppelzahlung,
        forderungen,
        accountKeys,
        entityId: entityId ?? elster?.entity_id,
    });

    const home = buildHomeModel({
        year,
        txs: searchAccountKeys(accountKeys, {}),
        dashboard,
        accountLabels: elster?.account_labels,
        hinweise,
    });

    return {
        year,
        home,
        transactions: { year, rows, totals: agg.totals, coverage: agg.coverage, aufgabe: aufgabeRows },
        reconciliation,
        steuerkonto: steuerkontoReport(loadSteuerkontoScope(), year, accountKeys),
        euer: { aggregate: agg, kennzahlen: buildEuerKennzahlen(agg) },
        bwa: computeBwa(agg, year),
        uste: usteRes,
        gewst: gewstRes ? ({ result: gewstRes, euer: agg } as unknown) : null,
        feststellung: festRes ? ({ result: festRes, euer: agg, aufgabe: aufgabe ?? undefined } as unknown) : null,
        wizard,
        est: estRep,
        dashboard,
        hinweise,
        documents: dmsDocs,
        dmsKind: dms.kind,
    };
}
