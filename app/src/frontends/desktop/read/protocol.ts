/**
 * What crosses the thread boundary between the window and the read worker.
 *
 * Plain data only: results are the same JSON-shaped models the web API serves, and a failure is a
 * {@link SerializedError} rather than a thrown value. Comlink would carry an `Error` across as
 * name + message + stack and drop everything else, so `ConfigError.detail`, `PaperlessSetupError.fields`
 * and the class itself (which `remedyFor` in views/util.ts tests with `instanceof`) would be lost.
 *
 * Pure TS — no gi://, so the tests and the Node build use it unchanged.
 */

import {
    ApiError,
    ConfigError,
    DmsUnsupportedError,
    ManifestMissingError,
    PaperlessSetupError,
    type ErrorDetail,
} from '../../../core/lib/errors.ts';
import type { HomeModel } from '../../../core/elster/home.ts';
import type { FreiVerfuegbarModel } from '../../../core/elster/frei-verfuegbar.ts';
import type { AuswertungenData } from '../data/auswertungen.ts';
import type { EntityModel } from '../../../core/presenters/workspace.ts';
import type { EnrichedTxData } from '../../../core/presenters/buchungen.ts';
import type { ProjektAnsicht } from '../../../core/presenters/projekt.ts';
import type { EuerData } from '../../../core/presenters/steuer.ts';
import type { UsteAggregate } from '../../../core/elster/uste-aggregate.ts';
import type { GewstReport } from '../../../core/actions/elster/gewst.ts';
import type { FeststellungReport } from '../../../core/actions/elster/feststellung.ts';
import type { TaxReturnPlan } from '../../../core/actions/elster/wizard.ts';
import type { CrossCheckResult } from '../../../core/actions/elster/cross-checks.ts';
import type { FigureExplanation, FigureRef } from '../../../core/actions/elster/explain.ts';
import type { DocumentsResult } from '../../../core/presenters/belege.ts';
import type { SubmissionOverview, SubmissionTarget } from '../../../core/actions/elster/submission-overview.ts';
import type { YearHinweis } from '../../../core/actions/elster/hinweise.ts';

export interface SerializedError {
    name: string;
    message: string;
    detail?: ErrorDetail;
    fields?: string[];
    capability?: string;
    dmsType?: string;
    configPath?: string;
    service?: string;
    statusCode?: number;
    body?: string;
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: SerializedError };

/** The Transaktionen page: the bookings plus, for a business entity, the project of each. */
export interface TransaktionenData {
    data: EnrichedTxData;
    /** Null for a privat entity, or when the project view failed (an extra that must not hide the bookings). */
    projekte: ProjektAnsicht | null;
    /** Why `projekte` is null for a business entity, for the log; undefined otherwise. */
    projekteFehler?: string;
}

/** The four tax reports the Steuer page shows; the last three are null when they don't apply. */
export interface SteuerData {
    euer: EuerData;
    uste: UsteAggregate | null;
    gewst: GewstReport | null;
    fest: FeststellungReport | null;
}

/** The Steuererklärung page: the plan and the machine cross-checks derived from the same aggregate. */
export interface SteuererklaerungData {
    plan: TaxReturnPlan;
    checks: CrossCheckResult[];
}

/** The Absenden section: the per-form filing state plus what to clear before filing. */
export interface AbsendenData {
    overview: SubmissionOverview;
    warnings: string[];
    hinweise: YearHinweis[];
}

/** The worker's whole API, exposed through Comlink. Every read is a plain function of its arguments. */
export interface ReadApi {
    home(entity: EntityModel, year: number): Promise<Reply<HomeModel>>;
    freiVerfuegbar(entity: EntityModel, year: number): Promise<Reply<FreiVerfuegbarModel>>;
    auswertungen(entity: EntityModel, year: number): Promise<Reply<AuswertungenData>>;
    transaktionen(entity: EntityModel, year: number): Promise<Reply<TransaktionenData>>;
    steuer(entity: EntityModel, year: number): Promise<Reply<SteuerData>>;
    steuererklaerung(entity: EntityModel, year: number): Promise<Reply<SteuererklaerungData>>;
    absenden(entity: EntityModel, year: number, targets: SubmissionTarget[]): Promise<Reply<AbsendenData>>;
    figureExplanation(entity: EntityModel, year: number, ref: FigureRef | string): Promise<Reply<FigureExplanation>>;
    euerCategories(entity: EntityModel, year: number): Promise<Reply<string[]>>;
    enrichedTransactions(entity: EntityModel, year: number): Promise<Reply<EnrichedTxData>>;
    documents(entity: EntityModel, year: number): Promise<Reply<DocumentsResult>>;
    /** Drop the worker session's memos after a write on the main thread (see PresenterSession.invalidate). */
    invalidate(entityId?: string, year?: number): Promise<void>;
    /** Rebuild one entity's DMS provider after a DMS switch in the settings. */
    reloadDms(entityId: string): Promise<void>;
    ping(): Promise<'pong'>;
}

/** Turn a thrown value into something that survives a structured clone. */
export function serializeError(err: unknown): SerializedError {
    if (!(err instanceof Error)) return { name: 'Error', message: String(err) };
    const e = err as Error & Partial<Omit<SerializedError, 'name' | 'message'>>;
    const out: SerializedError = { name: e.name, message: e.message };
    if (e.detail !== undefined) out.detail = e.detail;
    if (e.fields !== undefined) out.fields = [...e.fields];
    if (e.capability !== undefined) out.capability = e.capability;
    if (e.dmsType !== undefined) out.dmsType = e.dmsType;
    if (e.configPath !== undefined) out.configPath = e.configPath;
    if (e.service !== undefined) out.service = e.service;
    if (e.statusCode !== undefined) out.statusCode = e.statusCode;
    if (e.body !== undefined) out.body = e.body;
    return out;
}

/** Rebuild the error class the main thread's `instanceof` checks expect. Unknown names become a plain Error. */
export function rehydrateError(s: SerializedError): Error {
    switch (s.name) {
        case 'ManifestMissingError':
            return new ManifestMissingError(s.message, s.configPath, s.detail);
        case 'PaperlessSetupError': {
            const e = new PaperlessSetupError(s.message, s.fields ?? []);
            return withDetail(e, s);
        }
        case 'DmsUnsupportedError': {
            const e = new DmsUnsupportedError(s.capability ?? '', s.dmsType ?? '', s.message);
            return withDetail(e, s);
        }
        case 'ConfigError':
            return new ConfigError(s.message, s.configPath, s.detail);
        case 'ApiError':
            return new ApiError(s.service ?? '', s.statusCode ?? 0, s.body ?? '', s.message);
        default: {
            const e = new Error(s.message);
            if (s.name) e.name = s.name;
            if (s.detail) (e as Error & { detail?: ErrorDetail }).detail = s.detail;
            return e;
        }
    }
}

function withDetail<E extends ConfigError>(e: E, s: SerializedError): E {
    if (s.detail) (e as { detail?: ErrorDetail }).detail = s.detail;
    if (s.configPath) (e as { configPath?: string }).configPath = s.configPath;
    return e;
}

/** Run a read and fold its outcome into a {@link Reply} — a thrown error must not go through Comlink raw. */
export async function guard<T>(run: () => Promise<T>): Promise<Reply<T>> {
    try {
        return { ok: true, value: await run() };
    } catch (err) {
        return { ok: false, error: serializeError(err) };
    }
}
