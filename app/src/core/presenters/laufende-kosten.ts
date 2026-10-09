/**
 * Laufende-Kosten presenter (Idee 8) — the detected series of one entity with the owner's decisions,
 * and the decision itself. Shared by the desktop tab (Buchungen → Laufende Kosten), the Übersicht task,
 * Frei verfügbar, the CLI `laufende-kosten` and the MCP tools.
 *
 * Detection runs over ALL of the entity's bookings (every year: a yearly insurance needs two), the
 * decisions live on the entity in the manifest (`laufende_kosten`). The rules are the pure
 * `elster/laufende-kosten.ts`; this module only loads and writes.
 *
 * Pure TS (core + `@steuererklaerung/*` only) — no gi://, GTK/Adwaita, DOM, Hono, yargs or zod.
 */

import { searchAccountKeys } from '@steuererklaerung/store';
import { loadLaufendeKostenEntscheidungen, saveLaufendeKostenEntscheidung } from '../config/index.ts';
import {
    laufendeKostenUebersicht,
    type LaufendeKosten,
    type LaufendeKostenUebersicht,
    type SerienAbstand,
} from '../elster/laufende-kosten.ts';
import type { PresenterSession } from './session.ts';
import type { EntityModel } from './workspace.ts';

export type { LaufendeKosten, LaufendeKostenUebersicht } from '../elster/laufende-kosten.ts';

/** The entity's series, split into proposals, confirmed, rejected and ended. */
export function loadLaufendeKosten(_session: PresenterSession, entity: EntityModel): LaufendeKostenUebersicht {
    const buchungen = searchAccountKeys(entity.accountKeys, {});
    return laufendeKostenUebersicht(buchungen, loadLaufendeKostenEntscheidungen(entity.id));
}

/** How many proposals wait for a decision — the Übersicht counter. */
export function countLaufendeKostenOffen(session: PresenterSession, entity: EntityModel): number {
    return loadLaufendeKosten(session, entity).vorschlaege.length;
}

export type LkEntscheidungInput =
    | { status: 'bestaetigt'; abstand?: SerienAbstand; betrag?: number }
    | { status: 'abgelehnt' | 'beendet' }
    /** Take the decision back: the series is a proposal again. */
    | { status: 'vorschlag' };

/**
 * Decide on one series by key. Recomputes the series first, so only a key that is detected NOW can be
 * decided — a stale or mistyped key is refused with the known ones. A correction is stored only when
 * it differs from what was detected.
 */
export function entscheideLaufendeKosten(
    session: PresenterSession,
    entity: EntityModel,
    key: string,
    e: LkEntscheidungInput,
    opts: { today?: string } = {},
): { ok: true; key: string; status: LkEntscheidungInput['status']; serie: LaufendeKosten } {
    const u = loadLaufendeKosten(session, entity);
    const alle = [...u.vorschlaege, ...u.bestaetigt, ...u.abgelehnt, ...u.beendet];
    const serie = alle.find((k) => k.key === key);
    if (!serie) {
        throw new Error(
            `Keine laufenden Kosten „${key}" für ${entity.name}. Erkannt: ${alle.map((k) => k.key).join(', ') || '—'}`,
        );
    }
    if (e.status === 'vorschlag') {
        saveLaufendeKostenEntscheidung(entity.id, key, null);
    } else {
        if (e.status === 'bestaetigt' && e.betrag != null && !(e.betrag > 0)) {
            throw new Error('Der Betrag muss größer als 0 sein.');
        }
        const abstand = e.status === 'bestaetigt' && e.abstand !== serie.erkannterAbstand ? e.abstand : undefined;
        const betrag =
            e.status === 'bestaetigt' &&
            e.betrag != null &&
            Math.round(e.betrag * 100) !== Math.round(serie.letzterBetrag * 100)
                ? e.betrag
                : undefined;
        saveLaufendeKostenEntscheidung(entity.id, key, {
            key,
            status: e.status,
            ...(abstand ? { abstand } : {}),
            ...(betrag != null ? { betrag } : {}),
            entschieden_am: opts.today ?? new Date().toISOString().slice(0, 10),
        });
    }
    const nach = loadLaufendeKosten(session, entity);
    const neu = [...nach.vorschlaege, ...nach.bestaetigt, ...nach.abgelehnt, ...nach.beendet].find(
        (k) => k.key === key,
    )!;
    return { ok: true, key, status: e.status, serie: neu };
}
