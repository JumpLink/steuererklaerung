/**
 * Resolve what the sync needs to know about an entity from the manifest. Kept apart from plan.ts so
 * the planning stays free of config reads.
 */

import { loadEntityInvoicing } from '../config/index.ts';
import type { SyncEntityInfo } from './plan.ts';

export function syncEntityInfo(entityId: string, dmsKind: 'builtin' | 'paperless', path?: string): SyncEntityInfo {
    const view = loadEntityInvoicing(entityId, path);
    return {
        id: entityId,
        hasQontoAccount: view.qontoAccount,
        invoicingViaQonto: view.type === 'qonto',
        usesPaperless: dmsKind === 'paperless',
    };
}
