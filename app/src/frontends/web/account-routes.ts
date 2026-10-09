/**
 * Account-connection routes (the web UI's write path): list connections, import an export
 * file, disconnect an account. All three are pure filesystem/SQLite → safe in the handler.
 * After a mutation the startup year-cache is stale, so a cache rebuild is scheduled on a
 * fresh tick (it does Paperless fetches → must run OUTSIDE the request handler); the client
 * polls GET /api/accounts/rebuild.
 */

import type { Hono } from 'hono';
import { type AccountSyncReport, syncTransactions } from '../../core/actions/transactions.ts';
import {
    type EntityAccounts,
    type FintsConnect,
    type ImportFormat,
    type QontoConnect,
    type RemoveMode,
    connectFints,
    connectQonto,
    detectFormat,
    listConnections,
    removeConnection,
    runImport,
} from '../../core/actions/accounts.ts';

export interface AccountRouteDeps {
    entities: EntityAccounts[];
    /** Re-run the startup cache build (refreshes the tax/EÜR views after a mutation). */
    rebuildCache: () => Promise<void>;
}

interface JobState {
    status: 'idle' | 'running' | 'done' | 'error';
    error?: string;
}

/** Run `fn` on a FRESH tick (outside the request handler → no libsoup deadlock), tracking state. */
function runJob(state: JobState, fn: () => Promise<void>): void {
    state.status = 'running';
    state.error = undefined;
    setTimeout(() => {
        void (async () => {
            try {
                await fn();
                state.status = 'done';
            } catch (e) {
                state.status = 'error';
                state.error = e instanceof Error ? e.message : String(e);
            }
        })();
    }, 0);
}

/** Sanity cap for an uploaded export (base64 chars ≈ 22 MB raw). */
const MAX_UPLOAD_B64 = 30_000_000;

export function registerAccountRoutes(app: Hono, deps: AccountRouteDeps): void {
    const rebuild: JobState = { status: 'idle' };
    const scheduleRebuild = () => {
        if (rebuild.status !== 'running') runJob(rebuild, () => deps.rebuildCache());
    };

    app.get('/api/accounts', (c) => c.json(listConnections(deps.entities)));
    app.get('/api/accounts/rebuild', (c) => c.json(rebuild));

    app.post('/api/accounts/import', async (c) => {
        let body: { format?: ImportFormat; filename?: string; contentBase64?: string; full?: boolean };
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: 'Ungültiger Request-Body.' }, 400);
        }
        const format = body.format ?? (body.filename ? detectFormat(body.filename) : null);
        if (!format) return c.json({ error: 'Format unbekannt — bitte ein Format wählen.' }, 400);
        if (!body.contentBase64) return c.json({ error: 'Keine Datei übergeben.' }, 400);
        if (body.contentBase64.length > MAX_UPLOAD_B64) return c.json({ error: 'Datei zu groß (max. ~22 MB).' }, 413);
        try {
            const bytes = Buffer.from(body.contentBase64, 'base64');
            const result = await runImport(format, body.filename ?? 'upload', bytes, { full: body.full });
            scheduleRebuild();
            return c.json({ ...result, rebuilding: true });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    app.post('/api/accounts/remove', async (c) => {
        let body: { accountKey?: string; mode?: RemoveMode };
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: 'Ungültiger Request-Body.' }, 400);
        }
        if (!body.accountKey) return c.json({ error: 'Kein Konto angegeben.' }, 400);
        const mode: RemoveMode = body.mode === 'stop-sync' ? 'stop-sync' : 'delete-all';
        try {
            const r = await removeConnection(body.accountKey, mode);
            if (mode === 'delete-all') scheduleRebuild();
            return c.json({ ...r, rebuilding: mode === 'delete-all' });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // ── Live connections: save credentials (.env / fints-config.json) ──────────────────
    app.post('/api/accounts/connect/qonto', async (c) => {
        let b: Partial<QontoConnect>;
        try {
            b = await c.req.json();
        } catch {
            return c.json({ error: 'Ungültiger Request-Body.' }, 400);
        }
        if (!b.login || !b.secretKey) return c.json({ error: 'Login und SecretKey sind erforderlich.' }, 400);
        try {
            return c.json({ ok: true, ...connectQonto(b as QontoConnect) });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    app.post('/api/accounts/connect/fints', async (c) => {
        let b: Partial<FintsConnect>;
        try {
            b = await c.req.json();
        } catch {
            return c.json({ error: 'Ungültiger Request-Body.' }, 400);
        }
        if (!b.name || !b.url || !b.blz || !b.user_id || !b.product_id || !b.pin)
            return c.json({ error: 'Name, URL, BLZ, Benutzer, Produkt-ID und PIN sind erforderlich.' }, 400);
        try {
            return c.json({ ok: true, ...connectFints(b as FintsConnect) });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // ── Live sync: network → must run OUTSIDE the request handler (setTimeout job) ──────
    const sync: JobState & { reports: AccountSyncReport[] } = { status: 'idle', reports: [] };
    app.get('/api/accounts/sync', (c) => c.json(sync));
    app.post('/api/accounts/sync', async (c) => {
        if (sync.status === 'running') return c.json({ error: 'Ein Sync läuft bereits.' }, 409);
        let body: { account?: string } = {};
        try {
            body = await c.req.json();
        } catch {
            /* no body → sync all */
        }
        sync.reports = [];
        runJob(sync, async () => {
            const { reports } = await syncTransactions(body.account ? { account: body.account } : {});
            sync.reports = reports;
            scheduleRebuild(); // new transactions → refresh the tax views
        });
        return c.json({ started: true });
    });
}
