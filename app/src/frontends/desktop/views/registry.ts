/**
 * Registry of native views, keyed by nav view id (see nav.ts).
 *
 * The v2 IA (9 entries): some — steuer, review, transactions and rechnungen — are tab hubs that host the former
 * standalone views (see tab-hub.ts); auswertungen is one stacked screen (BWA + Einblicke). The
 * window consults this map to build each nav row's content; an id without a factory falls back to a
 * placeholder status page.
 */

import type { ViewFactory } from '../view.ts';
import { BhHomeView } from './home-view.ts';
import { BhKontakteView } from './kontakte-view.ts';
import { BhProjekteView } from './projekte-view.ts';
import { BhZeitenView } from './zeiten-view.ts';
import { BhFristenView } from './fristen-view.ts';
import { BhKontenView } from './konten-view.ts';
import { BhEinstellungenView } from './einstellungen-view.ts';
import { BhAuswertungenView } from './auswertungen-view.ts';
import { makeBuchungenHub, makeRechnungenHub, makeReviewHub, makeSteuerHub } from './tab-hub.ts';

export const VIEW_FACTORIES: Record<string, ViewFactory> = {
    home: () => new BhHomeView(),
    review: makeReviewHub,
    transactions: makeBuchungenHub,
    rechnungen: makeRechnungenHub,
    zeiten: () => new BhZeitenView(),
    kontakte: () => new BhKontakteView(),
    auswertungen: () => new BhAuswertungenView(),
    fristen: () => new BhFristenView(),
    steuer: makeSteuerHub,
    projekte: () => new BhProjekteView(),
    konten: () => new BhKontenView(),
    settings: () => new BhEinstellungenView(),
};
