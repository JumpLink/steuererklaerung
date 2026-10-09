/**
 * Belege presenter — the ONE documents/receipts read for a period, shared by every frontend.
 *
 * It absorbs four duplicated seams:
 *   - the web `document-routes.ts` GET /api/documents in-handler filter → {@link filterDocuments} (pure),
 *   - the desktop `data/documents.ts` `loadDocuments` (the entity-year list) → {@link loadDocuments},
 *   - the desktop `data/beleg-eingang.ts` (unlinked receipts, newest first) → {@link loadBelegEingang},
 *   - the desktop `data/offene-belege.ts` (the Vorsteuer-ohne-Beleg gap, grouped by month) →
 *     {@link isBelegGap} / {@link groupBelegGap} / {@link loadOffeneBelege}.
 *
 * The pure helpers ({@link filterDocuments}, {@link isBelegGap}, {@link groupBelegGap}) are what the two
 * surfaces share; the `load*` functions wrap them with the session's memoized aggregate/documents build
 * (so an already-open entity reuses the fetch). Transport / job / byte-cache policy stays in the web.
 *
 * Pure TS (core + `@steuererklaerung/*` only) — no gi://, GTK/Adwaita, DOM, Hono, yargs or zod; runs on GJS
 * in every frontend.
 */

import type { DmsDocument } from '@steuererklaerung/dms';
import type { EuerTxDetailRow } from '../elster/euer-transactions.ts';
import type { PresenterSession } from './session.ts';
import type { EntityModel } from './workspace.ts';

export type { DmsDocument } from '@steuererklaerung/dms';

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase();

/** The document list + its DMS kind — the shape the desktop Belege / Beleg-Eingang views consume. */
export interface DocumentsResult {
    docs: DmsDocument[];
    kind: 'builtin' | 'paperless';
}

/**
 * The GET /api/documents filter set (query · date range · direction · linked-state) — every field
 * optional, applied only when present, exactly as the web handler reads its query params.
 */
export interface DocumentFilter {
    query?: string;
    from?: string;
    to?: string;
    direction?: string;
    linked?: string;
}

/**
 * Filter a document list by the review UI's criteria — the SAME progressive narrowing the web GET
 * /api/documents handler did inline (full-text over title/correspondent/invoiceNumber/OCR/tags, a
 * created-date range, incoming/outgoing direction, and linked yes/no). Pure: it never fetches and, when
 * any criterion matches, returns a fresh array (the input is never mutated).
 */
export function filterDocuments(docs: DmsDocument[], f: DocumentFilter): DmsDocument[] {
    let out = docs;
    const q = lower(f.query).trim();
    if (q)
        out = out.filter((d) =>
            [
                lower(d.title),
                lower(d.correspondent),
                lower(d.invoiceNumber),
                lower(d.ocrText),
                ...d.tags.map(lower),
            ].some((v) => v.includes(q)),
        );
    if (f.from) out = out.filter((d) => (d.created ?? '') >= f.from!);
    if (f.to) out = out.filter((d) => (d.created ?? '') <= f.to!);
    if (f.direction === 'incoming' || f.direction === 'outgoing') out = out.filter((d) => d.direction === f.direction);
    if (f.linked === 'yes') out = out.filter((d) => d.linkedTxIds.length > 0);
    if (f.linked === 'no') out = out.filter((d) => d.linkedTxIds.length === 0);
    return out;
}

/** List one entity-year's documents (async; outbound for a Paperless-backed entity), via the shared
 * session memo. Renames the session's `dmsKind` to the desktop views' `kind`. */
export async function loadDocuments(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
): Promise<DocumentsResult> {
    const { docs, dmsKind } = await session.documents(entity, year);
    return { docs, kind: dmsKind };
}

/** Receipts still waiting for a booking (newest first) + the DMS kind — the Beleg-Eingang queue. */
export interface BelegEingangData {
    docs: DmsDocument[];
    kind: 'builtin' | 'paperless';
}

/** Load the unlinked receipts for one entity-year (async; shares the session's documents memo). The
 * mirror image of Offene Belege — a receipt looking for its booking. Newest (by `created`) first. */
export async function loadBelegEingang(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
): Promise<BelegEingangData> {
    const { docs, dmsKind } = await session.documents(entity, year);
    const open = [...filterDocuments(docs, { linked: 'no' })].sort((a, b) =>
        (a.created ?? '') < (b.created ?? '') ? 1 : -1,
    );
    return { docs: open, kind: dmsKind };
}

/** One expense that claims Vorsteuer but has no linked invoice — the audit-relevant Beleg gap. */
export interface BelegGapRow {
    id: string;
    bookingDate: string;
    counterparty?: string;
    purpose?: string;
    net: number;
    vat: number;
}

export interface BelegGapMonth {
    /** 1-12. */
    month: number;
    rows: BelegGapRow[];
    /** Σ |vat| in the month. */
    vat: number;
}

export interface OffeneBelegeData {
    months: BelegGapMonth[];
    totalCount: number;
    totalVat: number;
}

/**
 * The Beleg-gap predicate (mirrors the web bh-belege-view + view-helpers `isVstNoBeleg`): an EÜR detail
 * row counts as "offen" when it is an expense that claims Vorsteuer (|vat| > 0.005) but no document links
 * to it. `linkedTxIds` is the union of every document's `linkedTxIds`.
 */
export function isBelegGap(row: EuerTxDetailRow, linkedTxIds: Set<string>): boolean {
    return row.kind === 'expense' && Math.abs(row.vat) > 0.005 && !linkedTxIds.has(row.id);
}

/** Filter the EÜR detail to the Beleg gap and group it by booking month (1-12), with per-month + total
 * Vorsteuer at stake. Pure — the shared derivation both the fetch wrapper and the tests exercise. */
export function groupBelegGap(detail: EuerTxDetailRow[], linkedTxIds: Set<string>): OffeneBelegeData {
    const gap = detail.filter((r) => isBelegGap(r, linkedTxIds));

    const byMonth = new Map<number, BelegGapRow[]>();
    for (const r of gap) {
        const month = Number(r.bookingDate.slice(5, 7));
        const rows = byMonth.get(month) ?? [];
        rows.push({
            id: r.id,
            bookingDate: r.bookingDate,
            counterparty: r.counterparty,
            purpose: r.purpose,
            net: r.net,
            vat: r.vat,
        });
        byMonth.set(month, rows);
    }

    const months: BelegGapMonth[] = [...byMonth.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([month, rows]) => ({ month, rows, vat: rows.reduce((s, r) => s + Math.abs(r.vat), 0) }));

    return { months, totalCount: gap.length, totalVat: gap.reduce((s, r) => s + Math.abs(r.vat), 0) };
}

/**
 * Review-queue navigation (pure) — the guided confirm flow's session state: which receipts are
 * still open (not confirmed this session), what the progress reads, and where ←/→ / "und weiter"
 * land. Shared here so the stepping/clamping rules are unit-tested once, not re-derived per frontend.
 */

/** "X von N geprüft" — the progress caption over the queue list. */
export function reviewProgressLabel(total: number, done: number): string {
    return `${done} von ${total} geprüft`;
}

/** The queue's open (not yet confirmed) document ids, in list order. */
export function openDocIds(docs: Pick<DmsDocument, 'id'>[], done: ReadonlySet<string>): string[] {
    return docs.filter((d) => !done.has(d.id)).map((d) => d.id);
}

/**
 * Where "Bestätigen und weiter" lands after confirming `afterId`: the next open receipt below it,
 * else the first open one from the top, else null (queue done).
 */
export function nextOpenId(
    docs: Pick<DmsDocument, 'id'>[],
    done: ReadonlySet<string>,
    afterId?: string,
): string | null {
    const open = openDocIds(docs, done);
    if (open.length === 0) return null;
    if (afterId != null) {
        const idx = docs.findIndex((d) => d.id === afterId);
        const below = docs.slice(idx + 1).find((d) => !done.has(d.id));
        if (below) return below.id;
    }
    return open[0];
}

/**
 * Where ←/→ (and "Überspringen" = step forward) land: the neighbouring OPEN receipt, clamped at the
 * ends (no wrap-around). A done/unknown current falls back to the first open receipt.
 */
export function stepOpenId(
    docs: Pick<DmsDocument, 'id'>[],
    done: ReadonlySet<string>,
    currentId: string | null,
    dir: 1 | -1,
): string | null {
    const open = openDocIds(docs, done);
    if (open.length === 0) return null;
    const idx = currentId != null ? open.indexOf(currentId) : -1;
    if (idx < 0) return open[0];
    return open[Math.max(0, Math.min(open.length - 1, idx + dir))];
}

/**
 * Load the Offene-Belege worklist for one entity-year — the classified rows from the EÜR aggregate and
 * the linked-tx set from the entity's DMS docs (both via the shared session memo; outbound for a
 * Paperless entity), reduced by {@link groupBelegGap}.
 */
export async function loadOffeneBelege(
    session: PresenterSession,
    entity: EntityModel,
    year: number,
): Promise<OffeneBelegeData> {
    const [agg, documents] = await Promise.all([session.aggregate(entity, year), session.documents(entity, year)]);

    // A document "covers" every transaction it links to.
    const linked = new Set<string>();
    for (const doc of documents.docs) for (const id of doc.linkedTxIds) linked.add(id);

    return groupBelegGap(agg.detail ?? [], linked);
}
