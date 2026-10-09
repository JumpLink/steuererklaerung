/**
 * Runners for demo mode. The demo data set carries a `qonto:` account, and the Qonto credentials
 * are global (.env) — a real runner would call the real API from a demo window. These only wait.
 */

import type { SyncSource } from './plan.ts';
import type { SyncRunner } from './service.ts';

export function createDemoRunners(delayMs = 4000): Record<SyncSource, SyncRunner> {
    const wait: SyncRunner = async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        return { changed: false };
    };
    return { 'qonto-invoices': wait, 'qonto-transactions': wait, paperless: wait };
}
