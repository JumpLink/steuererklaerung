/**
 * Where a fetch of the mail folder resumes (Idee 15) — the UID bookkeeping, pure.
 *
 * IMAP gives every message of a folder a UID that only grows, and a UIDVALIDITY that names the
 * numbering. As long as the validity is the one stored, "everything above the highest UID I
 * processed" is exactly the new mail. When the server reports another validity (the folder was
 * rebuilt, restored, moved to another server) the stored UIDs mean nothing: the fetch starts over
 * from 0, and the content hash of the DMS keeps what was already imported from landing twice.
 */

import type { MailEingangState } from '@steuererklaerung/store';

export interface AbrufPlan {
    /** Fetch the messages with a UID above this. */
    since: number;
    /** True when stored UIDs were discarded because the numbering changed. */
    neuNummeriert: boolean;
    /** True when nothing was stored yet (a first run takes what is in the folder). */
    ersterAbruf: boolean;
}

export function planeAbruf(
    state: Pick<MailEingangState, 'uidValidity' | 'lastUid'> | null,
    folder: { uidValidity: number; uidNext: number | null },
): AbrufPlan {
    if (!state || state.uidValidity == null) return { since: 0, neuNummeriert: false, ersterAbruf: true };
    // A UIDNEXT at or below the stored UID means the server hands out numbers it already used.
    const regressed = folder.uidNext != null && state.lastUid >= folder.uidNext;
    if (state.uidValidity !== folder.uidValidity || regressed) {
        return { since: 0, neuNummeriert: true, ersterAbruf: false };
    }
    return { since: state.lastUid, neuNummeriert: false, ersterAbruf: false };
}

/** Loopback hosts — the only ones a connection without TLS may go to. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/** What is wrong with a configuration, in German, or null. Refuses a plain connection to a remote host. */
export function pruefeMailEingang(config: { host: string; security: 'tls' | 'none' }): string | null {
    if (config.security === 'none' && !LOOPBACK.has(config.host.trim().toLowerCase())) {
        return 'Ohne Verschlüsselung geht es nur zu einem Server auf diesem Rechner — sonst liefe das Passwort offen durchs Netz.';
    }
    return null;
}
