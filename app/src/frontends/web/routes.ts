/**
 * Read-only JSON API. Serves from the startup cache (see data.ts) — the handlers do
 * NO outbound fetch (that deadlocks inside the GJS libsoup server). Pure cache reads,
 * keyed by `${entity}:${year}`.
 */

import type { Context, Hono } from 'hono';
import type { Cache, YearCache } from '../../core/presenters/year-snapshot.ts';
import { type AppSettings, saveAppSettings, parseAppSettings } from '../../core/config/index.ts';
import { applyProposal, type EstIntakeProposal } from '../../core/actions/elster/est-intake-topics.ts';
import type { McpGroupTools } from '../mcp/server.ts';
import { TaxModuleOffError, capabilities, type Capability } from '../../core/countries/index.ts';
export type { McpGroupTools, McpToolInfo } from '../mcp/server.ts';

/** One firm in the workspace (for the UI entity switcher). */
export interface EntityMeta {
    id: string;
    name: string;
    kind: string;
    hasElster: boolean;
    /** True for a `privat` entity with a loadable ESt config → the Einkommensteuer view. */
    hasEst: boolean;
    /** The entity's tax module (ADR 0001); `none` = bookkeeping only, every tax view hidden. */
    taxModule: 'de' | 'none';
    /** Years that were actually loaded (have data) for this entity. */
    years: number[];
    defaultYear: number;
    accountCount: number;
    /** True for the fictional demo entity — the client shows a persistent "Demodaten" banner. */
    demo?: boolean;
}

export interface MetaInfo {
    entities: EntityMeta[];
    defaultEntity: string;
    paperlessUrl: string | null;
}

/** Resolve an entity id to its meta (falling back to the default entity). */
export function entityOf(meta: MetaInfo, id: string | undefined): EntityMeta | undefined {
    return meta.entities.find((e) => e.id === id) ?? meta.entities.find((e) => e.id === meta.defaultEntity);
}

export type ResolvedYC = { entity: EntityMeta; year: number; yc: YearCache };

/**
 * Shared entity+year → year-cache lookup, used by every read endpoint (routes.ts) and the
 * document routes — keeps the resolution and its error messages consistent.
 */
export function resolveYC(
    cache: Cache,
    meta: MetaInfo,
    entityId: string | undefined,
    yearRaw: unknown,
): ResolvedYC | { error: string } {
    const entity = entityOf(meta, entityId);
    if (!entity) return { error: 'Keine Entität konfiguriert.' };
    const year = Number(yearRaw) || entity.defaultYear;
    const yc = cache.get(`${entity.id}:${year}`);
    if (!yc)
        return {
            error: `${entity.name}: Jahr ${year} ist nicht geladen (keine Daten oder Server ohne dieses Jahr gestartet).`,
        };
    return { entity, year, yc };
}

/**
 * Like {@link resolveYC}, but first awaits the background fill of the requested (entity, year) —
 * the server now serves BEFORE the cache is built, so a request may arrive while its year is still
 * loading. `ready` holds one promise per (entity, year) key that resolves when its cache entry is in;
 * an absent key (unknown/no-data year) resolves immediately to the sync "nicht geladen" error.
 */
/** API keys that only exist under the German tax module, with the capability each needs (ADR 0001). */
const TAX_ONLY_KEYS: Partial<Record<keyof YearCache, Capability>> = {
    uste: 'vatReturn',
    gewst: 'tradeTax',
    feststellung: 'taxFiling',
    wizard: 'incomeTax',
    est: 'incomeTax',
    steuerkonto: 'taxAccount',
};

/** The refusal message when `key` is a tax-only route and the entity has that feature off, else null. */
export function taxOffError(entity: EntityMeta, key: string): string | null {
    const capability = TAX_ONLY_KEYS[key as keyof typeof TAX_ONLY_KEYS];
    if (!capability || capabilities(entity)[capability]) return null;
    return new TaxModuleOffError(entity.id, capability).message;
}

export async function resolveYCReady(
    cache: Cache,
    ready: Map<string, Promise<void>> | undefined,
    meta: MetaInfo,
    entityId: string | undefined,
    yearRaw: unknown,
): Promise<ResolvedYC | { error: string }> {
    const entity = entityOf(meta, entityId);
    if (entity && ready) {
        const year = Number(yearRaw) || entity.defaultYear;
        await ready.get(`${entity.id}:${year}`);
    }
    return resolveYC(cache, meta, entityId, yearRaw);
}

export function registerApiRoutes(
    app: Hono,
    cache: Cache,
    meta: MetaInfo,
    settings: AppSettings,
    mcpCatalog: McpGroupTools[] = [],
    cacheReady?: Map<string, Promise<void>>,
): void {
    // `assistant` is dynamic (the settings UI can toggle it at runtime).
    app.get('/api/meta', (c) => c.json({ ...meta, assistant: settings.assistant.enabled }));

    // The full MCP tool catalogue (every group's tools + descriptions) for the settings UI.
    app.get('/api/mcp-tools', (c) => c.json(mcpCatalog));

    // Read + write the app settings (assistant on/off, externally-exposed MCP groups,
    // write access). The POST persists to steuererklaerung.json AND updates the in-memory copy
    // so the assistant toggle takes effect immediately (MCP changes apply on the MCP
    // server's next start — it is a separate process).
    app.get('/api/settings', (c) => c.json(settings));
    app.post('/api/settings', async (c) => {
        let body: unknown;
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: 'Ungültiger Request-Body.' }, 400);
        }
        let next: AppSettings;
        try {
            next = parseAppSettings(body);
        } catch (err) {
            return c.json({ error: `Ungültige Einstellungen: ${err instanceof Error ? err.message : err}` }, 400);
        }
        try {
            saveAppSettings(next);
        } catch (err) {
            return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
        settings.assistant = next.assistant;
        settings.mcp = next.mcp;
        return c.json(settings);
    });

    const rYC = (entityId: string | undefined, yearRaw: unknown) =>
        resolveYCReady(cache, cacheReady, meta, entityId, yearRaw);

    const pick = (key: keyof YearCache) => async (c: Context) => {
        const r = await rYC(c.req.query('entity'), c.req.query('year'));
        if ('error' in r) return c.json({ error: r.error }, 404);
        const off = taxOffError(r.entity, key);
        if (off) return c.json({ error: off }, 403);
        const v = r.yc[key];
        if (v == null) return c.json({ error: 'Nicht verfügbar — diese Entität hat keine ELSTER-Config.' }, 503);
        return c.json(v);
    };

    app.get('/api/transactions', pick('transactions'));
    app.get('/api/reconciliation', pick('reconciliation'));
    app.get('/api/euer', pick('euer'));
    app.get('/api/bwa', pick('bwa'));
    app.get('/api/uste', pick('uste'));
    app.get('/api/gewst', pick('gewst'));
    app.get('/api/feststellung', pick('feststellung'));
    app.get('/api/wizard', pick('wizard'));
    app.get('/api/est', pick('est'));
    app.get('/api/dashboard', pick('dashboard'));
    app.get('/api/home', pick('home'));
    app.get('/api/hinweise', pick('hinweise'));
    app.get('/api/steuerkonto', pick('steuerkonto'));

    // ── KI-Assistent: async job + poll ──────────────────────────────────────────────
    // The LLM call is scheduled with setTimeout(…,0) so it runs on a FRESH main-loop tick,
    // never nested inside this request handler → it avoids the libsoup-in-handler deadlock
    // and works whether the provider is subprocess- (Claude Agent SDK) or fetch-based. The
    // POST returns a job id; the client polls GET /api/chat/:id (a pure cache read).
    interface ChatJob {
        status: 'pending' | 'done' | 'error';
        answer?: string;
        /** Intake proposals the assistant previewed — the client renders them as approve cards. */
        proposals?: EstIntakeProposal[];
        error?: string;
        /** Creation/completion timestamp (ms) for the TTL sweep. */
        at?: number;
    }
    const jobs = new Map<string, ChatJob>();
    let jobSeq = 0;
    const now = () => Date.now();

    app.post('/api/chat', async (c) => {
        if (!settings.assistant.enabled) return c.json({ error: 'Der integrierte Assistent ist deaktiviert.' }, 403);
        let body: { entity?: string; year?: number; question?: string };
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: 'Ungültiger Request-Body.' }, 400);
        }
        const question = String(body.question ?? '').trim();
        if (!question) return c.json({ error: 'Keine Frage.' }, 400);
        const r = await rYC(body.entity, body.year);
        if ('error' in r) return c.json({ error: r.error }, 404);
        const { entity, year, yc } = r;

        // Free finished jobs older than 10 min, then bound the map (avoids dropping a still-
        // pending job when many requests arrive at once).
        for (const [k, j] of jobs) if (j.status !== 'pending' && now() - (j.at ?? 0) > 600_000) jobs.delete(k);
        const id = `${Date.now().toString(36)}-${jobSeq++}`;
        jobs.set(id, { status: 'pending', at: now() });

        setTimeout(() => {
            void (async () => {
                try {
                    const { answer } = await import('../../core/actions/assistant/chat.ts');
                    const result = await answer(question, yc, entity, year);
                    jobs.set(id, { status: 'done', answer: result.text, proposals: result.proposals, at: now() });
                } catch (err) {
                    jobs.set(id, {
                        status: 'error',
                        error: err instanceof Error ? err.message : String(err),
                        at: now(),
                    });
                }
            })();
        }, 0);

        return c.json({ jobId: id });
    });

    app.get('/api/chat/:id', (c) => {
        const job = jobs.get(c.req.param('id'));
        if (!job) return c.json({ error: 'Job unbekannt (abgelaufen?).' }, 404);
        return c.json(job);
    });

    // Approve-to-apply: persist an intake proposal the assistant previewed (the „Übernehmen" click).
    // GATED — only an entity with an ESt config; the write goes through the SAME applyProposal() the
    // native assistant panel uses (entityId/year from the server scope, not the proposal). The write is
    // persisted to steuererklaerung.json immediately. NOTE: the web ESt views read the plan from the startup
    // YearCache (yc.wizard), so they reflect the change only after a restart — a safe in-session rebuild
    // needs the setTimeout(0) job pattern (a Paperless fetch in a handler deadlocks libsoup) and is a
    // separate follow-up. The NATIVE app refreshes its est snapshot live (window.refreshEstAfterApply).
    app.post('/api/est-intake/apply', async (c) => {
        if (!settings.assistant.enabled) return c.json({ error: 'Der integrierte Assistent ist deaktiviert.' }, 403);
        let body: { entity?: string; year?: number; proposal?: EstIntakeProposal };
        try {
            body = await c.req.json();
        } catch {
            return c.json({ error: 'Ungültiger Request-Body.' }, 400);
        }
        const entity = entityOf(meta, body.entity);
        if (!entity) return c.json({ error: 'Keine Entität konfiguriert.' }, 404);
        if (!entity.hasEst) return c.json({ error: `${entity.name} hat keine ESt-Konfiguration.` }, 400);
        const proposal = body.proposal;
        if (!proposal?.topicId) return c.json({ error: 'Kein Vorschlag übergeben.' }, 400);
        const year = Number(body.year) || entity.defaultYear;
        try {
            const v = applyProposal(proposal, { entityId: entity.id, year });
            return c.json({ ergebnis: v.ergebnis, hinweise: v.hinweise });
        } catch (err) {
            return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
    });
}
