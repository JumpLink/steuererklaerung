/**
 * Offene Posten abgleichen: for every open invoice (`payment_status = offen`), look for its bank
 * payment and — only when the match is unambiguous — link the two and mark the invoice paid.
 *
 * The rule is deliberately strict, because a wrong auto-link silently falsifies the books:
 * a document is acted on only when EXACTLY ONE transaction candidate reaches
 * {@link RECONCILE_MIN_SCORE}. Two strong candidates (e.g. a monthly bill paid twice) are
 * ambiguous and left for a person; so is a best candidate below the threshold.
 *
 * Default is a dry run that returns the plan; writes happen only with `apply: true`. All reads and
 * writes go through the entity's {@link DmsProvider}, never raw Paperless.
 */

import type { DmsProvider } from '@steuererklaerung/dms';
import { listOpenItems, type OpenItem } from '../fristen.ts';
import {
    linkDocumentToTransaction,
    resolveEntityDms,
    suggestTransactionLinksForDocument,
    type LinkCandidate,
} from '../link-candidates.ts';
import { setPaymentStatus } from './inbox.ts';

/**
 * Minimum RAW reconcile score (~0..160) for a candidate to count. Same gate as the automated
 * reconciler's `pickBestMatch` (minScore 60); the display score in {@link LinkCandidate.score}
 * clamps at 100 and must not be used here.
 */
export const RECONCILE_MIN_SCORE = 60;

export type ReconcileDecision =
    | 'link'
    | 'ambiguous'
    | 'below-threshold'
    | 'no-candidate'
    | 'already-paid'
    | 'not-found';

export interface ReconcilePlanEntry {
    documentId: string;
    title: string | null;
    decision: ReconcileDecision;
    /** The transaction that is (or would be) linked; set only for `link`. */
    transactionId?: string;
    /** Raw scores of the candidates at or above the threshold (all of them for `ambiguous`). */
    scores: number[];
    /** Set after an apply run: the link and the status write both succeeded. */
    applied?: boolean;
    error?: string;
}

export interface ReconcileOpenItemsResult {
    dryRun: boolean;
    minScore: number;
    considered: number;
    toLink: number;
    applied: number;
    entries: ReconcilePlanEntry[];
}

/** The seams the action needs; tests pass fakes, production uses the defaults. */
export interface ReconcileDeps {
    provider: DmsProvider;
    listOpen: () => Promise<Pick<OpenItem, 'id' | 'title'>[]>;
    suggest: (documentId: string) => Promise<LinkCandidate[]>;
    link: (documentId: string, txId: string) => Promise<unknown>;
}

function defaultDeps(entityId: string): ReconcileDeps {
    return {
        provider: resolveEntityDms(entityId).provider,
        listOpen: () => listOpenItems(),
        suggest: (documentId) => suggestTransactionLinksForDocument(entityId, documentId),
        link: (documentId, txId) => linkDocumentToTransaction(entityId, documentId, txId),
    };
}

export async function reconcileOpenItems(
    entityId: string,
    options: { apply?: boolean; minScore?: number } = {},
    deps: ReconcileDeps = defaultDeps(entityId),
): Promise<ReconcileOpenItemsResult> {
    const apply = options.apply === true;
    const minScore = options.minScore ?? RECONCILE_MIN_SCORE;
    const entries: ReconcilePlanEntry[] = [];

    for (const item of await deps.listOpen()) {
        const documentId = String(item.id);
        const entry: ReconcilePlanEntry = { documentId, title: item.title, decision: 'no-candidate', scores: [] };
        entries.push(entry);

        const doc = await deps.provider.get(documentId);
        if (!doc) {
            entry.decision = 'not-found';
            continue;
        }
        if (doc.paymentStatus != null && doc.paymentStatus !== 'offen') {
            entry.decision = 'already-paid';
            continue;
        }

        const candidates = await deps.suggest(documentId);
        const strong = candidates.filter((c) => c.transactionId && c.rawScore >= minScore);
        entry.scores = strong.map((c) => c.rawScore);
        if (strong.length === 1) {
            entry.decision = 'link';
            entry.transactionId = strong[0].transactionId;
        } else if (strong.length > 1) entry.decision = 'ambiguous';
        else entry.decision = candidates.length > 0 ? 'below-threshold' : 'no-candidate';
    }

    if (apply) {
        for (const entry of entries) {
            if (entry.decision !== 'link' || !entry.transactionId) continue;
            try {
                await deps.link(entry.documentId, entry.transactionId);
                await setPaymentStatus(deps.provider, entry.documentId, { status: 'bezahlt' });
                entry.applied = true;
            } catch (err) {
                // One failing document must not stop the rest; the error is part of the report.
                entry.applied = false;
                entry.error = err instanceof Error ? err.message : String(err);
            }
        }
    }

    return {
        dryRun: !apply,
        minScore,
        considered: entries.length,
        toLink: entries.filter((e) => e.decision === 'link').length,
        applied: entries.filter((e) => e.applied === true).length,
        entries,
    };
}
