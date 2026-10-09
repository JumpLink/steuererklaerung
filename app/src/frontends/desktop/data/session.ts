/**
 * The native app's single, long-lived {@link PresenterSession}.
 *
 * There is exactly one GTK process, so the session (AppContext + workspace probe + per-entity config /
 * DMS provider + memoized aggregate/documents builds) is created ONCE, lazily, and shared by the data
 * adapter (data/dms.ts) and the core presenters (belege/steuer/home/buchungen) the views call. This
 * replaces the per-view cache maps and the per-adapter workspace re-resolution those files carried before.
 */

import { createPresenterSession, type PresenterSession } from '../../../core/presenters/session.ts';

let session: PresenterSession | undefined;

/** The process-wide presenter session (built on first use). */
export function appSession(): PresenterSession {
    if (!session) session = createPresenterSession();
    return session;
}
