/**
 * ELSTER keystore-PIN storage in the OS secret store (GNOME Keyring via libsecret).
 *
 * The certificate PATH is not secret and lives in the ELSTER config (`keystore_path`); the PIN is
 * secret and — when the user opts in — is kept here, encrypted, unlocked with their login session,
 * NEVER in plaintext config. This is a native-desktop concern: it reaches libsecret through GJS'
 * GObject-Introspection (`imports.gi.Secret`, the system `Secret-1` typelib), guarded so a missing/
 * locked keyring degrades to "no stored PIN" instead of throwing — the user just types the PIN.
 *
 * One entry per workspace entity (attribute `entity` = gbr|jumplink|privat), so each entity's
 * certificate can carry its own PIN.
 */

import { secretStore, type SecretRef } from '../../../core/secrets/store.ts';
import { entitySchema, secret, type SecretApi, type SecretSchema } from './libsecret.ts';

const SCHEMA_NAME = 'eu.jumplink.Steuererklaerung.ElsterPin';
const LABEL = 'Steuererklärung — ELSTER-Zertifikats-PIN';

/**
 * The schema name used before the project was renamed from `buchhaltung` to `steuererklaerung`.
 * libsecret looks entries up by schema name + attributes, so a PIN stored by the old build is
 * invisible to the new one — it would silently look like "no PIN saved" and the user would be
 * asked to type it again with no explanation. It is READ as a fallback; new writes and deletes
 * use the current schema, and a delete clears both so "forget my PIN" really forgets it.
 */
const LEGACY_SCHEMA_NAME = 'eu.jumplink.Buchhaltung.ElsterPin';

function schemaFor(s: SecretApi, name: string = SCHEMA_NAME): SecretSchema {
    return entitySchema(s, name);
}

/**
 * Without the libsecret typelib (macOS, Windows, a Linux without it) the OS store from
 * `core/secrets/store.ts` takes over: macOS Keychain, Windows DPAPI.
 */
const ref = (entityId: string): SecretRef => ({ service: SCHEMA_NAME, attribute: 'entity', id: entityId });

/** Whether a secret store is reachable (⇒ offering to save the PIN makes sense). */
export function keyringAvailable(): boolean {
    return secret() !== null || secretStore() !== null;
}

/** One sentence for the UI: where a saved PIN goes and how it is protected. Empty when nowhere. */
export function keyringNote(): string {
    if (secret()) return 'Verschlüsselt im GNOME-Schlüsselbund, nie im Klartext.';
    const store = secretStore();
    return store ? `Gespeichert ${store.description}.` : '';
}

/** Store (or overwrite) the ELSTER PIN for an entity in the keyring. Returns false if unavailable. */
export function storeElsterPin(entityId: string, pin: string): boolean {
    const s = secret();
    if (!s) return !!pin && (secretStore()?.set(ref(entityId), pin, LABEL) ?? false);
    if (!pin) return false;
    try {
        return s.password_store_sync(schemaFor(s), { entity: entityId }, s.COLLECTION_DEFAULT, LABEL, pin, null);
    } catch {
        return false;
    }
}

/**
 * Look up the stored ELSTER PIN for an entity, or null when none / unavailable.
 * Falls back to {@link LEGACY_SCHEMA_NAME} so a PIN saved before the rename is still found.
 */
export function lookupElsterPin(entityId: string): string | null {
    const s = secret();
    if (!s) return secretStore()?.get(ref(entityId)) ?? null;
    for (const name of [SCHEMA_NAME, LEGACY_SCHEMA_NAME]) {
        try {
            const pin = s.password_lookup_sync(schemaFor(s, name), { entity: entityId }, null) || null;
            if (pin) return pin;
        } catch {
            // A missing/locked keyring throws — try the next schema, then report "no stored PIN".
        }
    }
    return null;
}

/**
 * Delete the stored ELSTER PIN for an entity. Clears BOTH schemas: a PIN written before the rename
 * lives under the old name, and "forget my PIN" must not leave that copy behind. Returns true when
 * at least one entry was removed.
 */
export function clearElsterPin(entityId: string): boolean {
    const s = secret();
    if (!s) {
        const store = secretStore();
        if (!store || store.get(ref(entityId)) === undefined) return false;
        store.delete(ref(entityId));
        return true;
    }
    let cleared = false;
    for (const name of [SCHEMA_NAME, LEGACY_SCHEMA_NAME]) {
        try {
            if (s.password_clear_sync(schemaFor(s, name), { entity: entityId }, null)) cleared = true;
        } catch {
            // Same as above: an unreachable keyring is "nothing to clear here".
        }
    }
    return cleared;
}
