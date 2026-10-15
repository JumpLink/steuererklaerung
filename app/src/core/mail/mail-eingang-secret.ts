/**
 * The password of an entity's mail folder (Idee 15) — in the OS keyring, never in the manifest.
 *
 * Reached through the OS secret store (`core/secrets/store.ts`) like the ELSTER PIN
 * (`core/elster/pin.ts`), not through the libsecret GIR binding the SMTP password uses: CLI, MCP and
 * desktop must all read the SAME entry, and the store is the one route that works in every one of
 * them. The secret goes to the backend on stdin, so it never becomes an argument in the process list.
 *
 * Resolution order, most explicit first: the `STEUER_MAIL_EINGANG_PASSWORD` environment variable
 * (one shell, never stored — for a headless host without a keyring, the same shape as `ELSTER_PIN`),
 * then the keyring. A missing or locked keyring reads as "no password", never as an error.
 */

import { secretStore, type SecretRef } from '../secrets/store.ts';

const KEYRING_SERVICE = 'eu.jumplink.Steuererklaerung.MailEingang';

/** Where a resolved password came from — reported so a failure names the source that was used. */
export type MailPasswordSource = 'env' | 'keyring';

export interface ResolvedMailPassword {
    password: string;
    source: MailPasswordSource;
}

const ref = (entityId: string): SecretRef => ({ service: KEYRING_SERVICE, attribute: 'entity', id: entityId });

function fromKeyring(entityId: string): string | undefined {
    // No entry, no store, a locked keyring: all "not available here".
    return secretStore()?.get(ref(entityId));
}

/** The stored password, or null when there is none. */
export function lookupMailEingangPassword(entityId: string): ResolvedMailPassword | null {
    const env = process.env.STEUER_MAIL_EINGANG_PASSWORD;
    if (env) return { password: env, source: 'env' };
    const stored = fromKeyring(entityId);
    return stored ? { password: stored, source: 'keyring' } : null;
}

/** True when the keyring holds an entry (the environment variable does not count: it is not stored). */
export function hasStoredMailEingangPassword(entityId: string): boolean {
    return fromKeyring(entityId) !== undefined;
}

/** Store (or overwrite) the password. Returns false when there is no store or it refuses. */
export function storeMailEingangPassword(entityId: string, password: string): boolean {
    if (!password) return false;
    return secretStore()?.set(ref(entityId), password, 'Steuererklärung — Passwort des Belege-Postfachs') ?? false;
}

/** Forget the stored password. Idempotent. */
export function clearMailEingangPassword(entityId: string): void {
    secretStore()?.delete(ref(entityId));
}
