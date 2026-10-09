/**
 * The password of an entity's SMTP account, in the OS secret store (GNOME Keyring via libsecret).
 *
 * The rest of the account (host, port, user, sender) is not secret and lives in the manifest; the
 * password never does. One entry per workspace entity (attribute `entity`). A missing or locked
 * keyring reads as "no stored password" and the dialog asks for it.
 */

import { entitySchema, secret } from './libsecret.ts';

const SCHEMA_NAME = 'eu.jumplink.Steuererklaerung.MailPassword';
const LABEL = 'Steuererklärung — Passwort des Mail-Versandkontos';

/** Store (or overwrite) the mail password for an entity. Returns false if the keyring is unavailable. */
export function storeMailPassword(entityId: string, password: string): boolean {
    const s = secret();
    if (!s || !password) return false;
    try {
        return s.password_store_sync(
            entitySchema(s, SCHEMA_NAME),
            { entity: entityId },
            s.COLLECTION_DEFAULT,
            LABEL,
            password,
            null,
        );
    } catch {
        return false;
    }
}

/** The stored mail password for an entity, or null when none / unavailable. */
export function lookupMailPassword(entityId: string): string | null {
    const s = secret();
    if (!s) return null;
    try {
        return s.password_lookup_sync(entitySchema(s, SCHEMA_NAME), { entity: entityId }, null) || null;
    } catch {
        return null;
    }
}

/** Forget the stored mail password for an entity. */
export function clearMailPassword(entityId: string): boolean {
    const s = secret();
    if (!s) return false;
    try {
        return s.password_clear_sync(entitySchema(s, SCHEMA_NAME), { entity: entityId }, null);
    } catch {
        return false;
    }
}
