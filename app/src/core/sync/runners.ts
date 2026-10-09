/**
 * The three runners behind the sync service. Each reuses an existing action (the same ones the
 * CLI and the Konten tab call) and only decides whether anything changed — by counting for the
 * transaction store, by fingerprint for lists the back-end owns.
 */

import { listOutgoingInvoices, reconcileRecurringInvoices } from '../actions/recurring-invoices.ts';
import { syncTransactions } from '../actions/transactions.ts';
import type { OutgoingInvoiceSummary } from '../invoices/provider.ts';
import type { SyncRunner } from './service.ts';
import type { SyncSource } from './plan.ts';

export interface RunnerDeps {
    listInvoices: (entityId: string) => Promise<OutgoingInvoiceSummary[]>;
    reconcile: (entityId: string, invoices: OutgoingInvoiceSummary[]) => Promise<{ rewritten: boolean }>;
    syncQonto: () => Promise<{ added: number; updated: number; error?: string }>;
    /** The ids of the entity's documents of the current year (the provider decides Paperless vs built-in). */
    listDocumentIds: (entityId: string) => Promise<string[]>;
}

export const defaultRunnerDeps: RunnerDeps = {
    listInvoices: (entityId) => listOutgoingInvoices({ entityId }),
    reconcile: (entityId, invoices) => reconcileRecurringInvoices({ entityId, invoices }),
    async syncQonto() {
        const { reports } = await syncTransactions({ account: 'qonto' });
        const failed = reports.find((r) => r.error);
        return {
            added: reports.reduce((n, r) => n + r.added, 0),
            updated: reports.reduce((n, r) => n + r.updated, 0),
            error: failed?.error,
        };
    },
    listDocumentIds: async () => [],
};

/** What the user sees of an invoice; a change in any of these means the list on screen is stale. */
export function invoiceFingerprint(invoices: readonly OutgoingInvoiceSummary[]): string {
    return invoices
        .map((i) => `${i.id}|${i.number ?? ''}|${i.status}|${i.total ?? ''}|${i.issueDate ?? ''}`)
        .sort()
        .join('\n');
}

export function createRunners(deps: RunnerDeps = defaultRunnerDeps): Record<SyncSource, SyncRunner> {
    const seen = new Map<string, string>();
    /** First sight of a list is "changed" only if the view could not have shown it — we cannot know, so yes. */
    const moved = (key: string, fingerprint: string): boolean => {
        const previous = seen.get(key);
        seen.set(key, fingerprint);
        return previous !== fingerprint;
    };
    return {
        async 'qonto-invoices'(entity) {
            const invoices = await deps.listInvoices(entity.id);
            // lastInvoice follows the invoice in Qonto (final number, replacement after a Storno).
            const { rewritten } = await deps.reconcile(entity.id, invoices);
            const listChanged = moved(`inv:${entity.id}`, invoiceFingerprint(invoices));
            return { changed: rewritten || listChanged };
        },
        async 'qonto-transactions'() {
            const r = await deps.syncQonto();
            if (r.error) throw new Error(r.error);
            return { changed: r.added + r.updated > 0 };
        },
        async paperless(entity) {
            const ids = await deps.listDocumentIds(entity.id);
            return { changed: moved(`doc:${entity.id}`, [...ids].sort().join(',')) };
        },
    };
}
