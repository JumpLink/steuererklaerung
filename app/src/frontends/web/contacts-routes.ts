/**
 * Contacts (parties) routes: list/create/update/delete read & write the local SQLite store (safe in
 * the handler — no network), while `import` PULLS from Qonto/Paperless and therefore runs on a
 * deferred setTimeout job (outbound fetch deadlocks inside the running GJS libsoup server), polled
 * exactly like the recurring-create + chat routes.
 */

import type { Hono } from 'hono';
import { entityOf, type MetaInfo } from './routes.ts';
import type { ContactInput } from '@steuererklaerung/store';
import {
    importContacts,
    type ImportContactsResult,
    listEntityContacts,
    removeContact,
    saveContact,
} from '../../core/actions/contacts.ts';

export interface ContactsRouteDeps {
    meta: MetaInfo;
}

interface ImportJob {
    status: 'running' | 'done' | 'error';
    result?: ImportContactsResult;
    error?: string;
}

let jobSeq = 0;

/** Build a ContactInput from a request body, forcing the entity from the query. */
function bodyToInput(entityId: string, body: Record<string, unknown>): ContactInput {
    const str = (v: unknown): string | null | undefined =>
        v === undefined ? undefined : v === null ? null : String(v);
    return {
        id: typeof body.id === 'string' ? body.id : undefined,
        entityId,
        kind: body.kind as ContactInput['kind'],
        name: str(body.name),
        firstName: str(body.firstName),
        lastName: str(body.lastName),
        email: str(body.email),
        vatNumber: str(body.vatNumber),
        taxId: str(body.taxId),
        iban: str(body.iban),
        currency: typeof body.currency === 'string' ? body.currency : undefined,
        locale: typeof body.locale === 'string' ? body.locale : undefined,
        address: str(body.address),
        zip: str(body.zip),
        city: str(body.city),
        countryCode: str(body.countryCode),
        isCustomer: typeof body.isCustomer === 'boolean' ? body.isCustomer : undefined,
        isSupplier: typeof body.isSupplier === 'boolean' ? body.isSupplier : undefined,
        notes: str(body.notes),
    };
}

export function registerContactsRoutes(app: Hono, deps: ContactsRouteDeps): void {
    const { meta } = deps;
    const importJobs = new Map<string, ImportJob>();

    // ── List ────────────────────────────────────────────────────────────────────────────
    app.get('/api/contacts', (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        try {
            return c.json({ contacts: listEntityContacts(entity.id) });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // ── Create / update (local write, no network) ─────────────────────────────────────────
    app.post('/api/contacts', async (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        let body: Record<string, unknown>;
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: 'Ungültiger Request-Body.' }, 400);
        }
        try {
            const contact = saveContact(bodyToInput(entity.id, body));
            return c.json({ contact });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // ── Delete ────────────────────────────────────────────────────────────────────────────
    app.post('/api/contacts/:id/delete', (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        try {
            removeContact(entity.id, c.req.param('id'));
            return c.json({ ok: true });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // ── Import from Qonto/Paperless (outbound → deferred polled job) ───────────────────────
    app.post('/api/contacts/import', (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        const jobId = `cimp-${++jobSeq}`;
        importJobs.set(jobId, { status: 'running' });
        setTimeout(() => {
            void (async () => {
                try {
                    const result = await importContacts({ entityId: entity.id });
                    importJobs.set(jobId, { status: 'done', result });
                } catch (e) {
                    importJobs.set(jobId, { status: 'error', error: e instanceof Error ? e.message : String(e) });
                }
            })();
        }, 0);
        return c.json({ jobId });
    });

    app.get('/api/contacts/import/:jobId', (c) => {
        const job = importJobs.get(c.req.param('jobId'));
        if (!job) return c.json({ error: 'Job unbekannt (abgelaufen?).' }, 404);
        return c.json(job);
    });
}
