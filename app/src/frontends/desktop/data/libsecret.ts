/**
 * The libsecret (GNOME Keyring) binding shared by the secret helpers.
 *
 * Reached through GJS' GObject-Introspection (`imports.gi.Secret`, the system `Secret-1` typelib),
 * guarded so a missing or locked keyring degrades to "no stored secret" instead of throwing. Each
 * helper (ELSTER PIN, mail password) owns its schema name, label and attribute; only the binding is
 * common.
 */

/** The slice of the libsecret ABI we use (untyped GI — @girs/secret-1 is not installed). */
export interface SecretSchema {}
export interface SecretApi {
    Schema: new (name: string, flags: number, attributes: Record<string, number>) => SecretSchema;
    SchemaFlags: { NONE: number };
    SchemaAttributeType: { STRING: number };
    COLLECTION_DEFAULT: string;
    password_store_sync(
        schema: SecretSchema,
        attributes: Record<string, string>,
        collection: string | null,
        label: string,
        password: string,
        cancellable: unknown,
    ): boolean;
    password_lookup_sync(schema: SecretSchema, attributes: Record<string, string>, cancellable: unknown): string | null;
    password_clear_sync(schema: SecretSchema, attributes: Record<string, string>, cancellable: unknown): boolean;
}

/** Resolve the libsecret binding, or null when it is unavailable (non-GJS runtime / missing typelib). */
export function secret(): SecretApi | null {
    try {
        const gi = (
            globalThis as unknown as {
                imports?: { gi?: Record<string, unknown> & { versions?: Record<string, string> } };
            }
        ).imports?.gi;
        if (!gi) return null;
        // GJS needs an explicit version pin before first access when several are installed.
        if (gi.versions && !gi.versions.Secret) gi.versions.Secret = '1';
        return (gi.Secret as SecretApi | undefined) ?? null;
    } catch {
        // imports.gi.<NS> THROWS when the typelib is absent — treat as "no keyring".
        return null;
    }
}

/** A schema with one string attribute, `entity`: one entry per workspace entity. */
export function entitySchema(s: SecretApi, name: string): SecretSchema {
    return new s.Schema(name, s.SchemaFlags.NONE, { entity: s.SchemaAttributeType.STRING });
}
