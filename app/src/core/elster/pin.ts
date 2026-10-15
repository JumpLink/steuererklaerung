/**
 * Where the ELSTER keystore PIN comes from — anywhere but the command line.
 *
 * `--pin <wert>` puts the PIN into the shell history, into the process list (`ps` shows every
 * argument), and into whatever wraps the call: npm echoes the resolved command line before running
 * it, so even `read -rs` does not hide it. It leaked five times in one working session that way.
 *
 * The order below goes from most explicit to most convenient, and every source is checked in turn:
 *
 *   1. an explicit argument — unchanged, for scripts that already pass one
 *   2. `ELSTER_PIN` — the same shape FinTS already uses (`FINTS_PIN_<name>`), so an operator
 *      only has to learn the pattern once
 *   3. the OS secret store (`core/secrets/store.ts`: Secret Service, macOS Keychain, Windows DPAPI)
 *      — the only one that survives a reboot without putting the secret in a plain file. Store it once with {@link storePinInKeyring}.
 *
 * A GUI prompt is deliberately NOT here: the desktop app already asks for the PIN in its own
 * masked dialog, and a CLI that pops up a window would be surprising in a script.
 *
 * The PIN is never written to disk, never logged, and never persisted by this module. What comes
 * back is handed straight to ERiC for one call.
 */

import { secretStore, type SecretRef } from '../secrets/store.ts';

/** Keyring lookup attributes — one entry per certificate path, so several keystores can coexist. */
const KEYRING_SERVICE = 'de.elster.keystore';

/** Where a resolved PIN came from. Reported so a failure names the source that was used. */
export type PinSource = 'argument' | 'env' | 'keyring';

export interface ResolvedPin {
    pin: string;
    source: PinSource;
}

const ref = (keystorePath: string): SecretRef => ({
    service: KEYRING_SERVICE,
    attribute: 'keystore',
    id: keystorePath,
});

/** Ask the secret store for a PIN. Returns undefined when absent, locked, or no store exists. */
function pinFromKeyring(keystorePath: string): string | undefined {
    // Absent, a locked keyring or no store at all all mean "not available here", and none of them
    // is an error worth aborting on: the caller still has the other sources.
    return secretStore()?.get(ref(keystorePath))?.trim() || undefined;
}

/**
 * Resolve the PIN, or explain precisely how to supply one.
 *
 * Throws rather than returning undefined: every caller needs a PIN to proceed, and a thrown
 * message can name all three ways at the point where the need arises.
 */
export function resolveElsterPin(explicit: string | undefined, keystorePath: string): ResolvedPin {
    if (explicit) return { pin: explicit, source: 'argument' };

    const fromEnv = process.env.ELSTER_PIN?.trim();
    if (fromEnv) return { pin: fromEnv, source: 'env' };

    const fromKeyring = pinFromKeyring(keystorePath);
    if (fromKeyring) return { pin: fromKeyring, source: 'keyring' };

    throw new Error(
        'Keine Zertifikats-PIN gefunden. Drei Wege, keiner davon die Kommandozeile:\n' +
            `  Schlüsselbund (bleibt gespeichert):  elster pin speichern --entity <e>\n` +
            '  Umgebungsvariable (diese Shell):     export ELSTER_PIN=…\n' +
            '  Argument (landet in der History):    --pin …',
    );
}

/**
 * Put the PIN into the OS secret store. It reaches the backend on stdin, never as an argument.
 * Throws when there is no store or it refuses, so the CLI can say the PIN was NOT saved.
 */
export function storePinInKeyring(keystorePath: string, pin: string): void {
    const store = secretStore();
    if (!store) throw new Error('Auf diesem System gibt es keinen Schlüsselbund für die PIN.');
    if (!store.set(ref(keystorePath), pin, `ELSTER-Zertifikat ${keystorePath}`)) {
        throw new Error('Der Schlüsselbund hat die PIN nicht angenommen (entsperrt?).');
    }
}

/** Remove a stored PIN. Idempotent — clearing what is not there is not an error. */
export function clearPinFromKeyring(keystorePath: string): void {
    secretStore()?.delete(ref(keystorePath));
}
