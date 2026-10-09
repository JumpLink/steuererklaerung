/**
 * Input fingerprint (S3 / the freshness + binding key for S8 filing snapshots).
 *
 * A cheap, stable, deterministic hash of EVERYTHING that feeds a tax return's figures for one
 * entity + year:
 *   (a) the scoped transactions' identity — id + amount + booking date + category + source, so any
 *       tx add / remove / edit flips the hash;
 *   (b) the persisted MANUAL owner overrides (the `classifications` decision layer) — a
 *       reclassification changes the figures without touching the raw tx, so it must flip the hash;
 *   (c) the entity config content that affects the return — the figure-relevant slice of the ELSTER
 *       config (esp. `adjustments`: AfA/§24/Privatanteil, gesellschafter/gewerbe/uste, business
 *       window, tax number, doc-scope tags) and, for a `privat` entity, the ESt config.
 *
 * Deliberately CHEAP: a direct store query (`searchAccountKeys`) + one classifications read — NO
 * document fetch, NO full aggregate build — so it can be called on view loads. It intentionally
 * skips the cwd/env-derived + non-figure config keys (output_directory, eric_home, schema_version,
 * test_mode, the current `period`, …) so the hash tracks the RETURN, not the machine or the UI
 * state. The `v1:` prefix versions the scheme: if what we hash ever changes, old snapshots read as
 * stale (correctly — they must be re-captured).
 */

import { createHash } from 'node:crypto';
import { searchAccountKeys, transactionsSummary, type UnifiedTransaction } from '@steuererklaerung/store';
import type { SyncConfig } from '../../config/index.ts';
import type { ElsterConfig } from '../../config/index.ts';
import type { EstConfig } from '../../config/index.ts';
import { defaultAccountScope, loadManifest } from '../../config/index.ts';
import { loadManualOverrides } from '../classifications.ts';
import { loadErstattungLinks } from '../erstattungen.ts';
import { loadAufteilungTeile } from '../aufteilungen.ts';

/** Bump when the set of hashed inputs changes (old fingerprints then read as stale — by design). */
const FINGERPRINT_VERSION = 1;

/** The ELSTER config keys that are NOT figure-relevant (cwd/env-derived, UI/period/deadline noise). */
const NON_FIGURE_ELSTER_KEYS = [
    'output_directory',
    'eric_home',
    'xsd_path',
    'schema_version',
    'test_mode',
    'account_labels',
    'deadline_extension_months',
    // The config's CURRENT period (quarter/month) scopes only the USt-VA and is captured in the
    // snapshot figures separately; excluding it keeps an annual form's fingerprint stable when the
    // user switches the config period.
    'period',
] as const;

/** The minimal MANUAL-override shape the fingerprint hashes (see {@link loadManualOverrides}). */
export interface FingerprintOverride {
    category: string | null;
    note?: string | null;
    decidedBy?: string | null;
}

/** The already-gathered inputs a fingerprint is computed from (pure — no I/O). */
export interface FingerprintInputs {
    year: number;
    entityId?: string;
    accountKeys: string[];
    /** The scoped transactions (only the identity fields are hashed). */
    txs: Array<Pick<UnifiedTransaction, 'id' | 'amount' | 'bookingDate' | 'category' | 'source'>>;
    /** Persisted manual overrides for the scoped tx ids, keyed by tx id. */
    overrides: Map<string, FingerprintOverride>;
    elster?: ElsterConfig;
    est?: EstConfig;
}

/** Recursively sort object keys so the JSON is canonical regardless of key insertion order. */
function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(value as Record<string, unknown>).sort()) {
            out[k] = sortKeys((value as Record<string, unknown>)[k]);
        }
        return out;
    }
    return value;
}

/** Canonical JSON string (stable key order) for hashing. */
function stableStringify(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

/** The figure-relevant slice of an ELSTER config (drop the cwd/env/non-figure keys). */
function elsterFigureSubset(elster: ElsterConfig): Record<string, unknown> {
    const drop = new Set<string>(NON_FIGURE_ELSTER_KEYS);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(elster)) {
        if (!drop.has(k)) out[k] = v;
    }
    return out;
}

/**
 * The PURE fingerprint over already-gathered inputs — the testable core. Sorts the tx + override
 * digests so store/account iteration order can never change the result.
 */
export function computeFingerprintFromInputs(inputs: FingerprintInputs): string {
    const txDigest = inputs.txs
        .map((t) => [t.id, t.amount, t.bookingDate, t.category ?? '', t.source] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const overrideDigest = [...inputs.overrides.entries()]
        .map(([id, r]) => [id, r.category ?? '', r.note ?? '', r.decidedBy ?? ''] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const canonical = stableStringify({
        v: FINGERPRINT_VERSION,
        year: inputs.year,
        entity: inputs.entityId ?? '',
        accountKeys: [...inputs.accountKeys].sort(),
        txs: txDigest,
        overrides: overrideDigest,
        elster: inputs.elster ? elsterFigureSubset(inputs.elster) : null,
        est: inputs.est ?? null,
    });
    return `v${FINGERPRINT_VERSION}:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** Scope for {@link computeInputFingerprint}. Mirrors `elster euer report` scoping. */
export interface FingerprintScope {
    year: number;
    /** Workspace entity id (gbr|jumplink|privat), for the entity marker in the hash. */
    entity?: string;
    /** Explicit account keys; when absent they are derived from the ELSTER config's entity. */
    accountKeys?: string[];
    elster?: ElsterConfig;
    est?: EstConfig;
}

/**
 * Compute the input fingerprint for an entity + year: resolve the account scope, read the year's
 * scoped transactions + their manual overrides from the store, and hash them together with the
 * config. Cheap (one store scan + one classifications read; no Paperless, no aggregate build).
 *
 * `config` is accepted for parity with the report actions (`euerReportByTransactions`,
 * `computeCrossChecks`) and to reserve room for future document-scoped inputs; the current
 * fingerprint is store-only and does not read it.
 */
export function computeInputFingerprint(config: SyncConfig, scope: FingerprintScope): string {
    const accountKeys = scope.accountKeys?.length
        ? scope.accountKeys
        : defaultAccountScope(
              loadManifest(),
              transactionsSummary().accounts.map((a) => a.accountKey),
              scope.elster,
          );
    const from = `${scope.year}-01-01`;
    const to = `${scope.year}-12-31`;
    const txs = accountKeys.length ? searchAccountKeys(accountKeys, { from, to }) : [];
    // Decouple from EuerManualOverride into the fingerprint's own override shape (a fresh Map so
    // TS Map invariance never bites, and the hash never depends on the aggregate's internal type).
    const overrides = new Map<string, FingerprintOverride>();
    for (const [id, r] of loadManualOverrides(txs.map((t) => t.id))) {
        overrides.set(id, { category: r.category, note: r.note ?? null, decidedBy: r.decidedBy ?? null });
    }
    // A linked Erstattung re-books its refund like an Umbuchung does, so it must move the fingerprint
    // too. Folded into the same map (an Umbuchung of the same booking wins, as in the aggregate).
    for (const l of loadErstattungLinks(txs.map((t) => t.id))) {
        if (l.status !== 'linked' || overrides.has(l.refundTxId)) continue;
        overrides.set(l.refundTxId, {
            category: l.category ?? '',
            note: `erstattung:${l.originalTxId}:${l.vatRate ?? 0}`,
            decidedBy: l.decidedBy ?? null,
        });
    }
    // A split wins over every other decision of its booking (as in the aggregate), so its parts replace
    // whatever this map holds for it.
    const teile = new Map<string, string[]>();
    for (const p of loadAufteilungTeile(txs.map((t) => t.id))) {
        teile.set(p.txId, [...(teile.get(p.txId) ?? []), `${p.category}:${p.amountCents ?? 'rest'}:${p.vatRate}`]);
    }
    for (const [id, parts] of teile) {
        overrides.set(id, { category: 'aufteilung', note: parts.join('|'), decidedBy: null });
    }
    return computeFingerprintFromInputs({
        year: scope.year,
        entityId: scope.entity,
        accountKeys,
        txs,
        overrides,
        elster: scope.elster,
        est: scope.est,
    });
}
