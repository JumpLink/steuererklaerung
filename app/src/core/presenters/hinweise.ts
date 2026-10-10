/**
 * Hinweise presenter — one entity-year's hints for every frontend that is not the web year cache:
 * the desktop Auswertungen + Übersicht, the CLI `hinweise` and the MCP tools. Same assembly as the web
 * cache ({@link computeYearHinweise} over the session's shared aggregate + documents), plus the
 * „in Ordnung" step, which needs the hint as it is computed NOW to bind the decision to its finding.
 *
 * A `privat` entity has no EÜR, so it gets only the checks that need none (Kontoauszug).
 *
 * Pure TS (core + `@steuererklaerung/*` only) — no gi://, GTK/Adwaita, DOM, Hono, yargs or zod.
 */

import {
    computeYearHinweise,
    kontoauszugHinweise,
    markHinweisOk,
    ohneErledigte,
    type YearHinweis,
} from '../actions/elster/hinweise.ts';
import { doppelzahlungHinweisCounts } from '../actions/invoices/doppelzahlung.ts';
import { forderungenHinweisDaten } from '../actions/forderungen.ts';
import type { ForderungenHinweisDaten } from '../invoices/forderungen-hinweis.ts';
import { vorAbgabeHinweise } from '../elster/vor-abgabe.ts';
import type { PresenterSession } from './session.ts';
import type { EntityModel } from './workspace.ts';

export type { YearHinweis } from '../actions/elster/hinweise.ts';

export interface LoadHinweiseOptions {
    /** Reference date YYYY-MM-DD (default: today). */
    today?: string;
    /** Include the hints marked „in Ordnung", flagged `erledigt`. */
    alle?: boolean;
    /** The open claims, when the caller already loaded them (saves a second invoice-list request). */
    forderungen?: ForderungenHinweisDaten;
}

/**
 * Hints about a German return (USt, GewSt, AfA, Fristen, §13b). With the tax module off they would
 * ask the owner to prepare a filing the app no longer offers; the money and bookkeeping checks stay.
 */
const STEUER_HINWEISE = [
    'ust-',
    'kleinunternehmer',
    'frist',
    'gewst-',
    'reverse-charge-kandidat',
    'afa',
    'anlagegut-kandidat',
    'betriebsaufgabe',
];

const istSteuerHinweis = (key: string) => STEUER_HINWEISE.some((p) => key === p || key.startsWith(p));

/** Load one entity-year's Hinweise (async; may fetch Paperless through the session). */
export async function loadHinweise(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    opts: LoadHinweiseOptions = {},
): Promise<YearHinweis[]> {
    const hints = await loadAlleHinweise(session, entity, year, opts);
    return entity.capabilities.taxFiling ? hints : hints.filter((h) => !istSteuerHinweis(h.key));
}

async function loadAlleHinweise(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    opts: LoadHinweiseOptions,
): Promise<YearHinweis[]> {
    const elster = session.elster(entity);
    if (!elster) {
        const hints = kontoauszugHinweise({ year, accountKeys: entity.accountKeys, today: opts.today });
        return ohneErledigte(hints, year, entity.id, opts.alle);
    }
    const [agg, documents] = await Promise.all([session.aggregate(entity, year), session.documents(entity, year)]);
    const doppelzahlung = await doppelzahlungHinweisCounts(elster.entity_id, year);
    const forderungen = opts.forderungen ?? (await forderungenHinweisDaten(elster.entity_id, { today: opts.today }));
    // History for the USt-Abweichung across January; without it the check simply sees fewer periods.
    const vorjahr = entity.years.includes(year - 1)
        ? await session.aggregate(entity, year - 1).catch(() => undefined)
        : undefined;
    return computeYearHinweise({
        vorjahr,
        year,
        agg,
        elster,
        docs: documents.docs,
        doppelzahlung,
        forderungen,
        accountKeys: entity.accountKeys,
        entityId: entity.id,
        today: opts.today,
        alle: opts.alle,
    });
}

/**
 * The findings to clear before a USt-VA or the annual returns go out (Idee 10): the Prüfungen vor der
 * Abgabe plus the Geld-Prüfungen' warnings — what „Vor der Abgabe klären" shows.
 */
export async function loadVorAbgabeHinweise(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    opts: LoadHinweiseOptions = {},
): Promise<YearHinweis[]> {
    return vorAbgabeHinweise(await loadHinweise(session, entity, year, opts));
}

/**
 * Mark the CURRENT finding of hint `key` „in Ordnung". Recomputes the hints first, so the stored
 * fingerprint is the one the user saw; an unknown key or a hint without that action is refused.
 */
export async function markHinweisInOrdnung(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
    key: string,
    opts: { today?: string } = {},
): Promise<{ ok: true; hinweis: string; jahr: number; fingerprint: string }> {
    const hints = await loadHinweise(session, entity, year, { today: opts.today, alle: true });
    const h = hints.find((x) => x.key === key);
    if (!h) {
        const known = hints.map((x) => x.key).join(', ') || '—';
        throw new Error(`Kein Hinweis „${key}" für ${entity.name} ${year}. Vorhanden: ${known}`);
    }
    markHinweisOk(entity.id, h, year, { today: opts.today });
    return { ok: true, hinweis: h.key, jahr: year, fingerprint: h.fingerprint! };
}
