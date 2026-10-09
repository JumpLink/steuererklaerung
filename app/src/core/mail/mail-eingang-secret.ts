/**
 * The password of an entity's mail folder (Idee 15) — in the OS keyring, never in the manifest.
 *
 * Reached through `secret-tool` like the ELSTER PIN (`core/elster/pin.ts`), not through the libsecret
 * GIR binding the SMTP password uses: CLI, MCP and desktop must all read the SAME entry, and
 * `secret-tool` is the one route that works in every one of them. The secret goes to `secret-tool
 * store` on stdin, so it never becomes an argument in the process list.
 *
 * Resolution order, most explicit first: the `STEUER_MAIL_EINGANG_PASSWORD` environment variable
 * (one shell, never stored — for a headless host without a keyring, the same shape as `ELSTER_PIN`),
 * then the keyring. A missing or locked keyring reads as "no password", never as an error.
 */

import { execFileSync } from 'node:child_process';

const KEYRING_SERVICE = 'eu.jumplink.Steuererklaerung.MailEingang';

/** Where a resolved password came from — reported so a failure names the source that was used. */
export type MailPasswordSource = 'env' | 'keyring';

export interface ResolvedMailPassword {
    password: string;
    source: MailPasswordSource;
}

function fromKeyring(entityId: string): string | undefined {
    try {
        const out = execFileSync('secret-tool', ['lookup', 'service', KEYRING_SERVICE, 'entity', entityId], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.replace(/\r?\n$/, '') || undefined;
    } catch {
        // No entry, no secret-tool, a locked keyring: all "not available here".
        return undefined;
    }
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

/** Store (or overwrite) the password. Returns false when the keyring is unavailable. */
export function storeMailEingangPassword(entityId: string, password: string): boolean {
    if (!password) return false;
    try {
        execFileSync(
            'secret-tool',
            [
                'store',
                '--label',
                'Steuererklärung — Passwort des Belege-Postfachs',
                'service',
                KEYRING_SERVICE,
                'entity',
                entityId,
            ],
            { input: password, encoding: 'utf8', stdio: ['pipe', 'ignore', 'ignore'] },
        );
        return true;
    } catch {
        return false;
    }
}

/** Forget the stored password. Idempotent. */
export function clearMailEingangPassword(entityId: string): void {
    try {
        execFileSync('secret-tool', ['clear', 'service', KEYRING_SERVICE, 'entity', entityId], {
            stdio: ['ignore', 'ignore', 'ignore'],
        });
    } catch {
        // Nothing stored, or no secret-tool: nothing left to clear.
    }
}
