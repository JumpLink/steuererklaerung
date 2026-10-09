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
 *   3. the login keyring, via `secret-tool` — the only one that survives a reboot without
 *      putting the secret in a file. Store it once with {@link storePinInKeyring}.
 *
 * A GUI prompt is deliberately NOT here: the desktop app already asks for the PIN in its own
 * masked dialog, and a CLI that pops up a window would be surprising in a script.
 *
 * The PIN is never written to disk, never logged, and never persisted by this module. What comes
 * back is handed straight to ERiC for one call.
 */

import { execFileSync } from 'node:child_process';

/** Keyring lookup attributes — one entry per certificate path, so several keystores can coexist. */
const KEYRING_SERVICE = 'de.elster.keystore';

/** Where a resolved PIN came from. Reported so a failure names the source that was used. */
export type PinSource = 'argument' | 'env' | 'keyring';

export interface ResolvedPin {
    pin: string;
    source: PinSource;
}

/** Ask `secret-tool` for a stored PIN. Returns undefined when absent, locked, or unavailable. */
function pinFromKeyring(keystorePath: string): string | undefined {
    try {
        const out = execFileSync('secret-tool', ['lookup', 'service', KEYRING_SERVICE, 'keystore', keystorePath], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.trim() || undefined;
    } catch {
        // No entry, no secret-tool, or a locked keyring — all mean "not available here", and none
        // of them is an error worth aborting on: the caller still has the other sources.
        return undefined;
    }
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
 * Put the PIN into the login keyring, read from stdin so it never becomes an argument.
 *
 * `secret-tool store` reads the secret from stdin by design — that is why it is used here rather
 * than the libsecret GIR binding: the same call works under GJS and Node, and the secret never
 * travels as a parameter.
 */
export function storePinInKeyring(keystorePath: string, pin: string): void {
    execFileSync(
        'secret-tool',
        ['store', '--label', `ELSTER-Zertifikat ${keystorePath}`, 'service', KEYRING_SERVICE, 'keystore', keystorePath],
        { input: pin, encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'] },
    );
}

/** Remove a stored PIN. Idempotent — clearing what is not there is not an error. */
export function clearPinFromKeyring(keystorePath: string): void {
    try {
        execFileSync('secret-tool', ['clear', 'service', KEYRING_SERVICE, 'keystore', keystorePath], {
            stdio: ['ignore', 'ignore', 'ignore'],
        });
    } catch {
        // Nothing stored, or no secret-tool: either way there is nothing left to clear.
    }
}
