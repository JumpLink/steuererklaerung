/**
 * Offene Posten & Fristen — the reactive layer: every Paperless document currently marked
 * `payment_status = offen`, ranked by urgency (overdue first, then soonest `due_date`, undated
 * last). This is the "damit ich sowas nicht vergesse" list; the document-workflow skill populates
 * the fields (payment_status / amount_to_pay / due_date) that this report reads back.
 *
 * Read-only. Reused by the CLI (`fristen`), the MCP tool (`list_open_items`) and the app/web views.
 */

import {
    listDocuments,
    getCustomFieldValue,
    parseMonetaryValue,
    fetchAllPages,
    listCorrespondents,
} from '@steuererklaerung/paperless';
import { normalizeDateValue } from '@steuererklaerung/shared';
import { loadPaperlessConfig } from '../config/index.ts';
import { PAYMENT_STATUS_OPTIONS, DATA_SCOPE_OPTIONS } from '../lib/select-field-constants.ts';

export interface OpenItem {
    id: number;
    title: string | null;
    correspondent: string | null;
    /** amount_to_pay in EUR, or null if not recorded. */
    amount: number | null;
    /** due_date (YYYY-MM-DD), or null if none. */
    dueDate: string | null;
    /** Whole days from today until dueDate (negative = overdue); null if no due_date. */
    daysUntil: number | null;
    overdue: boolean;
    dataScope: string | null;
}

/** Resolve a raw select value to its label, tolerating hash-id, integer-index or already-a-label. */
function resolveSelect(
    raw: unknown,
    optionMap: Record<string, string> | undefined,
    labels: readonly string[],
): string | null {
    if (raw == null || raw === '') return null;
    const s = String(raw);
    if (optionMap) for (const [label, id] of Object.entries(optionMap)) if (String(id) === s) return label;
    if (/^\d+$/.test(s)) return labels[Number(s)] ?? null;
    return (labels as readonly string[]).includes(s) ? s : null;
}

/** Whole days from `today` (YYYY-MM-DD) until an ISO date; negative = overdue. */
function daysBetween(today: string, iso: string): number {
    const a = new Date(`${today}T00:00:00Z`).getTime();
    const b = new Date(`${iso}T00:00:00Z`).getTime();
    return Math.round((b - a) / 86_400_000);
}

/**
 * List all documents with `payment_status = offen`, enriched with amount/due date/correspondent and
 * ranked by urgency. `today` (YYYY-MM-DD) defaults to the current date; pass it for deterministic
 * output. Uses the `exists` custom-field query (robust against select index-vs-hash storage) and
 * resolves the label client-side.
 */
export async function listOpenItems(opts: { today?: string } = {}): Promise<OpenItem[]> {
    const config = loadPaperlessConfig();
    const cf = config.custom_field_ids as Record<string, number>;
    const opt = config.select_field_options;
    const today = opts.today ?? new Date().toISOString().slice(0, 10);

    // No payment_status field configured → there is nothing to be open. Guarding here is not
    // defensive tidiness: without it the id defaults to 0, Paperless answers
    // `HTTP 400 {"custom_field_query":{"0":["0 is not a valid custom field."]}}`, and every caller
    // — the CLI, the MCP tool, the Fristen view — fails outright instead of reporting an empty
    // list. Measured: it took the whole native Fristen view down for an entity on the built-in DMS.
    if (!(cf?.payment_status > 0)) return [];

    // Server-side narrow to documents that HAVE a payment_status, then filter to `offen` in code.
    // Paperless custom_field_query references the field by its numeric id, not its name.
    const query = JSON.stringify([cf.payment_status, 'exists', true]);
    const docs = await fetchAllPages((page, pageSize) =>
        listDocuments({ custom_field_query: query, page, page_size: pageSize, ordering: 'id' }),
    );

    const correspondents = await fetchAllPages((page, pageSize) => listCorrespondents({ page, page_size: pageSize }));
    const nameById = new Map(correspondents.map((c) => [c.id, c.name]));

    const items: OpenItem[] = [];
    for (const doc of docs) {
        const status = resolveSelect(
            getCustomFieldValue(doc, cf.payment_status),
            opt?.payment_status,
            PAYMENT_STATUS_OPTIONS,
        );
        if (status !== 'offen') continue;
        const dueDate = cf.due_date > 0 ? normalizeDateValue(getCustomFieldValue(doc, cf.due_date)) : null;
        const amount =
            cf.amount_to_pay > 0
                ? (parseMonetaryValue(getCustomFieldValue(doc, cf.amount_to_pay))?.amount ?? null)
                : null;
        const dataScope =
            cf.data_scope > 0
                ? resolveSelect(getCustomFieldValue(doc, cf.data_scope), opt?.data_scope, DATA_SCOPE_OPTIONS)
                : null;
        const daysUntil = dueDate ? daysBetween(today, dueDate) : null;
        items.push({
            id: doc.id,
            title: doc.title ?? null,
            correspondent: doc.correspondent != null ? (nameById.get(doc.correspondent) ?? null) : null,
            amount,
            dueDate,
            daysUntil,
            overdue: daysUntil != null && daysUntil < 0,
            dataScope,
        });
    }

    // Rank: dated items by due date ascending (most overdue / soonest first), undated items last.
    items.sort((a, b) => {
        if (a.dueDate && b.dueDate) return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.id - b.id;
        if (a.dueDate) return -1;
        if (b.dueDate) return 1;
        return a.id - b.id;
    });
    return items;
}
