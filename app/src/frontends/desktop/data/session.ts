/**
 * The native app's single, long-lived {@link PresenterSession}.
 *
 * There is exactly one GTK process, so the session (AppContext + workspace probe + per-entity config /
 * DMS provider + memoized aggregate/documents builds) is created ONCE, lazily, and shared by the data
 * adapter (data/dms.ts) and the core presenters (belege/steuer/home/buchungen) the views call. This
 * replaces the per-view cache maps and the per-adapter workspace re-resolution those files carried before.
 */

import { createPresenterSession, type PresenterSession } from '../../../core/presenters/session.ts';

import { readClientIfStarted } from '../read/index.ts';

let session: PresenterSession | undefined;

/** The process-wide presenter session (built on first use). */
export function appSession(): PresenterSession {
    if (!session) session = forwardingWrites(createPresenterSession());
    return session;
}

/**
 * The reads run in the read worker with their own memos, so a write here has to drop those too:
 * `invalidate` and `reloadDms` are forwarded to the worker as well as applied to this session.
 */
function forwardingWrites(base: PresenterSession): PresenterSession {
    return {
        ...base,
        invalidate(entityId?: string, year?: number): void {
            base.invalidate(entityId, year);
            readClientIfStarted()?.invalidate(entityId, year);
        },
        reloadDms(entityId: string): void {
            base.reloadDms(entityId);
            readClientIfStarted()?.reloadDms(entityId);
        },
    };
}
