/**
 * Home presenter — the Übersicht dashboard model for one entity-year, shared by every frontend.
 *
 * Absorbs the desktop `data/home.ts`: the KPIs/series/categories/liquidity come from the entity's
 * transactions (a synchronous store read), the tax-forecast + "Als Nächstes" deadlines from the
 * Steuer-Dashboard — reusing the {@link loadUste} / {@link loadGewst} / {@link loadFeststellung}
 * loaders from the steuer presenter (one shared EÜR aggregate, no extra Paperless fetch).
 *
 * This is deliberately NOT the same assembly the web year-snapshot uses: the desktop Übersicht passes
 * `euerGewinn: null` and no account labels, so it is kept as its own presenter rather than unified with
 * the snapshot's home build (which threads the profit + labels).
 *
 * Pure TS (core + `@steuererklaerung/*` only) — no gi://, GTK/Adwaita, DOM, Hono, yargs or zod.
 */

import { searchAccountKeys } from '@steuererklaerung/store';
import { computeSteuerDashboard, type SteuerDashboard } from '../elster/fristen.ts';
import { buildHomeModel, type HomeModel } from '../elster/home.ts';
import { estReport } from '../actions/elster/est.ts';
import { listDoppelzahlungVerdacht } from '../actions/invoices/doppelzahlung.ts';
import { forderungenHinweisDaten, zaehleUeberfaellige } from '../actions/forderungen.ts';
import { loadHinweise } from './hinweise.ts';
import { countZuPruefen } from './zu-pruefen.ts';
import { countErstattungenOffen } from './erstattungen.ts';
import { countLaufendeKostenOffen } from './laufende-kosten.ts';
import { loadUste, loadGewst, loadFeststellung } from './steuer.ts';
import type { PresenterSession } from './session.ts';
import type { EntityModel } from './workspace.ts';

type StoreTxs = ReturnType<typeof searchAccountKeys>;

/** The private-ESt input for the dashboard: presence surfaces the Einkommensteuererklärung Frist;
 *  the estimate is the KPI figure, or null when it can't be computed (e.g. an unsourced year). */
function estInput(entity: EntityModel, year: number, txs: StoreTxs): { erstattung: number | null } | null {
    if (!entity.hasEst || !entity.est) return null;
    try {
        return { erstattung: estReport(entity.est, year, { txs }).result.erstattung };
    } catch (err) {
        // Deadline still matters even if the estimate fails — surface the Frist without an amount.
        console.error(`[home] ESt-Schätzung ${entity.id} ${year}: ${err instanceof Error ? err.message : err}`);
        return { erstattung: null };
    }
}

export type { HomeModel } from '../elster/home.ts';

/** Assemble the Steuer-Dashboard (tax forecast + deadlines) — mirrors src/core/presenters/year-snapshot.ts.
 * Null without ELSTER. `gewst`/`feststellung` don't apply to every entity — a loader that opts out tolerated. */
async function loadDashboard(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    txs: StoreTxs,
): Promise<SteuerDashboard | null> {
    const est = estInput(entity, year, txs);
    // A privat entity has an `est` config but no ELSTER — surface its ESt Frist + estimate alone.
    if (!entity.hasElster || !entity.elster) {
        return est ? computeSteuerDashboard({ year, est }) : null;
    }
    const elster = entity.elster;
    const uste = await loadUste(session, entity, year).catch(() => null);
    const gewst = await loadGewst(session, entity, year).catch(() => null);
    const fest = await loadFeststellung(session, entity, year).catch(() => null);
    return computeSteuerDashboard({
        year,
        deadlineExtensionMonths: elster.deadline_extension_months,
        uste: uste
            ? { vatPayable: uste.vatPayable, closingBalance: uste.closingBalance, prepaidVat: uste.prepaidVat }
            : null,
        gewst: gewst ? { messbetrag: gewst.result.messbetrag, gewerbesteuer: gewst.result.gewerbesteuer } : null,
        feststellung: fest
            ? {
                  einkuenfteGesamt: fest.result.einkuenfteGesamt,
                  partner: fest.result.allocations.map((a) => ({
                      name: a.gesellschafter.name,
                      anteil: a.gesamtAnteil,
                  })),
              }
            : null,
        euerGewinn: null,
        est,
    });
}

/** Load the Übersicht model for one entity-year (async; may fetch Paperless via the dashboard). */
export async function loadHome(session: PresenterSession, entity: EntityModel, year: number): Promise<HomeModel> {
    const txs = searchAccountKeys(entity.accountKeys, {});
    const dashboard = await loadDashboard(session, entity, year, txs);
    // Fail-soft: an unreadable invoice back-end / store shows no task instead of breaking the Übersicht.
    const doppelzahlungVerdacht = await listDoppelzahlungVerdacht(entity.id, { year }).catch(() => []);
    const forderungen = await forderungenHinweisDaten(entity.id);
    const hinweise = await loadHinweise(session, entity, year, { forderungen }).catch((err: unknown) => {
        console.error(`[home] Hinweise ${entity.id} ${year}: ${err instanceof Error ? err.message : err}`);
        return [];
    });
    const zuPruefen = await countZuPruefen(session, entity, year, { ohneErstattungen: true }).catch((err: unknown) => {
        console.error(`[home] Zu prüfen ${entity.id} ${year}: ${err instanceof Error ? err.message : err}`);
        return 0;
    });
    const erstattungenOffen = await countErstattungenOffen(session, entity, year).catch((err: unknown) => {
        console.error(`[home] Erstattungen ${entity.id} ${year}: ${err instanceof Error ? err.message : err}`);
        return 0;
    });
    let laufendeKostenOffen = 0;
    try {
        laufendeKostenOffen = countLaufendeKostenOffen(session, entity);
    } catch (err) {
        console.error(`[home] Laufende Kosten ${entity.id}: ${err instanceof Error ? err.message : err}`);
    }
    return buildHomeModel({
        year,
        txs,
        dashboard,
        doppelzahlungVerdacht,
        hinweise,
        zuPruefen,
        laufendeKostenOffen,
        erstattungenOffen,
        forderungenUeberfaellig: zaehleUeberfaellige(forderungen),
    });
}
