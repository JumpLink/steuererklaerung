/**
 * The single place that turns an entity's DMS configuration into a live {@link DmsProvider}:
 * the outbound Paperless-ngx provider when the entity selects it, otherwise the built-in local
 * SQLite DMS. Shared by the presenter session (`presenters/session.ts` `buildDms`), the
 * self-invoicing provider (`invoices/self-provider.ts`) and the link-candidate resolver
 * (`actions/link-candidates.ts`) — so the `paperless ? Paperless : Builtin` decision lives ONCE.
 *
 * Pure: the caller supplies the already-resolved entity `dms` config and the Paperless `SyncConfig`
 * (from the AppContext / manifest), so this module stays free of config-loading side effects.
 */

import { BuiltinDmsProvider, PaperlessDmsProvider, type DmsProvider } from '@steuererklaerung/dms';
import type { EntityDmsConfig } from './config/schema/entity.ts';
import type { SyncConfig } from './config/schema/paperless.ts';

/**
 * Build the DMS provider an entity is configured for. `dms` undefined / `{ type: 'builtin' }` →
 * the built-in SQLite DMS keyed by `entityId`; `{ type: 'paperless' }` → a Paperless provider on
 * the given `paperlessConfig`.
 */
export function dmsProviderForEntity(
    entityId: string,
    dms: EntityDmsConfig | undefined,
    paperlessConfig: SyncConfig,
): DmsProvider {
    if (dms?.type === 'paperless') return new PaperlessDmsProvider(paperlessConfig, dms.paperless);
    return new BuiltinDmsProvider(entityId);
}
