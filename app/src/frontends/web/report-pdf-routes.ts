/**
 * Server-side PDF export for the tax-return review datasheets (Steuererklärungs-Prüf-Datenblatt).
 * Renders the SAME cairo/Pango PDF the CLI writes with `elster … report --pdf`, from the startup
 * cache — no outbound fetch. Rendering is local CPU + a temp file (like the invoice PDF route in
 * invoice-routes.ts), so it is safe to run synchronously inside the libsoup handler.
 */

import type { Hono } from 'hono';
import { resolveYCReady, type MetaInfo } from './routes.ts';
import type { Cache, YearCache } from '../../core/presenters/year-snapshot.ts';
import type { ElsterConfig } from '../../core/config/index.ts';
import { pdfRenderingAvailable, renderSteuerblattPdf, type SteuerblattModel } from '@steuererklaerung/invoice-pdf';
import {
    euerToSteuerblatt,
    usteToSteuerblatt,
    gewstToSteuerblatt,
    feststellungToSteuerblatt,
} from '../../core/actions/elster/steuerblatt-pdf.ts';
import type { EuerTxAggregate } from '../../core/elster/euer-transactions.ts';
import type { UsteAggregate } from '../../core/elster/uste-aggregate.ts';
import type { GewstReport } from '../../core/actions/elster/gewst.ts';
import type { FeststellungReport } from '../../core/actions/elster/feststellung.ts';

export interface ReportPdfRouteDeps {
    cache: Cache;
    meta: MetaInfo;
    /** Per-(entity,year) readiness promises — the server serves before the cache is built. */
    cacheReady?: Map<string, Promise<void>>;
    elsterByEntity: Map<string, ElsterConfig | undefined>;
}

/** The four year-report datasheets exposed as `/api/<kind>/pdf`. */
type ReportKind = 'euer' | 'uste' | 'gewst' | 'feststellung';

/** Build the SteuerblattModel for one report from its cached data. Returns null when the cache
 * field is empty (entity without ELSTER data for that report). */
function buildModel(kind: ReportKind, yc: YearCache, elster: ElsterConfig, year: number): SteuerblattModel | null {
    switch (kind) {
        case 'euer': {
            const euer = yc.euer as { aggregate: EuerTxAggregate } | null;
            return euer ? euerToSteuerblatt(euer.aggregate, elster) : null;
        }
        case 'uste':
            return yc.uste ? usteToSteuerblatt(yc.uste as UsteAggregate, elster) : null;
        case 'gewst':
            return yc.gewst ? gewstToSteuerblatt(yc.gewst as GewstReport, elster, year) : null;
        case 'feststellung':
            return yc.feststellung ? feststellungToSteuerblatt(yc.feststellung as FeststellungReport, elster) : null;
    }
}

export function registerReportPdfRoutes(app: Hono, deps: ReportPdfRouteDeps): void {
    const { cache, meta, cacheReady, elsterByEntity } = deps;

    for (const kind of ['euer', 'uste', 'gewst', 'feststellung'] as const) {
        app.get(`/api/${kind}/pdf`, async (c) => {
            const r = await resolveYCReady(cache, cacheReady, meta, c.req.query('entity'), c.req.query('year'));
            if ('error' in r) return c.json({ error: r.error }, 404);
            const elster = elsterByEntity.get(r.entity.id);
            if (!elster) return c.json({ error: 'Nicht verfügbar — diese Entität hat keine ELSTER-Config.' }, 503);
            if (!pdfRenderingAvailable()) {
                return c.json({ error: 'PDF-Rendering benötigt die GJS-Laufzeit (Cairo/Pango).' }, 501);
            }
            try {
                const model = buildModel(kind, r.yc, elster, r.year);
                if (!model) return c.json({ error: 'Für diese Erklärung liegen keine Daten vor.' }, 503);
                const bytes = await renderSteuerblattPdf(model);
                const filename = `${kind}-${r.entity.id}-${r.year}-pruefblatt.pdf`;
                return new Response(new Uint8Array(bytes), {
                    headers: {
                        'Content-Type': 'application/pdf',
                        'Content-Disposition': `inline; filename="${encodeURIComponent(filename)}"`,
                        'X-Content-Type-Options': 'nosniff',
                    },
                });
            } catch (e) {
                return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
            }
        });
    }
}
