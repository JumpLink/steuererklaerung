/**
 * The built-in, dependency-free DMS: receipt files on disk + metadata in the SQLite
 * ledger (schema v2). This is the **default** back-end (no Paperless, no Docker) and the
 * native-GNOME-app target. Files are content-addressed (sha256) under
 * `<store>/documents/<entityId>/<sha[0:2]>/<sha>.<ext>`; metadata, the tx-links and the
 * OCR text live in the `documents` / `document_links` / `document_ocr` tables.
 *
 * Metadata (incl. the OCR full text) is filled by the AI — see src/dms/extract.ts — so
 * there is no local OCR dependency. Linking a receipt to a booked transaction is gated by
 * the GoBD period lock, derived from the transaction's own account/year.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
    getStoreDir,
    ledgerDbPath,
    openLedger,
    migrate,
    entityForAccountKey,
    getPeriodStatus,
    searchTransactions,
    type LedgerDatabase,
} from '@steuererklaerung/store';
import type { DmsProvider, DmsDocument, DmsFile, DmsOrigin, DmsRuleOrigin, DmsRuleField } from './types.ts';
import { renderPdfThumbnail } from './pdf-thumb.ts';

/** Directory holding every built-in DMS file (per entity), under the gitignored store. */
function documentsRoot(): string {
    return join(getStoreDir(), 'documents');
}

/** Sanitised file extension from the filename, else derived from the MIME type. */
function extOf(filename: string, mimeType?: string): string {
    const m = /\.([a-zA-Z0-9]{1,8})$/.exec(filename);
    if (m) return m[1].toLowerCase();
    if (mimeType === 'application/pdf') return 'pdf';
    if (mimeType === 'image/png') return 'png';
    if (mimeType === 'image/jpeg') return 'jpg';
    return 'bin';
}

interface DocRow {
    id: string;
    entity_id: string;
    title: string | null;
    correspondent: string | null;
    document_type: string | null;
    direction: string | null;
    created: string | null;
    added: string | null;
    filename: string | null;
    mime_type: string | null;
    invoice_number: string | null;
    net: number | null;
    gross: number | null;
    vat: number | null;
    tags: string | null;
    tx_ids: string | null;
    ocr_text: string | null;
    ocr_source: string | null;
    invoice_kind: string | null;
    invoice_kind_reason: string | null;
    category: string | null;
    rule_origin: string | null;
    origin: string | null;
    note: string | null;
    payment_status: string | null;
    due_date: string | null;
    amount_to_pay: number | null;
}

const RULE_FIELDS: readonly DmsRuleField[] = ['correspondent', 'documentType', 'category', 'direction'];

function parseRuleOrigin(raw: string | null): DmsRuleOrigin | null {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw) as Partial<DmsRuleOrigin>;
        if (typeof v.id !== 'string' || typeof v.label !== 'string' || !Array.isArray(v.fields)) return null;
        const fields = v.fields.filter((f): f is DmsRuleField => RULE_FIELDS.includes(f as DmsRuleField));
        return fields.length > 0 ? { id: v.id, label: v.label, fields } : null;
    } catch {
        return null;
    }
}

function parseOrigin(raw: string | null): DmsOrigin | null {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw) as Partial<DmsOrigin>;
        return v.kind === 'mail' && typeof v.from === 'string' && typeof v.date === 'string'
            ? { kind: 'mail', from: v.from, date: v.date }
            : null;
    } catch {
        return null;
    }
}

function parseTags(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.map(String) : [];
    } catch {
        return [];
    }
}

function rowToDoc(r: DocRow): DmsDocument {
    return {
        id: r.id,
        dms: 'builtin',
        title: r.title,
        correspondent: r.correspondent,
        documentType: r.document_type,
        direction: r.direction === 'incoming' || r.direction === 'outgoing' ? r.direction : null,
        created: r.created,
        added: r.added,
        tags: parseTags(r.tags),
        invoiceNumber: r.invoice_number,
        net: r.net,
        gross: r.gross,
        vat: r.vat,
        linkedTxIds: r.tx_ids ? r.tx_ids.split(',').filter(Boolean) : [],
        mimeType: r.mime_type,
        pageCount: null,
        ocrText: r.ocr_text,
        ocrSource: r.ocr_source === 'ai' || r.ocr_source === 'paperless' ? r.ocr_source : r.ocr_text ? 'ai' : null,
        aiNote: r.note ?? null,
        paymentStatus: r.payment_status ?? null,
        dueDate: r.due_date ?? null,
        amountToPay: r.amount_to_pay ?? null,
        invoiceKind: r.invoice_kind === 'e-rechnung' || r.invoice_kind === 'sonstige-rechnung' ? r.invoice_kind : null,
        invoiceKindReason: r.invoice_kind_reason ?? null,
        category: r.category ?? null,
        ruleOrigin: parseRuleOrigin(r.rule_origin),
        origin: parseOrigin(r.origin),
    };
}

const SELECT_DOC = `SELECT d.*,
     (SELECT GROUP_CONCAT(tx_id) FROM document_links WHERE document_id = d.id) AS tx_ids,
     ocr.text AS ocr_text, ocr.source AS ocr_source
   FROM documents d
   LEFT JOIN document_ocr ocr ON ocr.dms = 'builtin' AND ocr.doc_id = d.id`;

export class BuiltinDmsProvider implements DmsProvider {
    readonly kind = 'builtin' as const;

    constructor(private readonly entityId: string) {}

    /** Open + migrate + close the ledger DB around `fn` (mirrors actions/ledger.ts). */
    private withDb<T>(fn: (db: LedgerDatabase) => T): T {
        const db = openLedger(ledgerDbPath());
        try {
            migrate(db);
            return fn(db);
        } finally {
            db.close();
        }
    }

    async list(range: { from: string; to: string }): Promise<DmsDocument[]> {
        return this.withDb((db) => {
            const rows = db
                .prepare(
                    `${SELECT_DOC} WHERE d.entity_id = ? AND d.created IS NOT NULL AND d.created >= ? AND d.created <= ? ORDER BY d.created DESC`,
                )
                .all(this.entityId, range.from, range.to) as unknown as DocRow[];
            return rows.map(rowToDoc);
        });
    }

    async get(id: string): Promise<DmsDocument | null> {
        return this.withDb((db) => {
            const row = db.prepare(`${SELECT_DOC} WHERE d.id = ? AND d.entity_id = ?`).get(id, this.entityId) as
                | DocRow
                | undefined;
            return row ? rowToDoc(row) : null;
        });
    }

    /** Built-in inbox = documents no metadata has been written to yet (`ai_extracted_at` unset). */
    async listInbox(): Promise<DmsDocument[]> {
        return this.withDb((db) => {
            const rows = db
                .prepare(`${SELECT_DOC} WHERE d.entity_id = ? AND d.ai_extracted_at IS NULL ORDER BY d.added, d.id`)
                .all(this.entityId) as unknown as DocRow[];
            return rows.map(rowToDoc);
        });
    }

    async getText(id: string): Promise<string | null> {
        return (await this.get(id))?.ocrText ?? null;
    }

    /** setMetadata stamps `ai_extracted_at`, which is what leaves the inbox — nothing more to do. */
    async markReviewed(id: string): Promise<void> {
        if (!(await this.get(id))) throw new Error(`Dokument ${id} nicht gefunden.`);
    }

    async getFile(id: string): Promise<DmsFile | null> {
        const row = this.withDb(
            (db) =>
                db
                    .prepare('SELECT file_path, mime_type FROM documents WHERE id = ? AND entity_id = ?')
                    .get(id, this.entityId) as { file_path: string; mime_type: string | null } | undefined,
        );
        if (!row || !existsSync(row.file_path)) return null;
        return {
            bytes: readFileSync(row.file_path),
            mimeType: row.mime_type ?? 'application/octet-stream',
        };
    }

    /** Card preview: an image is its own thumbnail; a PDF's first page is rasterized (GJS/Poppler). */
    async getThumbnail(id: string): Promise<DmsFile | null> {
        const f = await this.getFile(id);
        if (!f) return null;
        if (f.mimeType.startsWith('image/')) return f;
        if (f.mimeType === 'application/pdf') {
            const png = renderPdfThumbnail(f.bytes);
            return png ? { bytes: png, mimeType: 'image/png' } : null;
        }
        return null;
    }

    async store(input: {
        bytes: Uint8Array;
        filename: string;
        mimeType?: string;
        created?: string;
        origin?: DmsOrigin;
    }): Promise<DmsDocument> {
        const bytes = input.bytes instanceof Buffer ? input.bytes : Buffer.from(input.bytes);
        const sha = createHash('sha256').update(bytes).digest('hex');
        const ext = extOf(input.filename, input.mimeType);
        const dir = join(documentsRoot(), this.entityId, sha.slice(0, 2));
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const filePath = join(dir, `${sha}.${ext}`);
        writeFileSync(filePath, bytes);
        const today = new Date().toISOString().slice(0, 10);
        const created = input.created ?? today; // land an un-analyzed upload in the viewed year
        const at = new Date().toISOString();
        this.withDb((db) => {
            // Content-addressed: re-uploading the same bytes updates the same row (natural dedup).
            db.prepare(
                `INSERT INTO documents (id, entity_id, title, created, added, filename, mime_type, size_bytes, file_path, created_by, origin)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET filename = excluded.filename, mime_type = excluded.mime_type,
                   size_bytes = excluded.size_bytes, file_path = excluded.file_path`,
            ).run(
                sha,
                this.entityId,
                input.filename,
                created,
                today,
                input.filename,
                input.mimeType ?? null,
                bytes.length,
                filePath,
                input.origin ? input.origin.kind : 'web-upload',
                input.origin ? JSON.stringify(input.origin) : null,
            );
            db.prepare('INSERT INTO audit_log(at, action, detail) VALUES(?, ?, ?)').run(
                at,
                'dms_store',
                JSON.stringify({ entity: this.entityId, id: sha, filename: input.filename }),
            );
        });
        const doc = await this.get(sha);
        if (!doc) throw new Error('Dokument konnte nach dem Speichern nicht gelesen werden.');
        return doc;
    }

    async setMetadata(id: string, meta: Partial<DmsDocument>): Promise<void> {
        this.withDb((db) => {
            const exists = db.prepare('SELECT 1 FROM documents WHERE id = ? AND entity_id = ?').get(id, this.entityId);
            if (!exists) throw new Error(`Dokument ${id} nicht gefunden.`);
            const sets: string[] = [];
            const vals: (string | number | null)[] = [];
            const set = (col: string, val: string | number | null | undefined) => {
                if (val !== undefined) {
                    sets.push(`${col} = ?`);
                    vals.push(val);
                }
            };
            set('title', meta.title);
            set('correspondent', meta.correspondent);
            set('document_type', meta.documentType);
            set('direction', meta.direction);
            set('created', meta.created);
            set('invoice_number', meta.invoiceNumber);
            set('net', meta.net);
            set('gross', meta.gross);
            set('vat', meta.vat);
            set('invoice_kind', meta.invoiceKind);
            set('invoice_kind_reason', meta.invoiceKindReason);
            set('category', meta.category);
            set('note', meta.aiNote);
            set('payment_status', meta.paymentStatus);
            set('due_date', meta.dueDate);
            set('amount_to_pay', meta.amountToPay);
            // undefined = leave, null = clear (a manual edit took the last field back), else the origin as JSON
            set(
                'rule_origin',
                meta.ruleOrigin === undefined ? undefined : meta.ruleOrigin ? JSON.stringify(meta.ruleOrigin) : null,
            );
            if (meta.tags !== undefined) set('tags', JSON.stringify(meta.tags));
            if (sets.length) {
                sets.push('ai_extracted_at = ?');
                vals.push(new Date().toISOString());
                vals.push(id, this.entityId);
                db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = ? AND entity_id = ?`).run(...vals);
            }
            // OCR full text is stored DMS-agnostically (built-in here) so the search can use it.
            if (meta.ocrText != null) {
                db.prepare(
                    `INSERT INTO document_ocr (dms, doc_id, text, source, at) VALUES ('builtin', ?, ?, ?, ?)
                     ON CONFLICT(dms, doc_id) DO UPDATE SET text = excluded.text, source = excluded.source, at = excluded.at`,
                ).run(id, meta.ocrText, meta.ocrSource ?? 'ai', new Date().toISOString());
            }
        });
    }

    async link(id: string, txId: string): Promise<void> {
        // GoBD: a receipt may not be tied to a booking in a festgeschriebene (locked) period.
        const tx = searchTransactions({}).transactions.find((t) => t.id === txId);
        this.withDb((db) => {
            if (tx) {
                const ledgerEntity = entityForAccountKey(tx.accountKey);
                const year = Number(tx.bookingDate.slice(0, 4));
                if (ledgerEntity && Number.isFinite(year) && getPeriodStatus(db, ledgerEntity, year) === 'locked')
                    throw new Error(
                        `Periode ${year} der Entität "${ledgerEntity}" ist festgeschrieben (GoBD) — Verknüpfen gesperrt.`,
                    );
            }
            const exists = db.prepare('SELECT 1 FROM documents WHERE id = ? AND entity_id = ?').get(id, this.entityId);
            if (!exists) throw new Error(`Dokument ${id} nicht gefunden.`);
            db.prepare('INSERT OR IGNORE INTO document_links (document_id, tx_id) VALUES (?, ?)').run(id, txId);
            db.prepare('INSERT INTO audit_log(at, action, detail) VALUES(?, ?, ?)').run(
                new Date().toISOString(),
                'dms_link',
                JSON.stringify({ entity: this.entityId, id, txId }),
            );
        });
    }

    async unlink(id: string, txId: string): Promise<void> {
        // GoBD: like link() — a locked period's receipt assignment may not be altered.
        const tx = searchTransactions({}).transactions.find((t) => t.id === txId);
        this.withDb((db) => {
            if (tx) {
                const ledgerEntity = entityForAccountKey(tx.accountKey);
                const year = Number(tx.bookingDate.slice(0, 4));
                if (ledgerEntity && Number.isFinite(year) && getPeriodStatus(db, ledgerEntity, year) === 'locked')
                    throw new Error(
                        `Periode ${year} der Entität "${ledgerEntity}" ist festgeschrieben (GoBD) — Entknüpfen gesperrt.`,
                    );
            }
            const exists = db.prepare('SELECT 1 FROM documents WHERE id = ? AND entity_id = ?').get(id, this.entityId);
            if (!exists) throw new Error(`Dokument ${id} nicht gefunden.`);
            db.prepare('DELETE FROM document_links WHERE document_id = ? AND tx_id = ?').run(id, txId);
            db.prepare('INSERT INTO audit_log(at, action, detail) VALUES(?, ?, ?)').run(
                new Date().toISOString(),
                'dms_unlink',
                JSON.stringify({ entity: this.entityId, id, txId }),
            );
        });
    }

    /** Remove a document + its file (used by tests / future delete UI). GoBD-guarded by caller. */
    async remove(id: string): Promise<void> {
        const row = this.withDb((db) => {
            const r = db
                .prepare('SELECT file_path FROM documents WHERE id = ? AND entity_id = ?')
                .get(id, this.entityId) as { file_path: string } | undefined;
            if (r) {
                db.prepare('DELETE FROM documents WHERE id = ? AND entity_id = ?').run(id, this.entityId);
                db.prepare("DELETE FROM document_ocr WHERE dms = 'builtin' AND doc_id = ?").run(id);
            }
            return r;
        });
        if (row?.file_path && existsSync(row.file_path)) {
            try {
                unlinkSync(row.file_path);
            } catch {
                /* best-effort */
            }
        }
    }
}
