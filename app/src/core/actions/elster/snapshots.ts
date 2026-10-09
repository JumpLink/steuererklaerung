/**
 * Filing-snapshot orchestration (S8) — capture an IMMUTABLE record of a generated tax return.
 *
 * `createFilingSnapshot` generates the ELSTER XML (reusing the same per-form EDS builders the CLI
 * `generate-xml` / `validate-eric` commands use — nothing is re-emitted here), captures the
 * headline figures + the cross-check verdict + the current input fingerprint + a timestamp, and
 * inserts one append-only row (see store `filing_snapshots`). The XML/figures/fingerprint are then
 * frozen forever; `isSnapshotStale` re-computes the live fingerprint and reports whether the data
 * drifted since capture (⇒ the return must be re-snapshotted before submit).
 *
 * Store-scoped like actions/filings.ts + actions/classifications.ts (the single ledger DB next to
 * the NDJSON store). Entity → accountKeys + ELSTER/ESt config resolution mirrors `elster euer
 * report` / the cross-checks action.
 */

import {
    createSnapshot,
    getSnapshot,
    latestSnapshot,
    listSnapshots,
    markSnapshotSubmitted,
    markSnapshotSubmitting,
    markSnapshotValidated,
    markSuperseded,
    type FilingFormType,
    type FilingSnapshot,
    type LedgerDatabase,
    ledgerDbPath,
    migrate,
    openLedger,
    transactionsSummary,
} from '@steuererklaerung/store';
import { round2 } from '../../lib/money.ts';
import { loadPaperlessConfig } from '../../config/index.ts';
import { resolveWorkspaceEntities, type ElsterConfig, type EstConfig } from '../../config/index.ts';
import {
    buildUstvaEds,
    buildEuerEds,
    buildUsteEds,
    buildGewstEds,
    buildFeststellungEds,
    buildEstEds,
} from '../../elster/index.ts';
import { estReport } from './est.ts';
import { euerReportByTransactions } from './euer.ts';
import { usteReport } from './uste.ts';
import { gewstReport } from './gewst.ts';
import { feststellungReport } from './feststellung.ts';
import {
    computeCrossChecks,
    summarizeCrossChecks,
    type CrossCheckResult,
    type CrossCheckSummary,
} from './cross-checks.ts';
import { computeInputFingerprint } from './fingerprint.ts';
import { aggregateUstvaDerPeriode } from './ustva.ts';

export type { FilingFormType, FilingSnapshot, FilingSnapshotStatus } from '@steuererklaerung/store';

/** The set of form types a snapshot supports (each has an EDS XML builder). */
const FORM_TYPES: readonly FilingFormType[] = ['ustva', 'euer', 'uste', 'gewst', 'feststellung', 'est'];

/** The captured figures blob stored (as JSON) alongside the XML. */
export interface FilingSnapshotFigures {
    formType: FilingFormType;
    entityId: string;
    year: number;
    /** For USt-VA: the concrete period label from the config (e.g. '2025-Q1'). */
    period?: string;
    /** The EÜR headline totals the annual forms derive from (absent for USt-VA). */
    euer?: {
        incomeNet: number;
        outputVat: number;
        expenseNet: number;
        inputVat: number;
        profit: number;
        vatPayable: number;
    };
    /** Per-form headline Kennzahlen (form-specific keys). */
    headline: Record<string, number>;
    /** The machine cross-check verdict at capture time (readiness binding); omitted if it threw. */
    crossChecks?: { summary: CrossCheckSummary; results: CrossCheckResult[] };
}

/** Open + migrate + close the ledger around a synchronous `fn` (mirrors actions/filings.ts). */
function withLedger<T>(fn: (db: LedgerDatabase) => T): T {
    const db = openLedger(ledgerDbPath());
    try {
        migrate(db);
        return fn(db);
    } finally {
        db.close();
    }
}

function nowIso(): string {
    return new Date().toISOString();
}

/** Narrow a free-text form to a supported {@link FilingFormType} (or throw). Shared with the sign-off action. */
export function assertFormType(formType: string): FilingFormType {
    if ((FORM_TYPES as readonly string[]).includes(formType)) return formType as FilingFormType;
    throw new Error(`Unbekannter Formulartyp '${formType}'. Erlaubt: ${FORM_TYPES.join(', ')}.`);
}

/** An entity resolved to its store accounts + loaded ELSTER/ESt configs (or throw on unknown id). */
export interface ResolvedScope {
    entityId: string;
    name: string;
    accountKeys: string[];
    elster?: ElsterConfig;
    est?: EstConfig;
}

/**
 * Resolve a workspace entity id to its account scope + ELSTER/ESt config (mirrors umsatz-aufstellung).
 * Exported so the sign-off action reuses the exact same scoping (no duplicated resolution logic).
 */
export function resolveEntityScope(entityId: string): ResolvedScope {
    const storeKeys = transactionsSummary().accounts.map((a) => a.accountKey);
    const entities = resolveWorkspaceEntities(storeKeys);
    const entity = entities.find((e) => e.id === entityId);
    if (!entity) {
        const known = entities.map((e) => e.id).join(', ');
        throw new Error(`Unbekannte Entität '${entityId}'. Bekannt: ${known || '(keine)'}.`);
    }
    return { entityId, name: entity.name, accountKeys: entity.accountKeys, elster: entity.elster, est: entity.est };
}

/** ELSTER-period label for a year (USt-VA snapshot): '2025-Q1' | '2025-03' | '2025'. */
/** The caller's period override, if any — a quarter wins over a month, and neither is a no-op. */
function pickPeriod(opts: { quarter?: number; month?: number }): { quarter?: number; month?: number } {
    if (opts.quarter != null) return { quarter: opts.quarter, month: undefined };
    if (opts.month != null) return { month: opts.month, quarter: undefined };
    return {};
}

function periodLabel(period: ElsterConfig['period'], year: number): string {
    if (period.quarter != null) return `${year}-Q${period.quarter}`;
    if (period.month != null) return `${year}-${String(period.month).padStart(2, '0')}`;
    return String(year);
}

/**
 * Create an IMMUTABLE snapshot of one form for one entity + year: generate the XML (reuse the EDS
 * builder), capture the figures + cross-check verdict + fingerprint + timestamp, insert append-only.
 *
 * Async because the annual forms build the tx-driven EÜR aggregate (and USt-VA fetches its
 * Paperless documents) — exactly like the corresponding `generate-xml` CLI path. USt-VA uses the
 * entity's ELSTER-config period (its `year` overridden to the requested year), since a USt-VA maps
 * to a quarter/month rather than a whole year.
 */
export async function createFilingSnapshot(
    entity: string,
    year: number,
    formType: string,
    opts: { quarter?: number; month?: number } = {},
): Promise<FilingSnapshot> {
    const form = assertFormType(formType);
    const config = loadPaperlessConfig();
    const scope = resolveEntityScope(entity);
    const elster = scope.elster;

    let xml: string;
    const figures: FilingSnapshotFigures = { formType: form, entityId: entity, year, headline: {} };

    if (form === 'est') {
        // Private Einkommensteuer: NO ELSTER config — the snapshot builds from the est config +
        // estReport (identical to `elster est generate-xml`). No EÜR aggregate, no business
        // cross-checks; the herstellerId is carried by the est config (config.hersteller_id).
        const est = scope.est;
        if (!est) {
            throw new Error(`Entität '${entity}' hat keine ESt-Config (privat) — kein est-Snapshot möglich.`);
        }
        const report = estReport(est, year, { accountKeys: scope.accountKeys, detail: true });
        xml = buildEstEds(est, report.inputs, report.aggregate);
        figures.headline = {
            zvE: report.result.zvE,
            festzusetzendeESt: report.result.festzusetzendeESt,
            erstattung: report.result.erstattung,
        };
    } else if (!elster) {
        throw new Error(`Entität '${entity}' hat keine ELSTER-Config — kein ${form}-Snapshot möglich.`);
    } else if (form === 'ustva') {
        // USt-VA is Paperless-document-driven. The period comes from the CALLER when given — the
        // config's own period is a default, and a GUI that lets someone pick a quarter must be able
        // to say which one rather than editing the manifest to file for a different one.
        const period = { ...elster.period, year, ...pickPeriod(opts) };
        // `schema_version` moves WITH the year, or the XML contradicts itself: the namespace
        // (`…/ustva/v<schema_version>`) and `<Jahr>` come from the same config, so a 2026 snapshot
        // taken against a manifest still on 2025 emitted `ustva/v2025` alongside `<Jahr>2026` —
        // ERiC refuses that with "Das Jahr muss dem Veranlagungszeitraum entsprechen". The direct
        // CLI commands already sync it in `parseElsterArgs`; the snapshot path did not, so the two
        // routes disagreed about the very same quarter.
        const cfg: ElsterConfig = { ...elster, period, schema_version: year };
        const result = await aggregateUstvaDerPeriode(cfg);
        const agg = result.aggregate;
        xml = buildUstvaEds(agg, cfg);
        const zahllast = round2((agg.net_19 * 19) / 100 + (agg.net_7 * 7) / 100 - agg.vat_in);
        figures.period = periodLabel(cfg.period, year);
        figures.headline = { net_19: agg.net_19, net_7: agg.net_7, vat_in: agg.vat_in, zahllast };
    } else {
        // The annual forms all derive from ONE tx-driven EÜR aggregate — build it once and thread it.
        const agg = await euerReportByTransactions(config, year, { accountKeys: scope.accountKeys, elster });
        figures.euer = {
            incomeNet: agg.totals.incomeNet,
            outputVat: agg.totals.outputVat,
            expenseNet: agg.totals.expenseNet,
            inputVat: agg.totals.inputVat,
            profit: agg.totals.profit,
            vatPayable: agg.totals.vatPayable,
        };
        if (!elster.betrieb) {
            throw new Error(
                `ELSTER-Config der Entität '${entity}' hat keinen \`betrieb\`-Block — ${form}-XML nicht baubar.`,
            );
        }
        switch (form) {
            case 'euer': {
                xml = buildEuerEds(agg, elster, elster.betrieb);
                figures.headline = { profit: agg.totals.profit, vatPayable: agg.totals.vatPayable };
                break;
            }
            case 'uste': {
                const u = await usteReport(config, elster, year, { accountKeys: scope.accountKeys, agg });
                xml = buildUsteEds(u, elster, elster.betrieb);
                figures.headline = {
                    net_19: u.net_19,
                    net_7: u.net_7,
                    vatOut: u.vat_out,
                    vatIn: u.vat_in,
                    vatPayable: u.vatPayable,
                    prepaidVat: u.prepaidVat,
                    closingBalance: u.closingBalance,
                };
                break;
            }
            case 'gewst': {
                const g = await gewstReport(config, elster, year, { accountKeys: scope.accountKeys, agg });
                xml = buildGewstEds(g.result, elster, elster.betrieb, year);
                figures.headline = {
                    gewerbeertrag: g.result.gewerbeertrag,
                    messbetrag: g.result.messbetrag,
                    gewerbesteuer: g.result.gewerbesteuer,
                };
                break;
            }
            case 'feststellung': {
                const f = await feststellungReport(config, elster, year, { accountKeys: scope.accountKeys, agg });
                xml = buildFeststellungEds(f.result, elster, elster.betrieb);
                figures.headline = {
                    totalProfit: f.result.totalProfit,
                    einkuenfteGesamt: f.result.einkuenfteGesamt,
                    aufgabegewinn: f.result.aufgabegewinn,
                };
                break;
            }
            default:
                // 'ustva' is handled in the branch above; this keeps the switch total for TS.
                throw new Error(`Unerwarteter Formulartyp '${form}' im Jahres-Zweig.`);
        }

        // Bind the readiness verdict at capture time — reuse the single EÜR aggregate (no re-fetch).
        try {
            const results = await computeCrossChecks(config, {
                entity,
                year,
                accountKeys: scope.accountKeys,
                elster,
                agg,
            });
            figures.crossChecks = { summary: summarizeCrossChecks(results), results };
        } catch {
            // Cross-checks are advisory context on the snapshot; a failure must not block the capture.
        }
    }

    const fingerprint = computeInputFingerprint(config, {
        entity,
        year,
        accountKeys: scope.accountKeys,
        elster,
        est: scope.est,
    });

    // `period` is the SCOPE the snapshot is filed for, and only a periodic form has one: without it,
    // capturing Q1 and then Q2 leaves two rows that "the latest ustva snapshot" cannot tell apart.
    const period = form === 'ustva' ? (figures.period ?? null) : null;
    return withLedger((db) =>
        createSnapshot(db, { entityId: entity, year, formType: form, period, fingerprint, xml, figures }, nowIso()),
    );
}

/** One snapshot by id, or null. */
export function getFilingSnapshot(id: string): FilingSnapshot | null {
    return withLedger((db) => getSnapshot(db, id));
}

/** Snapshots for an entity + year (newest first), optionally narrowed to one form type. */
export function listFilingSnapshots(entity: string, year: number, formType?: string): FilingSnapshot[] {
    return withLedger((db) => listSnapshots(db, entity, year, formType));
}

/**
 * The most recent snapshot for an entity/year/form, or null.
 *
 * `period` narrows a PERIODIC form (USt-VA) to one quarter/month. Omitting it keeps the old
 * behaviour — right for the annual forms, whose rows all carry a null period.
 */
export function latestFilingSnapshot(
    entity: string,
    year: number,
    formType: string,
    period?: string | null,
): FilingSnapshot | null {
    return withLedger((db) => latestSnapshot(db, entity, year, formType, period));
}

/**
 * Whether a snapshot has DRIFTED since capture: recompute the live input fingerprint for its
 * entity + year and compare it to the frozen one. `false` right after capture; `true` once any
 * scoped transaction / adjustment / manual override changed → the return must be re-snapshotted
 * before it can be submitted.
 */
export function isSnapshotStale(snapshotOrId: FilingSnapshot | string): boolean {
    const snap = typeof snapshotOrId === 'string' ? getFilingSnapshot(snapshotOrId) : snapshotOrId;
    if (!snap) throw new Error(`Kein Snapshot mit id '${String(snapshotOrId)}'.`);
    const scope = resolveEntityScope(snap.entityId);
    const current = computeInputFingerprint(loadPaperlessConfig(), {
        entity: snap.entityId,
        year: snap.year,
        accountKeys: scope.accountKeys,
        elster: scope.elster,
        est: scope.est,
    });
    return snap.fingerprint !== current;
}

/** Mark a snapshot `validated` (local ERiC validation passed). Returns the updated snapshot. */
export function markFilingSnapshotValidated(id: string): FilingSnapshot | null {
    return withLedger((db) => markSnapshotValidated(db, id));
}

/** Mark a snapshot `submitting` (live_pending latch set before a transmission call). */
export function markFilingSnapshotSubmitting(id: string): FilingSnapshot | null {
    return withLedger((db) => markSnapshotSubmitting(db, id));
}

/**
 * Mark a snapshot `submitted` and record the Transferticket + server protocol, plus how it was
 * submitted (`source`: 'eric' | 'web-form') and the actual submission date (`submittedAt`).
 */
export function markFilingSnapshotSubmitted(
    id: string,
    opts: {
        transferTicket?: string | null;
        serverProtocol?: string | null;
        source?: string | null;
        submittedAt?: string | null;
    } = {},
): FilingSnapshot | null {
    return withLedger((db) => markSnapshotSubmitted(db, id, opts));
}

/** Mark a snapshot `superseded` (a newer snapshot replaced it). */
export function markFilingSnapshotSuperseded(id: string): FilingSnapshot | null {
    return withLedger((db) => markSuperseded(db, id));
}
