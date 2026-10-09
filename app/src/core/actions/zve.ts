/**
 * zvE — the **zu versteuernde Einkommen** per Veranlagungsjahr, as a queryable value WITH ITS PROVENANCE.
 *
 * Why this exists: the zvE of a given year is what income-dependent programmes ask for (a
 * Baufinanzierung, a subsidy with an income cap, …). Until now that number lived only inside a
 * Bescheid PDF and got read by hand — in one real case an income limit was therefore checked for
 * months against the wrong threshold and a bonus was missed. So the value becomes a recorded,
 * queryable figure that always carries WHERE IT CAME FROM.
 *
 * Two sources, never conflated:
 *   • `bescheid`   — read off the Einkommensteuerbescheid and recorded here (store table
 *                    `tax_assessments`), with a reference to the document it came from. Binding.
 *   • `schaetzung` — derived from this app's own ESt calculation (`elster/est-berechnung.ts`).
 *                    An ESTIMATE. Never returned unless the caller explicitly asks for the
 *                    fallback, so no consumer can receive one by accident and treat it as assessed.
 *
 * **Scope boundary — deliberately narrow.** This module answers exactly one question: "what was the
 * zvE of year X, and where does that number come from?". Averaging two years, family surcharges and
 * the tier logic of any funding programme are *Förderrecht* and belong to the consuming project, not
 * here. Keep the interface this thin.
 *
 * Kernel-first: every function is a plain call with serializable arguments and a serializable
 * result — no CLI state, no yargs argv, no printing. The CLI and the MCP tool are thin adapters, and
 * a later D-Bus service can call the very same functions without a rewrite.
 *
 * Definition of the term, where it sits in the Bescheid, and why it is recorded rather than derived:
 * docs/references/tax-sources.md → "§2 Abs. 5 EStG — zu versteuerndes Einkommen (zvE) als erfasster Wert".
 */

import {
    getTaxAssessment,
    type LedgerDatabase,
    ledgerDbPath,
    listTaxAssessments,
    migrate,
    openLedger,
    removeTaxAssessment,
    searchAccountKeys,
    type TaxAssessment,
    transactionsSummary,
    upsertTaxAssessment,
    type ZvESource,
} from '@steuererklaerung/store';
import { getDocument } from '@steuererklaerung/paperless';
import {
    defaultEntityFor,
    loadManifest,
    requireEntity,
    resolveEntityAccounts,
    resolveEntityEst,
} from '../config/index.ts';
import { scanZvEFromBescheid, type ZvEBescheidTreffer } from '../elster/zve-bescheid.ts';
import { estReport } from './elster/est.ts';

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

/**
 * The zvE of one year plus its provenance. Fully serializable (JSON / D-Bus a{sv}) — `herkunft` is
 * always present, so a consumer can never hold the number without knowing what kind of number it is.
 */
export interface ZvEWert {
    /** Workspace entity the figure belongs to (a household may file per person). */
    entityId: string;
    /** Veranlagungsjahr. */
    jahr: number;
    /** Zu versteuerndes Einkommen in EUR (§2 Abs. 5 EStG). */
    betrag: number;
    herkunft: ZvESource;
    /** `bescheid` only: DMS reference of the Bescheid (`paperless:<id>`), if one was recorded. */
    belegId?: string;
    /** `bescheid` only: Erfassungsdatum (ISO) — when the figure was taken from the Bescheid. */
    erfasstAm?: string;
    /** Plain-language caveat. Always set for `schaetzung`, and for a Bescheid value without a Beleg. */
    hinweis?: string;
}

/** Options shared by the read functions. */
export interface ZvEOptions {
    /** Workspace entity id; defaults to the manifest's `privat` entity. */
    entityId?: string;
}

/**
 * Resolve which entity a zvE query is about: an explicit id (fail-loud with the known-id list via
 * {@link requireEntity}), else the manifest's private entity — a Steuerbescheid is a private-side
 * document, so `privat` is the right default here, exactly as for `elster est`.
 */
export function resolveZvEEntityId(entityId?: string): string {
    const manifest = loadManifest();
    return (entityId ? requireEntity(manifest, entityId) : defaultEntityFor(manifest, 'privat')).id;
}

function toWert(a: TaxAssessment): ZvEWert {
    return {
        entityId: a.entityId,
        jahr: a.year,
        betrag: a.zve,
        herkunft: 'bescheid',
        belegId: a.documentRef ?? undefined,
        erfasstAm: a.recordedAt,
        hinweis: a.documentRef
            ? undefined
            : 'Ohne Belegverweis erfasst — nicht gegen den Bescheid nachprüfbar; Bescheid-Dokument nachtragen.',
    };
}

/**
 * The ESt estimate's zvE for a year, or null when this entity cannot be estimated (no `est` section
 * in the manifest). Never a Bescheid value — the caller labels it `schaetzung`.
 */
function estimateZvE(entityId: string, jahr: number): number | null {
    const config = resolveEntityEst(entityId);
    if (!config) return null;
    const entity = requireEntity(loadManifest(), entityId);
    const accountKeys = resolveEntityAccounts(
        entity,
        transactionsSummary().accounts.map((a) => a.accountKey),
    );
    const txs = accountKeys.length
        ? searchAccountKeys(accountKeys, { from: `${jahr}-01-01`, to: `${jahr}-12-31` })
        : [];
    return estReport(config, jahr, { txs }).result.zvE;
}

/**
 * The zvE of one Veranlagungsjahr, or null when nothing is recorded.
 *
 * By default this returns ONLY a recorded Bescheid value. The app's own estimate is opt-in via
 * `fallback: 'schaetzung'` — that opt-in is the safeguard: a caller that never asks for an estimate
 * can never be handed one, and a caller that does ask gets it clearly labelled in `herkunft`.
 */
export function getZvE(jahr: number, options: ZvEOptions & { fallback?: 'schaetzung' } = {}): ZvEWert | null {
    const entityId = resolveZvEEntityId(options.entityId);
    const recorded = withLedger((db) => getTaxAssessment(db, entityId, jahr));
    if (recorded) return toWert(recorded);
    if (options.fallback !== 'schaetzung') return null;

    const betrag = estimateZvE(entityId, jahr);
    if (betrag == null) return null;
    return {
        entityId,
        jahr,
        betrag,
        herkunft: 'schaetzung',
        hinweis:
            'Schätzung aus der eigenen Berechnung — KEIN Bescheidwert. Für Nachweise den Einkommensteuerbescheid erfassen.',
    };
}

/**
 * Every recorded year (newest first). Bescheid values only — an estimate is never listed. Without an
 * `entityId` this spans ALL entities (a household may file per person); each row names its own, so
 * the caller can tell two filers apart.
 */
export function listZvE(options: ZvEOptions = {}): ZvEWert[] {
    const entityId = options.entityId ? resolveZvEEntityId(options.entityId) : undefined;
    return withLedger((db) => listTaxAssessments(db, { entityId })).map(toWert);
}

/** Record (or replace) one year's zvE as read off the Bescheid. */
export function recordZvE(input: {
    jahr: number;
    betrag: number;
    entityId?: string;
    /** DMS reference of the Bescheid, e.g. `paperless:2900`. */
    belegId?: string | null;
    notiz?: string | null;
}): ZvEWert {
    const entityId = resolveZvEEntityId(input.entityId);
    const saved = withLedger((db) =>
        upsertTaxAssessment(
            db,
            { entityId, year: input.jahr, zve: input.betrag, documentRef: input.belegId, note: input.notiz },
            nowIso(),
        ),
    );
    return toWert(saved);
}

/** Delete one year's recorded zvE. Returns true when a row was removed. */
export function removeZvE(jahr: number, options: ZvEOptions = {}): boolean {
    const entityId = resolveZvEEntityId(options.entityId);
    return withLedger((db) => removeTaxAssessment(db, entityId, jahr));
}

/** A parsed Bescheid, ready for a human to confirm. Nothing is written until they do. */
export interface ZvEVorschlag {
    belegId: string;
    /** Proposed amount, or null when the text was ambiguous/unreadable. */
    betrag: number | null;
    /** Veranlagungsjahr read off the Bescheid, if it states one. */
    jahr: number | null;
    /** The matching lines, verbatim, so the proposal can be checked against the PDF. */
    treffer: ZvEBescheidTreffer[];
    hinweise: string[];
}

/** Parse `paperless:<id>` into the numeric Paperless document id. */
function paperlessIdFrom(belegId: string): number {
    const match = /^paperless:(\d+)$/.exec(belegId.trim());
    if (!match) {
        throw new Error(
            `Belegverweis „${belegId}" nicht unterstützt — erwartet wird „paperless:<id>" (nur Paperless-Dokumente können gelesen werden).`,
        );
    }
    return Number(match[1]);
}

/**
 * Propose a zvE from the OCR text of a Paperless Bescheid — the "vorschlagen und bestätigen" half of
 * the intake. It reads and parses; it does NOT write. The caller shows `treffer` to a human, who
 * then confirms via {@link recordZvE}. Only the parsed figure leaves this function, never the
 * document body beyond the matching lines.
 */
export async function suggestZvEFromDocument(belegId: string): Promise<ZvEVorschlag> {
    const doc = await getDocument(paperlessIdFrom(belegId));
    const scan = scanZvEFromBescheid(doc.content ?? '');
    const hinweise = [...scan.hinweise];
    if (!doc.content) hinweise.push('Das Dokument hat keinen OCR-Text in Paperless — Wert von Hand erfassen.');
    return { belegId, betrag: scan.vorschlag, jahr: scan.jahr, treffer: scan.treffer, hinweise };
}
