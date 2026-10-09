/**
 * Recurring outgoing-invoice routes: the reminder dashboard, the per-entity invoicing back-end
 * settings, and the "create draft" action. Reads (dashboard, settings) come straight from local
 * JSON — safe in the handler. Creating a draft hits the Qonto API (an OUTBOUND fetch, which
 * deadlocks inside the running GJS libsoup server), so it runs on a deferred setTimeout tick as a
 * polled job — exactly like the chat + document-analyze routes.
 */

import type { Hono } from 'hono';
import { entityOf, type MetaInfo } from './routes.ts';
import { type IssuerConfig, loadEntityInvoicing, saveEntityInvoicing } from '../../core/config/index.ts';
import { createRecurringInvoiceDraft, recurringDashboard } from '../../core/actions/recurring-invoices.ts';
import { loadOutgoingInvoices } from '../../core/presenters/rechnungen.ts';
import type { CreateRecurringResult } from '../../core/actions/recurring-invoices.ts';
import type { OutgoingInvoiceSummary } from '../../core/invoices/provider.ts';

export interface RecurringRouteDeps {
    meta: MetaInfo;
}

interface CreateJob {
    status: 'running' | 'done' | 'error';
    result?: CreateRecurringResult;
    error?: string;
}

interface ListJob {
    status: 'running' | 'done' | 'error';
    invoices?: OutgoingInvoiceSummary[];
    error?: string;
}

let jobSeq = 0;

export function registerRecurringRoutes(app: Hono, deps: RecurringRouteDeps): void {
    const { meta } = deps;
    const jobs = new Map<string, CreateJob>();
    const listJobs = new Map<string, ListJob>();

    // ── Reminder dashboard (overdue + soon-due + upcoming) ──────────────────────────────
    app.get('/api/recurring', (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        const today = c.req.query('today') || undefined;
        const actionableOnly = c.req.query('due') === '1';
        try {
            const entries = recurringDashboard({ entityId: entity?.id, today, actionableOnly });
            return c.json({ entries });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // ── Per-entity invoicing back-end settings ──────────────────────────────────────────
    app.get('/api/entity-invoicing', (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        return c.json(loadEntityInvoicing(entity.id));
    });

    app.post('/api/entity-invoicing', async (c) => {
        let body: {
            type?: string;
            iban?: string;
            paymentTermsDays?: number;
            selfNumberPrefix?: string;
            selfIssuer?: IssuerConfig;
        };
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: 'Ungültiger Request-Body.' }, 400);
        }
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        const type = body.type === 'self' ? 'self' : 'qonto';
        try {
            saveEntityInvoicing(entity.id, {
                type,
                iban: body.iban,
                paymentTermsDays: body.paymentTermsDays,
                selfNumberPrefix: body.selfNumberPrefix,
                selfIssuer: body.selfIssuer,
            });
            return c.json({ ok: true });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // ── Create a DRAFT invoice for one schedule (outbound → deferred polled job) ─────────
    app.post('/api/recurring/:id/create', (c) => {
        const id = c.req.param('id');
        const dryRun = c.req.query('dryRun') === '1';
        const jobId = `rec-${++jobSeq}`;
        jobs.set(jobId, { status: 'running' });
        setTimeout(() => {
            void (async () => {
                try {
                    const result = await createRecurringInvoiceDraft(id, { dryRun });
                    jobs.set(jobId, { status: 'done', result });
                } catch (e) {
                    jobs.set(jobId, { status: 'error', error: e instanceof Error ? e.message : String(e) });
                }
            })();
        }, 0);
        return c.json({ jobId });
    });

    app.get('/api/recurring/create/:jobId', (c) => {
        const job = jobs.get(c.req.param('jobId'));
        if (!job) return c.json({ error: 'Job unbekannt (abgelaufen?).' }, 404);
        return c.json(job);
    });

    // ── List all issued invoices for the entity's back-end (outbound → deferred polled job) ──
    // The Qonto list call is an OUTBOUND fetch, which deadlocks inside the running libsoup
    // server, so it runs on a deferred setTimeout tick and is polled — same shape as create.
    app.post('/api/invoices', (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        const status = c.req.query('status') || undefined;
        const jobId = `inv-${++jobSeq}`;
        listJobs.set(jobId, { status: 'running' });
        setTimeout(() => {
            void (async () => {
                try {
                    const invoices = await loadOutgoingInvoices(entity.id, status);
                    listJobs.set(jobId, { status: 'done', invoices });
                } catch (e) {
                    listJobs.set(jobId, { status: 'error', error: e instanceof Error ? e.message : String(e) });
                }
            })();
        }, 0);
        return c.json({ jobId });
    });

    app.get('/api/invoices/:jobId', (c) => {
        const job = listJobs.get(c.req.param('jobId'));
        if (!job) return c.json({ error: 'Job unbekannt (abgelaufen?).' }, 404);
        return c.json(job);
    });
}
