/**
 * The entity's DMS provider (builtin = local SQLite, Paperless = outbound), via the shared
 * {@link PresenterSession} — which owns one provider per entity and absorbs the former
 * per-view workspace re-resolution. Kept as a thin adapter so its callers (the Belege list, the
 * Assistent's year-cache build, the decisions leaf) need no change.
 */

import type { DmsProvider } from '@steuererklaerung/dms';
import { appSession } from './session.ts';
import type { AppEntity } from '../entities.ts';

/** The DMS back-end the given entity is configured for (built-in by default, else Paperless). */
export function dmsProviderFor(entity: AppEntity): DmsProvider {
    return appSession().dms(entity);
}
