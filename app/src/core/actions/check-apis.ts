/**
 * "Sind die Anbindungen erreichbar?" — the one probe, and its result as DATA.
 *
 * It used to print to the console and return a boolean, which made it a CLI feature by
 * construction: the App and the web UI could call it and learn only "everything is fine" or
 * "something is not". That is exactly the wrong shape for the question a user is actually asking
 * when they typed a Paperless URL and nothing appeared — they need to know WHICH back-end is
 * unhappy and what it said.
 *
 * So the action returns the per-service results and the CLI does the printing. Same probes, same
 * order; the console output is unchanged.
 */

import type { ApiCheckResult } from '@steuererklaerung/shared';
import { checkFinTS, checkInwx, checkPaperless, checkQonto } from '../clients/index.ts';
import type { CheckApisArgs } from '../types/index.ts';

export type { ApiCheckResult };

export interface ApiCheckReport {
    /** One entry per back-end, in a stable order so a UI can render a fixed list. */
    services: ApiCheckResult[];
    /** True when every probe succeeded — the CLI's exit condition, unchanged. */
    ok: boolean;
}

/**
 * Probe every configured back-end.
 *
 * Runs them concurrently: they are independent, and a slow or hanging one must not delay the
 * verdict on the others — the whole point is to say which of them is the problem. Each client's
 * own timeout bounds it, so this cannot hang overall.
 */
export async function checkApiConnections(): Promise<ApiCheckReport> {
    const services = await Promise.all([checkQonto(), checkPaperless(), checkInwx(), checkFinTS()]);
    return { services, ok: services.every((r) => r.ok) };
}

/**
 * The CLI's view: print one line per service and answer with the overall verdict.
 *
 * Kept as-is so `steuer check-apis` behaves exactly as before — this is a smoke test people run
 * from scripts, and changing its output would be changing an interface.
 */
export async function checkApis(_args: CheckApisArgs): Promise<boolean> {
    const { services, ok } = await checkApiConnections();
    for (const r of services) {
        console.log(`${r.ok ? '✓' : '✗'} ${r.name}: ${r.message ?? ''}`);
    }
    return ok;
}
