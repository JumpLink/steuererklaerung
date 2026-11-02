/**
 * The read worker: the only place in the app process that reads the ledger for the pages it serves.
 *
 * The GTK main thread holds no read connection — a SQLite read plus the EÜR aggregation over a few
 * thousand bookings is hundreds of milliseconds, and that is a window that has stopped repainting.
 * Here it runs on a second thread with its own presenter session (own memo caches, own connection),
 * and answers through Comlink. Writes stay on the main thread and tell this session to drop its memos
 * through `invalidate`.
 *
 * Thin on purpose: every query lives in queries.ts. The built file is `reader.worker.<ext>` beside the
 * app bundle — the gjsify bundler rewrites the `new Worker(new URL(…))` in channel.ts to it.
 */

// First, for its side effect: binds the catalogue before any other module is evaluated, so the texts
// the core builds in this thread (Hinweise, error messages) are translated. No GTK is initialised.
import '../i18n-init.ts';

import * as Comlink from 'comlink';
import { createPresenterSession, type PresenterSession } from '../../../core/presenters/session.ts';
import { guard, type ReadApi } from './protocol.ts';
import { auswertungenQuery, freiVerfuegbarQuery, homeQuery } from './queries.ts';

let session: PresenterSession | undefined;
const sess = (): PresenterSession => (session ??= createPresenterSession());

const api: ReadApi = {
    home: (entity, year) => guard(() => homeQuery(sess(), entity, year)),
    freiVerfuegbar: (entity, year) => guard(() => freiVerfuegbarQuery(sess(), entity, year)),
    auswertungen: (entity, year) => guard(() => auswertungenQuery(sess(), entity, year)),
    invalidate: async (entityId, year) => {
        session?.invalidate(entityId, year);
    },
    reloadDms: async (entityId) => {
        session?.reloadDms(entityId);
    },
    ping: async () => 'pong',
};

Comlink.expose(api);
