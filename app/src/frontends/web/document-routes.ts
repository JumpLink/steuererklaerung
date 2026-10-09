/**
 * Document (Belege) routes — DMS-agnostic over the per-entity {@link DmsProvider}.
 *
 * Reads (list/detail) come from the startup year-cache (no fetch in the handler). File bytes:
 * the built-in DMS is a local disk read → safe in the handler; Paperless is an outbound fetch
 * → deadlocks inside the GJS libsoup server, so it is downloaded on a fresh setTimeout(…,0)
 * tick into a short-lived byte cache that the client polls. Built-in writes (upload, AI
 * analyze) and the per-entity DMS settings also live here, each scheduling a cache rebuild.
 */

import type { Context, Hono } from 'hono';
import type { Cache } from '../../core/presenters/year-snapshot.ts';
import { recordClassificationDecision } from '../../core/actions/classifications.ts';
import { analyzeReceipt, storeReceipt } from '../../core/actions/documents.ts';
import { resolveYCReady, entityOf, type MetaInfo } from './routes.ts';
import { type DmsProvider, type DmsDocument, type AnalyzeResult } from '@steuererklaerung/dms';
import { filterDocuments } from '../../core/presenters/belege.ts';
import { loadEntityDms, saveEntityDms } from '../../core/config/index.ts';

export interface DocumentRouteDeps {
    cache: Cache;
    meta: MetaInfo;
    /** Per-(entity,year) readiness promises — the server serves before the cache is built. */
    cacheReady?: Map<string, Promise<void>>;
    dmsByEntity: Map<string, DmsProvider>;
    /** Rebuild one entity's provider from the manifest (after a DMS switch). */
    reloadDms: (entityId: string) => void;
    /** Rebuild ONLY one entity's cache (refreshes its documents + receipt joins after a write,
     * without re-fetching every other entity's Paperless data). */
    rebuildEntity: (entityId: string) => Promise<void>;
}

const MAX_UPLOAD_B64 = 30_000_000; // ≈ 22 MB raw

interface JobState {
    status: 'idle' | 'running' | 'done' | 'error';
    error?: string;
}

/**
 * Content-types that are safe to serve INLINE (the browser cannot execute script from them).
 * Everything else — notably text/html and image/svg+xml — is served as a forced download, so a
 * malicious "receipt" can never run script in the app's origin (stored-XSS guard).
 */
const SAFE_INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function registerDocumentRoutes(app: Hono, deps: DocumentRouteDeps): void {
    const { cache, meta, cacheReady, dmsByEntity } = deps;

    // Targeted, coalescing rebuild: each write enqueues its entity; one background job drains
    // the set (so concurrent uploads to different entities each get rebuilt, but Paperless data
    // for untouched entities is never re-fetched).
    const rebuild: JobState = { status: 'idle' };
    const pendingRebuild = new Set<string>();
    let rebuilding = false;
    const scheduleRebuild = (entityId: string) => {
        pendingRebuild.add(entityId);
        if (rebuilding) return;
        rebuilding = true;
        rebuild.status = 'running';
        rebuild.error = undefined;
        setTimeout(() => {
            void (async () => {
                try {
                    while (pendingRebuild.size) {
                        const id = pendingRebuild.values().next().value as string;
                        pendingRebuild.delete(id);
                        await deps.rebuildEntity(id);
                    }
                    rebuild.status = 'done';
                } catch (e) {
                    rebuild.status = 'error';
                    rebuild.error = e instanceof Error ? e.message : String(e);
                } finally {
                    rebuilding = false;
                }
            })();
        }, 0);
    };
    app.get('/api/documents/rebuild', (c) => c.json(rebuild));

    const providerFor = (c: Context): { entityId: string; provider: DmsProvider } | null => {
        const entity = entityOf(meta, c.req.query('entity'));
        const provider = entity ? dmsByEntity.get(entity.id) : undefined;
        return entity && provider ? { entityId: entity.id, provider } : null;
    };

    // ── List + search (pure cache read + in-handler filter) ─────────────────────────────
    app.get('/api/documents', async (c) => {
        const r = await resolveYCReady(cache, cacheReady, meta, c.req.query('entity'), c.req.query('year'));
        if ('error' in r) return c.json({ error: r.error }, 404);
        // The filter is the shared belege presenter's pure `filterDocuments`; the cache read + transport
        // stay here (the deadlock-safe rule keeps all outbound fetch out of the handler).
        const documents = filterDocuments(r.yc.documents as DmsDocument[], {
            query: c.req.query('query'),
            from: c.req.query('from'),
            to: c.req.query('to'),
            direction: c.req.query('direction'),
            linked: c.req.query('linked'),
        });
        return c.json({ dmsKind: r.yc.dmsKind, documents });
    });

    // ── Detail (cache read) ─────────────────────────────────────────────────────────────
    app.get('/api/documents/:id', async (c) => {
        const r = await resolveYCReady(cache, cacheReady, meta, c.req.query('entity'), c.req.query('year'));
        if ('error' in r) return c.json({ error: r.error }, 404);
        const doc = (r.yc.documents as DmsDocument[]).find((d) => d.id === c.req.param('id'));
        return doc ? c.json(doc) : c.json({ error: 'Dokument nicht gefunden.' }, 404);
    });

    // ── File bytes: built-in = disk (safe); Paperless = setTimeout job + byte cache + poll ─
    const fileCache = new Map<string, { bytes: Uint8Array; mimeType: string; at: number }>();
    const fileJobs = new Set<string>();
    // Serve known-safe types inline; force-download anything else (never inline-execute a
    // user-supplied file). `nosniff` stops the browser re-interpreting a mislabeled file.
    const fileHeaders = (mimeType: string, id: string) => {
        const safe = SAFE_INLINE.has(mimeType);
        return {
            'Content-Type': safe ? mimeType : 'application/octet-stream',
            'Content-Disposition': `${safe ? 'inline' : 'attachment'}; filename="${encodeURIComponent(id)}"`,
            'Cache-Control': 'private, max-age=300',
            'X-Content-Type-Options': 'nosniff',
        };
    };

    app.get('/api/documents/:id/file', async (c) => {
        const sel = providerFor(c);
        if (!sel) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        const id = c.req.param('id');
        if (sel.provider.kind === 'builtin') {
            const f = await sel.provider.getFile(id); // local disk read — no outbound fetch
            if (!f) return c.json({ error: 'Datei nicht gefunden.' }, 404);
            return new Response(new Uint8Array(f.bytes), { headers: fileHeaders(f.mimeType, id) });
        }
        // Paperless: outbound download must not run in the handler (libsoup deadlock).
        const key = `${sel.entityId}:${id}`;
        for (const [k, v] of fileCache) if (Date.now() - v.at > 300_000) fileCache.delete(k);
        const cached = fileCache.get(key);
        if (cached) return new Response(new Uint8Array(cached.bytes), { headers: fileHeaders(cached.mimeType, id) });
        if (!fileJobs.has(key)) {
            fileJobs.add(key);
            setTimeout(() => {
                void (async () => {
                    try {
                        const f = await sel.provider.getFile(id);
                        if (f) fileCache.set(key, { bytes: f.bytes, mimeType: f.mimeType, at: Date.now() });
                    } finally {
                        fileJobs.delete(key);
                    }
                })();
            }, 0);
        }
        return c.json({ status: 'preparing' }, 202);
    });

    // ── Thumbnail (card preview) — small image bytes. Built-in renders locally (image as-is,
    //    PDF first page via Poppler); Paperless ships a WebP thumb via an outbound fetch, so it
    //    runs on a background tick like /file. A null result is cached so the client stops polling.
    const thumbCache = new Map<string, { bytes: Uint8Array | null; mimeType: string; at: number }>();
    const thumbJobs = new Set<string>();
    const thumbHeaders = (mimeType: string) => ({
        'Content-Type': SAFE_INLINE.has(mimeType) ? mimeType : 'image/png',
        'Cache-Control': 'private, max-age=600',
        'X-Content-Type-Options': 'nosniff',
    });
    app.get('/api/documents/:id/thumbnail', async (c) => {
        const sel = providerFor(c);
        if (!sel || !sel.provider.getThumbnail) return c.json({ error: 'Keine Vorschau verfügbar.' }, 404);
        const id = c.req.param('id');
        const key = `${sel.entityId}:${id}`;
        for (const [k, v] of thumbCache) if (Date.now() - v.at > 600_000) thumbCache.delete(k);
        const cached = thumbCache.get(key);
        if (cached) {
            if (!cached.bytes) return c.json({ error: 'Keine Vorschau.' }, 404);
            return new Response(new Uint8Array(cached.bytes), { headers: thumbHeaders(cached.mimeType) });
        }
        if (sel.provider.kind === 'builtin') {
            // Local disk read + (for PDFs) a Poppler render — no outbound fetch → safe in-handler.
            const t = await sel.provider.getThumbnail(id);
            thumbCache.set(key, { bytes: t?.bytes ?? null, mimeType: t?.mimeType ?? '', at: Date.now() });
            if (!t) return c.json({ error: 'Keine Vorschau.' }, 404);
            return new Response(new Uint8Array(t.bytes), { headers: thumbHeaders(t.mimeType) });
        }
        // Paperless: the outbound thumb fetch must not run inside the handler (libsoup deadlock).
        if (!thumbJobs.has(key)) {
            thumbJobs.add(key);
            setTimeout(() => {
                void (async () => {
                    try {
                        const t = await sel.provider.getThumbnail!(id);
                        thumbCache.set(key, { bytes: t?.bytes ?? null, mimeType: t?.mimeType ?? '', at: Date.now() });
                    } catch {
                        thumbCache.set(key, { bytes: null, mimeType: '', at: Date.now() });
                    } finally {
                        thumbJobs.delete(key);
                    }
                })();
            }, 0);
        }
        return c.json({ status: 'preparing' }, 202);
    });

    // ── Upload (built-in DMS only) ──────────────────────────────────────────────────────
    app.post('/api/documents', async (c) => {
        const sel = providerFor(c);
        let body: { entity?: string; filename?: string; contentBase64?: string; mimeType?: string; linkTxId?: string };
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: 'Ungültiger Request-Body.' }, 400);
        }
        if (!sel) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        if (!body.contentBase64) return c.json({ error: 'Keine Datei übergeben.' }, 400);
        if (body.contentBase64.length > MAX_UPLOAD_B64) return c.json({ error: 'Datei zu groß (max. ~22 MB).' }, 413);
        try {
            // Every rule about WHAT may be stored and WHEN it is dated lives in the shared action,
            // so the native app cannot store a file this route would refuse. Only the transport
            // (base64 decode, status codes) stays here.
            const doc = await storeReceipt(sel.provider, {
                bytes: Buffer.from(body.contentBase64, 'base64'),
                filename: body.filename ?? 'beleg',
                mimeType: body.mimeType,
                viewYear: Number(c.req.query('year')) || undefined,
                linkTxId: body.linkTxId,
                entityId: sel.entityId,
            });
            scheduleRebuild(sel.entityId);
            return c.json({ ok: true, id: doc.id, rebuilding: true });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // ── Link a document to a store transaction (built-in DMS only) ──────────────────────
    app.post('/api/documents/:id/link', async (c) => {
        const sel = providerFor(c);
        let body: { txId?: string };
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: 'Ungültiger Request-Body.' }, 400);
        }
        const txId = String(body.txId ?? '');
        if (!sel || !sel.provider.link) return c.json({ error: 'Verknüpfen ist nur im eingebauten DMS möglich.' }, 400);
        if (!txId) return c.json({ error: 'Keine Buchung angegeben.' }, 400);
        try {
            await sel.provider.link(c.req.param('id'), txId);
            scheduleRebuild(sel.entityId);
            return c.json({ ok: true, rebuilding: true });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // ── Record a classification decision after linking (accept the AI reading, or override Kategorie) ──
    // recordClassificationDecision is a LOCAL SQLite write (ledger.db), NO outbound fetch → safe inline
    // in the handler (unlike the Paperless routes that defer + poll). Only the EÜR/USt recompute is
    // deferred via scheduleRebuild. category === undefined = ACCEPT (no override); a label = OVERRIDE.
    app.post('/api/documents/:id/decision', async (c) => {
        const sel = providerFor(c);
        if (!sel) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        let body: { txId?: string; category?: string; note?: string; aiNote?: string; aiNoteAccepted?: boolean };
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: 'Ungültiger Request-Body.' }, 400);
        }
        const txId = String(body.txId ?? '').trim();
        if (!txId) return c.json({ error: 'Keine Buchung angegeben.' }, 400);
        const documentId = Number.isFinite(Number(c.req.param('id'))) ? Number(c.req.param('id')) : null;
        try {
            recordClassificationDecision({
                transactionId: txId,
                category: body.category ?? undefined,
                note: body.note ?? undefined,
                aiNote: body.aiNote ?? undefined,
                aiNoteAccepted: body.aiNoteAccepted ?? true,
                documentId,
            });
            scheduleRebuild(sel.entityId);
            return c.json({ ok: true, rebuilding: true });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });

    // ── AI analyze (built-in DMS) — async job + poll, like the chat assistant ───────────
    interface AnalyzeJob extends JobState {
        result?: AnalyzeResult;
        at: number;
    }
    const analyzeJobs = new Map<string, AnalyzeJob>();
    let jobSeq = 0;

    app.post('/api/documents/analyze', async (c) => {
        const sel = providerFor(c);
        let body: { entity?: string; id?: string };
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: 'Ungültiger Request-Body.' }, 400);
        }
        if (!sel || sel.provider.kind !== 'builtin')
            return c.json({ error: 'KI-Analyse ist nur für das eingebaute DMS verfügbar.' }, 400);
        const id = String(body.id ?? '');
        if (!id) return c.json({ error: 'Kein Dokument angegeben.' }, 400);
        for (const [k, j] of analyzeJobs)
            if (j.status !== 'running' && Date.now() - j.at > 600_000) analyzeJobs.delete(k);
        const jobId = `${Date.now().toString(36)}-${jobSeq++}`;
        const job: AnalyzeJob = { status: 'running', at: Date.now() };
        analyzeJobs.set(jobId, job);
        setTimeout(() => {
            void (async () => {
                try {
                    job.result = await analyzeReceipt(sel.provider, id);
                    job.status = 'done';
                    job.at = Date.now();
                    scheduleRebuild(sel.entityId);
                } catch (e) {
                    job.status = 'error';
                    job.error = e instanceof Error ? e.message : String(e);
                    job.at = Date.now();
                }
            })();
        }, 0);
        return c.json({ jobId });
    });

    app.get('/api/documents/analyze/:jobId', (c) => {
        const job = analyzeJobs.get(c.req.param('jobId'));
        if (!job) return c.json({ error: 'Job unbekannt (abgelaufen?).' }, 404);
        return c.json(job);
    });

    // ── Per-entity DMS settings ─────────────────────────────────────────────────────────
    app.get('/api/entity-dms', (c) => {
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        return c.json(loadEntityDms(entity.id));
    });

    app.post('/api/entity-dms', async (c) => {
        let body: { type?: string; paperlessUrl?: string; paperlessToken?: string };
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: 'Ungültiger Request-Body.' }, 400);
        }
        const entity = entityOf(meta, c.req.query('entity'));
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        const type = body.type === 'paperless' ? 'paperless' : 'builtin';
        try {
            saveEntityDms(entity.id, { type, paperlessUrl: body.paperlessUrl, paperlessToken: body.paperlessToken });
            deps.reloadDms(entity.id); // switch the live provider before the rebuild reads it
            scheduleRebuild(entity.id);
            return c.json({ ok: true, rebuilding: true });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
    });
}
