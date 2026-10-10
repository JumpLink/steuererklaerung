/**
 * Read-only review web server (Hono on GJS via @gjsify/http).
 *
 * Multi-entity: a workspace manifest (steuererklaerung.json) lists the firms (GbR ·
 * Einzelunternehmen · Privat) and which store accounts belong to each. Data is fetched
 * ONCE at startup (before `serve()`) into a per-(entity,year) cache — see data.ts for
 * why (outbound libsoup fetch deadlocks inside the running GJS server). Without a
 * manifest the server falls back to a single default entity (its prior behaviour).
 *
 * Serves the built frontend (dist/web) + the cache as JSON. Bound to 127.0.0.1 (the UI
 * surfaces figures + partner Steuer-IdNr — never exposed). Awaits forever so the GJS
 * GLib loop (index.ts) keeps serving, like the MCP stdio server.
 */

import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { isDemoMode } from '../../core/config/demo.ts';
import { ensureDemoSeeded } from '../cli/demo.ts';
import type { ElsterConfig } from '../../core/config/index.ts';
import type { EstConfig } from '../../core/config/index.ts';
import { loadAppSettings } from '../../core/config/index.ts';
import { createPresenterSession } from '../../core/presenters/session.ts';
import { toEntityAccounts } from '../../core/presenters/konten.ts';
import type { EntityModel } from '../../core/presenters/workspace.ts';
import { buildYearCache, type Cache } from '../../core/presenters/year-snapshot.ts';
import { listOpenItems, type OpenItem } from '../../core/actions/fristen.ts';
import { listSteuertermine } from '../../core/actions/steuertermine.ts';
import { listOffeneSteuerzahlungen } from '../../core/actions/steuerzahlungen.ts';
import { aggregateUstvaYear, type UstvaYearQuarter } from '../../core/elster/ustva-aggregate.ts';
import { vorsteuerKorrekturenDesJahres } from '../../core/actions/erstattungen.ts';
import { buildUstvaPortalUpload } from '../../core/elster/ustva-xml.ts';
import {
    evaluateCrossChecks,
    summarizeCrossChecks,
    type CrossCheckInputs,
} from '../../core/actions/elster/cross-checks.ts';
import { describeMcpTools, type McpGroupTools } from '../mcp/server.ts';
import { registerApiRoutes, type EntityMeta, type MetaInfo } from './routes.ts';
import { registerAccountRoutes } from './account-routes.ts';
import { registerDocumentRoutes } from './document-routes.ts';
import { registerRecurringRoutes } from './recurring-routes.ts';
import { registerInvoiceRoutes } from './invoice-routes.ts';
import { registerContactsRoutes } from './contacts-routes.ts';
import { registerReportPdfRoutes } from './report-pdf-routes.ts';
import type { DmsProvider } from '@steuererklaerung/dms';

export interface StartWebServerOptions {
    port?: number;
    host?: string;
    years?: number[];
}

export async function startWebServer(options: StartWebServerOptions = {}): Promise<void> {
    const { port = 3000, host = '127.0.0.1' } = options;
    // In --demo mode, make sure the shipped demo workspace is fully populated
    // (contacts/invoices/Belege, not just the auto-imported NDJSON transactions)
    // so the review + invoice views aren't empty out of the box.
    await ensureDemoSeeded();

    // The shared presenter session owns the entity/year probe, the per-entity ELSTER/ESt config
    // loading, and the per-entity DMS provider (the former loadEntityElster / loadEntityEst /
    // makeDmsProvider + candidateYears / entityYearsWithData blocks all live in core now). `--years`
    // is forwarded to the probe; without it the workspace model probes the last ~8 years.
    const session = createPresenterSession({ years: options.years });
    const ctx = session.ctx;
    const workspace = session.workspace;
    const entities: EntityModel[] = workspace.entities;

    // Prefetch BEFORE the server listens (outbound fetch must not run inside serve()).
    const cache: Cache = new Map();
    const elsterByEntity = new Map<string, ElsterConfig | undefined>(entities.map((e) => [e.id, session.elster(e.id)]));
    const estByEntity = new Map<string, EstConfig | undefined>(entities.map((e) => [e.id, session.est(e.id)]));
    // One DMS provider per entity, per its configured back-end (built-in by default; gbr keeps
    // Paperless via env). Sourced from the session (the single seam the cache + document routes
    // build against); kept as a map so those route signatures stay unchanged.
    const dmsByEntity = new Map<string, DmsProvider>(entities.map((e) => [e.id, session.dms(e.id)]));
    /** Rebuild one entity's provider from the (re-read) manifest — so a DMS switch in the
     * settings takes effect live, before the subsequent cache rebuild. */
    const reloadDms = (entityId: string): void => {
        session.reloadDms(entityId);
        dmsByEntity.set(entityId, session.dms(entityId));
    };
    const entityMetas: EntityMeta[] = entities.map((entity) => ({
        id: entity.id,
        name: entity.name,
        kind: entity.kind,
        hasElster: entity.hasElster,
        hasEst: entity.hasEst,
        taxModule: entity.taxModule,
        years: entity.years,
        defaultYear: entity.defaultYear,
        // Only the COUNT reaches the browser — never the IBAN-bearing account keys.
        accountCount: entity.accountKeys.length,
        demo: entity.demo,
    }));

    // USt-VA + "Fristen & offene Posten" are filled in a BACKGROUND pass after serve() (see bottom):
    // pre-fetching them in the blocking startup made it slow, and a Paperless fetch inside a request
    // handler would deadlock libsoup. The routes await the fill promise, so the first open shows a
    // spinner rather than stale/empty data.
    let openItems: OpenItem[] = [];
    let openItemsFill: Promise<void> = Promise.resolve();
    // Per-(entity,year) USt-VA, filled in the background (newest year first) so opening a recent
    // quarter's tab waits only for its own fill, not every historical year.
    const ustvaCache = new Map<string, UstvaYearQuarter[]>();
    const ustvaReady = new Map<string, Promise<void>>();
    const ustvaResolve = new Map<string, () => void>();

    /**
     * (Re)build the per-(entity,year) cache from the current store — at startup and after a
     * write. Builds into a fresh map and swaps it in synchronously, so a concurrent request
     * never observes an empty/partial cache mid-rebuild (and a mid-rebuild throw can't wipe it).
     */
    const fillCache = async (): Promise<void> => {
        const next: Cache = new Map();
        for (const entity of entities) {
            const elster = elsterByEntity.get(entity.id);
            const dms = dmsByEntity.get(entity.id) as DmsProvider;
            const estCfg = estByEntity.get(entity.id);
            for (const y of entity.years) {
                next.set(
                    `${entity.id}:${y}`,
                    await buildYearCache(ctx.config, elster, y, entity.accountKeys, dms, estCfg, entity.id),
                );
            }
        }
        cache.clear(); // synchronous swap (no await between) — readers never see a partial map
        for (const [k, v] of next) cache.set(k, v);
    };

    /**
     * Rebuild ONLY one entity's (entity×year) cache entries, in place. Used after a built-in
     * document write so a single upload doesn't re-fetch every other entity's Paperless data
     * (the full fillCache fetches gbr's Paperless ~80 s). Map.set is atomic per key, so readers
     * of other entities are untouched and the affected key flips old→new, never partial.
     */
    const rebuildEntity = async (entityId: string): Promise<void> => {
        const entity = entities.find((e) => e.id === entityId);
        if (!entity) return;
        const elster = elsterByEntity.get(entity.id);
        const dms = dmsByEntity.get(entity.id) as DmsProvider;
        const estCfg = estByEntity.get(entity.id);
        for (const y of entity.years) {
            cache.set(
                `${entity.id}:${y}`,
                await buildYearCache(ctx.config, elster, y, entity.accountKeys, dms, estCfg, entity.id),
            );
        }
    };
    // Default to the first entity that actually has data, else the first listed (from the model).
    const defaultEntity = workspace.defaultEntity;

    // Per-(entity, year-with-data) readiness — the server now serves IMMEDIATELY and fills the cache
    // in the background (default entity + newest years first), instead of blocking startup for minutes
    // on every year's Paperless fetch. A request for a not-yet-filled year awaits its promise (via
    // resolveYCReady) → the first open shows a spinner, then the data; everything else is instant.
    const cacheReady = new Map<string, Promise<void>>();
    const cacheResolve = new Map<string, () => void>();
    const fillKeys = entities.flatMap((entity) => entity.years.map((y) => ({ entity, year: y })));
    for (const { entity, year: y } of fillKeys) {
        const key = `${entity.id}:${y}`;
        cacheReady.set(key, new Promise<void>((res) => cacheResolve.set(key, res)));
    }
    /** Build one (entity, year) into the cache and release any request waiting on it. */
    const buildOne = async (entity: EntityModel, y: number): Promise<void> => {
        const key = `${entity.id}:${y}`;
        try {
            const elster = elsterByEntity.get(entity.id);
            const dms = dmsByEntity.get(entity.id) as DmsProvider;
            const estCfg = estByEntity.get(entity.id);
            cache.set(key, await buildYearCache(ctx.config, elster, y, entity.accountKeys, dms, estCfg, entity.id));
        } catch (err) {
            console.error(`[web] ${key} konnte nicht geladen werden: ${err instanceof Error ? err.message : err}`);
        } finally {
            cacheResolve.get(key)?.();
        }
    };
    for (const e of entityMetas) console.error(`[web] ${e.id}: Jahre ${e.years.join(', ') || '—'} (Hintergrund-Fill)`);

    // In demo mode the workspace is the fictional app/demo one (builtin DMS) — never surface the
    // developer's real Paperless URL in the shipped demo's meta.
    const paperlessUrl = isDemoMode()
        ? null
        : (process.env.PAPERLESS_BASE_URL ?? '').replace(/\/api\/?$/, '').replace(/\/$/, '') || null;
    const meta: MetaInfo = { entities: entityMetas, defaultEntity, paperlessUrl };

    const settings = loadAppSettings(); // mutable: the settings UI updates it at runtime

    // The full MCP tool catalogue (every group's tools + descriptions), computed once for
    // the settings UI. Independent of the enabled/allowWrite toggles.
    let mcpCatalog: McpGroupTools[] = [];
    try {
        mcpCatalog = describeMcpTools(ctx);
    } catch (err) {
        console.error(`[web] MCP tool catalogue unavailable: ${err instanceof Error ? err.message : err}`);
    }

    // USt-VA fill order: newest entity-years first (the ones actually reviewed). Deferred readiness
    // promises are created now so the /api/ustva route can await a specific key.
    const ustvaKeys = entities
        .flatMap((entity) => {
            const elster = elsterByEntity.get(entity.id);
            return elster ? entity.years.map((y) => ({ entity, elster, year: y })) : [];
        })
        .sort((a, b) => b.year - a.year);
    for (const k of ustvaKeys) {
        const key = `${k.entity.id}:${k.year}`;
        ustvaReady.set(key, new Promise<void>((res) => ustvaResolve.set(key, res)));
    }

    const app = new Hono();
    registerApiRoutes(app, cache, meta, settings, mcpCatalog, cacheReady);
    // Served from the background fill (below); await so the first request waits for the fill instead
    // of seeing empty data.
    app.get('/api/open-items', async (c) => {
        await openItemsFill;
        return c.json(openItems);
    });
    // Proactive Steuertermine: pure local config reads (no Paperless fetch) → safe to compute
    // inside the handler, no background fill needed. Fresh each call so a config edit shows up.
    app.get('/api/steuertermine', (c) => c.json(listSteuertermine()));
    // Open tax payments: local register + config reads only → same doctrine as /api/steuertermine.
    app.get('/api/steuerzahlungen', (c) => c.json(listOffeneSteuerzahlungen()));
    app.get('/api/ustva', async (c) => {
        const entityId = c.req.query('entity') ?? '';
        const elster = elsterByEntity.get(entityId);
        if (!elster) return c.json({ error: 'Nicht verfügbar — diese Entität hat keine ELSTER-Config.' }, 503);
        const key = `${entityId}:${Number(c.req.query('year'))}`;
        await ustvaReady.get(key); // undefined for an unknown key → resolves immediately → []
        return c.json(ustvaCache.get(key) ?? []);
    });
    // The USt-VA "Mein ELSTER XML-Import" file for one quarter: the plain <Anmeldungssteuern>
    // ISO-8859-15 XML (buildUstvaPortalUpload), served from the READ-ONLY ustvaCache — no outbound
    // fetch in the handler (deadlock-safe rule). The only ELSTER form Mein ELSTER accepts as XML.
    app.get('/api/ustva/xml', async (c) => {
        const entityId = c.req.query('entity') ?? '';
        const elster = elsterByEntity.get(entityId);
        if (!elster) return c.json({ error: 'Nicht verfügbar — diese Entität hat keine ELSTER-Config.' }, 503);
        const year = Number(c.req.query('year'));
        const quarter = Number(c.req.query('quarter'));
        const key = `${entityId}:${year}`;
        await ustvaReady.get(key);
        const q = (ustvaCache.get(key) ?? []).find((x) => x.quarter === quarter);
        if (!q) return c.json({ error: 'Für dieses Quartal liegen keine Daten vor.' }, 503);
        if (q.missingBmfRates.length > 0) {
            return c.json({ error: 'Fehlende BMF-Umrechnungskurse — mit `bmf-kurse import` ergänzen.' }, 409);
        }
        const { filename, bytes } = buildUstvaPortalUpload(q.aggregate, elster, year, quarter);
        return new Response(new Uint8Array(bytes), {
            headers: {
                'Content-Type': 'application/xml; charset=ISO-8859-15',
                'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
                'X-Content-Type-Options': 'nosniff',
            },
        });
    });
    // Machine Querprüfungen for the Steuererklärung Gegenprüfung step. Assembles CrossCheckInputs from
    // the READ-ONLY startup caches (no outbound fetch in the handler — the deadlock-safe rule): the EÜR
    // aggregate / USt-Jahr / Steuerkonto / Feststellung from the year cache, the quarterly USt-VA from
    // ustvaCache. Runs the PURE evaluator (not the I/O computeCrossChecks).
    app.get('/api/crosschecks', async (c) => {
        const entityId = c.req.query('entity') ?? '';
        const elster = elsterByEntity.get(entityId);
        // A privat/ESt entity (no ELSTER) has no report reconciliation → an empty, clean result.
        if (!elster) return c.json({ checks: [], summary: summarizeCrossChecks([]) });
        const year = Number(c.req.query('year'));
        const key = `${entityId}:${year}`;
        await ustvaReady.get(key); // ensures the main cache + USt-VA fill for this key are done
        const yc = cache.get(key);
        if (!yc) return c.json({ checks: [], summary: summarizeCrossChecks([]) });
        const isPrivat = entityId === 'privat';
        const inputs: CrossCheckInputs = {
            year,
            entityLabel: entityId,
            hasUst: !isPrivat,
            hasFeststellung: (elster.gesellschafter?.length ?? 0) > 0 && !isPrivat,
            euer: (yc.euer as { aggregate: CrossCheckInputs['euer'] } | null)?.aggregate,
            uste: yc.uste as CrossCheckInputs['uste'],
            steuerkonto: yc.steuerkonto as CrossCheckInputs['steuerkonto'],
            feststellungProfit: (yc.feststellung as { result: { totalProfit: number } } | null)?.result.totalProfit,
            ustvaQuarters: ustvaCache.get(key),
        };
        const checks = evaluateCrossChecks(inputs);
        return c.json({ checks, summary: summarizeCrossChecks(checks) });
    });
    registerAccountRoutes(app, {
        entities: toEntityAccounts(entities),
        rebuildCache: fillCache,
    });
    registerDocumentRoutes(app, {
        cache,
        meta,
        cacheReady,
        dmsByEntity,
        reloadDms,
        rebuildEntity,
    });
    registerRecurringRoutes(app, { meta });
    registerInvoiceRoutes(app, { meta });
    registerContactsRoutes(app, { meta });
    registerReportPdfRoutes(app, { cache, meta, cacheReady, elsterByEntity });
    app.use('/*', serveStatic({ root: './dist/web' }));

    serve({ fetch: app.fetch, port, hostname: host }, (info) => {
        console.error(
            `[web] steuererklaerung review UI on http://${host}:${info.port} — Entitäten: ${entityMetas.map((e) => e.id).join(', ')}`,
        );
    });

    // Background fills (server already listening; started HERE, outside any request handler, so the
    // outbound Paperless fetches can't deadlock libsoup). ORDER MATTERS: the main per-(entity,year)
    // cache fill runs FIRST and alone (default entity + newest years first) so it isn't slowed by the
    // secondary fetches competing for libsoup's handful of connections; only THEN do the USt-VA +
    // open-items fills run. Each key resolves its readiness promise as it lands → a request for a
    // not-yet-filled key waits (a spinner) instead of erroring; everything else is available at once.
    void (async () => {
        const ordered = [...fillKeys].sort(
            (a, b) =>
                (a.entity.id === defaultEntity ? 0 : 1) - (b.entity.id === defaultEntity ? 0 : 1) || b.year - a.year,
        );
        for (const { entity, year: y } of ordered) await buildOne(entity, y);
        console.error('[web] Cache-Fill fertig.');

        // Secondary fills (USt-VA per entity-year + the open-items list) — deferred to after the main
        // cache so they don't contend for connections. The /api/ustva + /api/open-items routes await these.
        openItemsFill = listOpenItems()
            .then((r) => {
                openItems = r;
            })
            .catch((err) => console.error(`[web] open-items fill failed: ${err instanceof Error ? err.message : err}`));
        for (const k of ustvaKeys) {
            const key = `${k.entity.id}:${k.year}`;
            try {
                ustvaCache.set(
                    key,
                    await aggregateUstvaYear(k.elster, k.year, vorsteuerKorrekturenDesJahres(k.elster, k.year)),
                );
            } catch (err) {
                console.error(`[web] USt-VA ${key} fill failed: ${err instanceof Error ? err.message : err}`);
            }
            ustvaResolve.get(key)?.();
        }
        console.error('[web] USt-VA-Hintergrund-Fill fertig.');
    })();

    await new Promise<never>(() => {});
}
