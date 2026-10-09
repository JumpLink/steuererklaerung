/**
 * Steuer presenter — the ONE tax-report read for an entity-year, shared by every frontend.
 *
 * It absorbs the desktop `data/{euer,steuer,steuererklaerung,steuerkonto}.ts` loaders: the EÜR aggregate
 * + Kennzahlen ({@link loadEuer}), the annual USt-Jahreserklärung / Gewerbesteuer / GbR-Feststellung
 * ({@link loadUste} / {@link loadGewst} / {@link loadFeststellung}), the tax-payment overview
 * ({@link loadSteuerkonto}), the figure Herleitung ({@link loadFigureExplanation}), the
 * Steuererklärungs-Assistent plan + machine cross-checks ({@link loadTaxReturnPlan} /
 * {@link loadCrossChecks}), and the four review-datasheet PDFs.
 *
 * Every report DERIVES from the ONE shared, memoized EÜR aggregate (`session.aggregate`) via the SAME
 * core action the CLI + web already call (`agg` is threaded in, so there is no extra Paperless fetch) —
 * this module does NOT reimplement any tax maths, it only routes to those actions.
 *
 * Pure TS (core + `@steuererklaerung/*` only) — no gi://, GTK/Adwaita, DOM, Hono, yargs or zod; runs on GJS
 * in every frontend. (`@steuererklaerung/invoice-pdf` renders on the GJS runtime; `pdfRenderingAvailable()`
 * guards the non-GJS case.)
 */

import type { ElsterConfig } from '../config/index.ts';
import type { SyncConfig } from '../config/index.ts';
import { buildEuerKennzahlen, type EuerKennzahl } from '../actions/elster/euer.ts';
import { usteReport } from '../actions/elster/uste.ts';
import { gewstReport, type GewstReport } from '../actions/elster/gewst.ts';
import { feststellungReport, type FeststellungReport } from '../actions/elster/feststellung.ts';
import { steuerkontoReport, steuerkontoScope, type SteuerkontoReport } from '../actions/elster/steuerkonto.ts';
import {
    parseFigureRef,
    resolveEuerFigure,
    type FigureExplanation,
    type FigureRef,
} from '../actions/elster/explain.ts';
import { buildTaxReturnPlan, buildEstPlan, type TaxReturnPlan } from '../actions/elster/wizard.ts';
import { computeCrossChecks, type CrossCheckResult } from '../actions/elster/cross-checks.ts';
import {
    euerToSteuerblatt,
    usteToSteuerblatt,
    gewstToSteuerblatt,
    feststellungToSteuerblatt,
    estToSteuerblatt,
} from '../actions/elster/steuerblatt-pdf.ts';
import { estReport } from '../actions/elster/est.ts';
import { pdfRenderingAvailable, renderSteuerblattPdf, type SteuerblattModel } from '@steuererklaerung/invoice-pdf';
import type { EuerTxAggregate } from '../elster/euer-transactions.ts';
import type { UsteAggregate } from '../elster/uste-aggregate.ts';
import type { PresenterSession } from './session.ts';
import type { EntityModel } from './workspace.ts';

export type { SteuerkontoReport } from '../actions/elster/steuerkonto.ts';

/** The rendered-bytes result the desktop's Save-As dialog + the web PDF routes both consume. */
export interface PdfResult {
    filename: string;
    bytes: Uint8Array;
}

/** EÜR aggregate + its Anlage-EÜR Kennzahlen — the shape the Steuer view renders. */
export interface EuerData {
    aggregate: EuerTxAggregate;
    kennzahlen: EuerKennzahl[];
}

/** Compute the EÜR aggregate + Kennzahlen for one entity-year (async; may fetch Paperless), via the
 * shared session memo — the EÜR-family views (Steuer · BWA · Einblicke · Offene Belege) share one build. */
export async function loadEuer(session: PresenterSession, entity: EntityModel, year: number): Promise<EuerData> {
    const aggregate = await session.aggregate(entity, year);
    return { aggregate, kennzahlen: buildEuerKennzahlen(aggregate) };
}

/**
 * Resolve one tax figure's Herleitung (drill-down): the structured value, formula, child figures and the
 * contributing transactions with their provenance. Reuses the SAME cached EÜR aggregate the Steuer view
 * rendered from and applies the PURE resolver — so the leaf rows always sum to exactly the figure shown,
 * with no second Paperless fetch.
 */
export async function loadFigureExplanation(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    ref: FigureRef | string,
): Promise<FigureExplanation> {
    const aggregate = await session.aggregate(entity, year);
    const parsed = typeof ref === 'string' ? parseFigureRef(ref, { year }) : ref;
    return resolveEuerFigure(aggregate, parsed, { entity: entity.id });
}

interface SteuerContext {
    config: SyncConfig;
    elster: ElsterConfig;
    agg: EuerTxAggregate;
}

/** The shared cached EÜR aggregate + the entity's ELSTER config (throws without one) — the seam the
 * annual USt/GewSt/Feststellung reports build on. */
async function steuerContext(session: PresenterSession, entity: EntityModel, year: number): Promise<SteuerContext> {
    if (!entity.elster) throw new Error('Diese Entität hat keine ELSTER-Config.');
    const agg = await session.aggregate(entity, year);
    return { config: session.ctx.config, elster: entity.elster, agg };
}

/** USt-Jahreserklärung figures (Zahllast, Abschluss, §13b) for the entity-year. */
export async function loadUste(session: PresenterSession, entity: EntityModel, year: number): Promise<UsteAggregate> {
    const { config, elster, agg } = await steuerContext(session, entity, year);
    return usteReport(config, elster, year, { accountKeys: entity.accountKeys, agg, entityId: entity.id });
}

/** Gewerbesteuer Messbetragsermittlung for the entity-year. */
export async function loadGewst(session: PresenterSession, entity: EntityModel, year: number): Promise<GewstReport> {
    const { config, elster, agg } = await steuerContext(session, entity, year);
    return gewstReport(config, elster, year, { accountKeys: entity.accountKeys, agg });
}

/** GbR Feststellung (profit allocation) for the entity-year. */
export async function loadFeststellung(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
): Promise<FeststellungReport> {
    const { config, elster, agg } = await steuerContext(session, entity, year);
    return feststellungReport(config, elster, year, { accountKeys: entity.accountKeys, agg });
}

/** The tax-payment overview (Steuerkonto) — pure store, no outbound: classifies the entity's imported
 * transactions by regex. */
export function loadSteuerkonto(session: PresenterSession, entity: EntityModel, year: number): SteuerkontoReport {
    return steuerkontoReport(steuerkontoScope(session.ctx.manifest), year, entity.accountKeys);
}

/**
 * Build the Steuererklärungs-Assistent plan for the entity-year. A `privat` entity (est config) gets the
 * private-ESt plan (store-only); a business entity gets the EÜR/USt/GewSt/Feststellung plan, reusing the
 * cached EÜR aggregate. Both render as the same {@link TaxReturnPlan}.
 */
export async function loadTaxReturnPlan(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
): Promise<TaxReturnPlan> {
    if (entity.est) {
        return buildEstPlan(entity.est, year, { accountKeys: entity.accountKeys });
    }
    if (!entity.elster) throw new Error('Diese Entität hat keine ELSTER- oder ESt-Config.');
    const agg = await session.aggregate(entity, year);
    return buildTaxReturnPlan(session.ctx.config, entity.elster, year, { accountKeys: entity.accountKeys, agg });
}

/**
 * Machine-evaluated cross-checks (Gegenprüfung) — reconcile the entity's tax reports against each other
 * before filing. Scoped exactly like {@link loadTaxReturnPlan}, threaded the SAME cached EÜR aggregate.
 * Report-reconciliation only applies to a business entity; a `privat`/ESt entity gets `[]`.
 */
export async function loadCrossChecks(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
): Promise<CrossCheckResult[]> {
    if (entity.est || !entity.elster) return [];
    const agg = await session.aggregate(entity, year);
    return computeCrossChecks(session.ctx.config, {
        entity: entity.id,
        year,
        accountKeys: entity.accountKeys,
        elster: entity.elster,
        agg,
    });
}

/** Render a datasheet model to PDF bytes (GJS runtime — cairo/Pango). */
function renderDatasheet(filename: string, model: SteuerblattModel): Promise<PdfResult> {
    if (!pdfRenderingAvailable()) throw new Error('PDF-Rendering benötigt die GJS-Laufzeit (Cairo/Pango).');
    return renderSteuerblattPdf(model).then((bytes) => ({ filename, bytes }));
}

/** EÜR review datasheet (Prüf-Datenblatt) → PDF bytes — the same the CLI `--pdf` and web `/api/euer/pdf`
 * produce. Reuses the shared aggregate cache; throws when the entity has no ELSTER config. */
export async function loadEuerPdf(session: PresenterSession, entity: EntityModel, year: number): Promise<PdfResult> {
    if (!entity.elster) throw new Error('Diese Entität hat keine ELSTER-Config.');
    if (!pdfRenderingAvailable()) throw new Error('PDF-Rendering benötigt die GJS-Laufzeit (Cairo/Pango).');
    const elster = entity.elster;
    const aggregate = await session.aggregate(entity, year);
    const bytes = await renderSteuerblattPdf(euerToSteuerblatt(aggregate, elster));
    return { filename: `euer-${entity.id}-${year}-pruefblatt.pdf`, bytes };
}

/** USt-Jahreserklärung → Prüf-Datenblatt PDF bytes. */
export async function loadUstePdf(session: PresenterSession, entity: EntityModel, year: number): Promise<PdfResult> {
    const { config, elster, agg } = await steuerContext(session, entity, year);
    const u = await usteReport(config, elster, year, { accountKeys: entity.accountKeys, agg, entityId: entity.id });
    return renderDatasheet(`uste-${entity.id}-${year}-pruefblatt.pdf`, usteToSteuerblatt(u, elster));
}

/** Gewerbesteuer → Prüf-Datenblatt PDF bytes. */
export async function loadGewstPdf(session: PresenterSession, entity: EntityModel, year: number): Promise<PdfResult> {
    const { config, elster, agg } = await steuerContext(session, entity, year);
    const report = await gewstReport(config, elster, year, { accountKeys: entity.accountKeys, agg });
    return renderDatasheet(`gewst-${entity.id}-${year}-pruefblatt.pdf`, gewstToSteuerblatt(report, elster, year));
}

/** Feststellung → Prüf-Datenblatt PDF bytes. */
export async function loadFeststellungPdf(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
): Promise<PdfResult> {
    const { config, elster, agg } = await steuerContext(session, entity, year);
    const report = await feststellungReport(config, elster, year, { accountKeys: entity.accountKeys, agg });
    return renderDatasheet(
        `feststellung-${entity.id}-${year}-pruefblatt.pdf`,
        feststellungToSteuerblatt(report, elster),
    );
}

/** Einkommensteuererklärung (privat) → Prüf-Datenblatt PDF bytes. */
export async function loadEstPdf(session: PresenterSession, entity: EntityModel, year: number): Promise<PdfResult> {
    const est = entity.est;
    if (!est) throw new Error('Diese Entität hat keine ESt-Config (privat).');
    if (!pdfRenderingAvailable()) throw new Error('PDF-Rendering benötigt die GJS-Laufzeit (Cairo/Pango).');
    const report = estReport(est, year, { accountKeys: entity.accountKeys, detail: true });
    return renderDatasheet(`est-${entity.id}-${year}-pruefblatt.pdf`, estToSteuerblatt(report, est));
}
