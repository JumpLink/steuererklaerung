/**
 * Per-call refusal of German-tax-only tools for an entity whose tax module is off (ADR 0001).
 *
 * One server serves a mixed workspace — a German GbR next to a bookkeeping-only entity — so the
 * tools cannot be filtered at registration: `elster_gewst_report` is right for one entity and wrong
 * for the other. Instead each listed tool checks the entity of THIS call (`entity`, else the same
 * default the tool itself falls back to) and answers with a clear error. Mixed tools (EÜR report,
 * classification, bookings, invoices, the filing register) are not listed and keep working.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadManifest, resolveEntity } from '../../core/config/index.ts';
import { defaultEntityFor, findEntity } from '../../core/config/entities.ts';
import { requireTaxModule, type Capability } from '../../core/countries/index.ts';
import { mcpErrorFrom } from './types.ts';

/** Tool → the capability it needs. `elster_zve` defaults to the privat entity, the rest to the business one. */
export const TAX_ONLY_TOOLS: Readonly<Record<string, Capability>> = {
    elster_uste_report: 'vatReturn',
    elster_gewst_report: 'tradeTax',
    elster_feststellung_datenblatt: 'taxFiling',
    elster_stammdaten: 'taxFiling',
    elster_cross_checks: 'taxFiling',
    elster_period_status: 'taxFiling',
    elster_list_snapshots: 'taxFiling',
    create_filing_snapshot: 'taxFiling',
    record_web_filing: 'taxFiling',
    elster_signoff_status: 'taxFiling',
    sign_off_filing: 'taxFiling',
    revoke_signoff: 'taxFiling',
    elster_submit_readiness: 'electronicFiling',
    submit_filing: 'electronicFiling',
    elster_lock_period: 'taxFiling',
    elster_zve: 'incomeTax',
    record_filing: 'taxFiling',
};

/**
 * Throw a TaxModuleOffError when the tool is tax-only and the call's entity has the module off. An
 * unknown id or an unreadable manifest is left to the tool, which reports it in its own words.
 */
export function refuseTaxOnlyCall(tool: string, args: unknown): void {
    const capability = TAX_ONLY_TOOLS[tool];
    if (!capability) return;
    const wanted = (args as { entity?: unknown } | undefined)?.entity;
    let manifest;
    try {
        manifest = loadManifest();
    } catch {
        return;
    }
    const raw =
        typeof wanted === 'string' && wanted
            ? findEntity(manifest, wanted)
            : defaultEntityFor(manifest, tool === 'elster_zve' ? 'privat' : undefined);
    if (!raw) return;
    requireTaxModule(resolveEntity(manifest, raw.id), capability);
}

/** Wrap `server.registerTool` so every tax-only tool runs {@link refuseTaxOnlyCall} first. */
export function guardTaxOnlyTools(server: McpServer): void {
    const orig = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
    server.registerTool = ((name: string, config: unknown, cb: (...a: unknown[]) => unknown) => {
        if (!TAX_ONLY_TOOLS[name] || typeof cb !== 'function') return orig(name, config, cb);
        return orig(name, config, (...a: unknown[]) => {
            try {
                refuseTaxOnlyCall(name, a[0]);
            } catch (err) {
                return mcpErrorFrom(err);
            }
            return cb(...a);
        });
    }) as typeof server.registerTool;
}
