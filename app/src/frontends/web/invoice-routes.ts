/**
 * Outgoing-invoice routes for the "Rechnungen" view. The self back-end is LOCAL (SQLite + a
 * cairo/Pango render), so every read here is safe to run synchronously in the handler (unlike the
 * outbound Qonto list, which stays a polled job in recurring-routes.ts). Read-only surface:
 * capabilities, detail, PDF and XRechnung bytes. The write actions (finalize / mark-paid / cancel /
 * draft) are added by the create/edit + lifecycle routes.
 */

import type { Hono } from 'hono';
import { entityOf, type MetaInfo } from './routes.ts';
import {
    cancelOutgoingInvoice,
    deleteOutgoingInvoiceDraft,
    finalizeOutgoingInvoice,
    getInvoiceCapabilities,
    markOutgoingInvoicePaid,
    saveOutgoingInvoiceDraft,
} from '../../core/actions/outgoing-invoices.ts';
import {
    loadInvoiceDetail,
    loadInvoicePdf,
    loadInvoiceXml,
    loadPaymentCandidates,
} from '../../core/presenters/rechnungen.ts';
import type { CreateInvoiceInput, OutgoingInvoiceDraft } from '../../core/invoices/provider.ts';

export interface InvoiceRouteDeps {
    meta: MetaInfo;
}

interface DraftJob {
    status: 'running' | 'done' | 'error';
    draft?: OutgoingInvoiceDraft;
    error?: string;
}

let jobSeq = 0;

export function registerInvoiceRoutes(app: Hono, deps: InvoiceRouteDeps): void {
    const { meta } = deps;
    const draftJobs = new Map<string, DraftJob>();

    // ── The entity back-end + its capabilities (UIs gate actions on this) ────────────────
    app.get('/api/invoicing/capabilities', (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        try {
            return c.json(getInvoiceCapabilities(entity.id));
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // ── One invoice in detail (self is local; Qonto has no detail → 501 handled in the UI) ─
    app.get('/api/invoices/:id/detail', async (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        try {
            const invoice = await loadInvoiceDetail(entity.id, c.req.param('id'));
            if (!invoice) return c.json({ error: 'Rechnung nicht gefunden.' }, 404);
            return c.json(invoice);
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 501);
        }
    });

    // ── The invoice PDF: bytes (self) inline, or the hosted URL (Qonto) as JSON ───────────
    app.get('/api/invoices/:id/pdf', async (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        try {
            const file = await loadInvoicePdf(entity.id, c.req.param('id'));
            if (!file) return c.json({ error: 'Kein PDF verfügbar.' }, 404);
            if (file.kind === 'url') return c.json({ url: file.url });
            return new Response(new Uint8Array(file.bytes), {
                headers: {
                    'Content-Type': 'application/pdf',
                    'Content-Disposition': `inline; filename="${encodeURIComponent(file.filename)}"`,
                    'X-Content-Type-Options': 'nosniff',
                },
            });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 501);
        }
    });

    // ── The XRechnung XML (self only) as a download ──────────────────────────────────────
    app.get('/api/invoices/:id/xml', async (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        try {
            const file = await loadInvoiceXml(entity.id, c.req.param('id'));
            if (!file || file.kind !== 'bytes') return c.json({ error: 'Kein XRechnung-Export verfügbar.' }, 404);
            return new Response(new Uint8Array(file.bytes), {
                headers: {
                    'Content-Type': 'application/xml',
                    'Content-Disposition': `attachment; filename="${encodeURIComponent(file.filename)}"`,
                    'X-Content-Type-Options': 'nosniff',
                },
            });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 501);
        }
    });

    // ── Create / update a DRAFT (deferred job: a Qonto create is an OUTBOUND fetch) ────────
    app.post('/api/invoices/draft', async (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        let body: { id?: string; input: CreateInvoiceInput };
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: 'Ungültiger Request-Body.' }, 400);
        }
        const jobId = `inv-draft-${++jobSeq}`;
        draftJobs.set(jobId, { status: 'running' });
        setTimeout(() => {
            void (async () => {
                try {
                    const draft = await saveOutgoingInvoiceDraft(entity.id, body.input, body.id);
                    draftJobs.set(jobId, { status: 'done', draft });
                } catch (e) {
                    draftJobs.set(jobId, { status: 'error', error: e instanceof Error ? e.message : String(e) });
                }
            })();
        }, 0);
        return c.json({ jobId });
    });

    app.get('/api/invoices/draft/:jobId', (c) => {
        const jobId = c.req.param('jobId');
        const job = draftJobs.get(jobId);
        if (!job) return c.json({ error: 'Job nicht gefunden.' }, 404);
        // Evict a finished job once the client has read its terminal state (the poll loop stops on
        // done/error) so the map doesn't grow unbounded over the server's lifetime.
        if (job.status !== 'running') draftJobs.delete(jobId);
        return c.json(job);
    });

    // ── Festschreiben (self is local; render is sync CPU → safe in the handler) ────────────
    app.post('/api/invoices/:id/finalize', async (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        try {
            const invoice = await finalizeOutgoingInvoice(entity.id, c.req.param('id'));
            return c.json({ invoice });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
    });

    // ── Suggest the settling transaction (read, local store) ──────────────────────────────
    app.get('/api/invoices/:id/payment-candidates', async (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        try {
            return c.json({ candidates: await loadPaymentCandidates(entity.id, c.req.param('id')) });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 501);
        }
    });

    // ── Mark paid (self local) ────────────────────────────────────────────────────────────
    app.post('/api/invoices/:id/mark-paid', async (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        let body: { paidOn?: string; txId?: string } = {};
        try {
            body = await c.req.json();
        } catch {
            /* empty body is fine (defaults to today) */
        }
        try {
            const invoice = await markOutgoingInvoicePaid(entity.id, c.req.param('id'), {
                paidAt: body.paidOn,
                txId: body.txId,
            });
            return c.json({ invoice });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
    });

    // ── Delete a DRAFT (self local) ───────────────────────────────────────────────────────
    app.post('/api/invoices/:id/delete', async (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        try {
            await deleteOutgoingInvoiceDraft(entity.id, c.req.param('id'));
            return c.json({ ok: true });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
    });

    // ── Cancel via storno (self local) ────────────────────────────────────────────────────
    app.post('/api/invoices/:id/cancel', async (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        let body: { reason?: string } = {};
        try {
            body = await c.req.json();
        } catch {
            /* reason optional */
        }
        try {
            const result = await cancelOutgoingInvoice(entity.id, c.req.param('id'), { reason: body.reason });
            return c.json(result);
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
        }
    });
}
