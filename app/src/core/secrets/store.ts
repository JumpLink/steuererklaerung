/**
 * Where a stored secret (ELSTER keystore PIN, mail passwords) lives — one small interface, one
 * backend per OS, picked by {@link selectSecretStore}.
 *
 * Every secret is addressed by the same triple the Linux keyring entries always used: a `service`
 * (what it is for), an `attribute` name and its `id` (which certificate / which entity). Keeping
 * that shape means an entry written by an older build is still found.
 *
 *   Linux    `secret-tool`   the login keyring (GNOME Keyring, KWallet's Secret Service bridge)
 *   macOS    `security`      the login Keychain
 *   Windows  DPAPI           an encrypted file under the user config dir, see {@link dpapiStore}
 *
 * A machine without a working backend gets `null` from {@link secretStore}, never a plaintext
 * fallback: the callers then ask for the secret each time, which is the honest degraded mode.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { _ } from '../lib/i18n.ts';
import { userConfigDir } from '../paths.ts';

/** Addresses one secret. `attribute`/`id` is e.g. `keystore` + a certificate path, or `entity` + `gbr`. */
export interface SecretRef {
    service: string;
    attribute: string;
    id: string;
}

export type SecretStoreKind = 'secret-tool' | 'keychain' | 'dpapi';

export interface SecretStore {
    readonly kind: SecretStoreKind;
    /** For the UI and docs, as the end of "Stored …": where the secret ends up and how it is protected. */
    readonly description: string;
    /** The secret, or undefined when absent / locked / unreadable — never throws. */
    get(ref: SecretRef): string | undefined;
    /** Store or overwrite. False when the backend refused. */
    set(ref: SecretRef, secret: string, label: string): boolean;
    /** Remove. Idempotent: removing what is not there is not an error. */
    delete(ref: SecretRef): void;
}

/**
 * Runs a program and returns its stdout; throws on a non-zero exit or a missing binary. `input` goes
 * to stdin, which is the only way a secret reaches a program here — never an argument, because
 * arguments show up in the process list.
 */
export type Exec = (command: string, args: string[], input?: string) => string;

export const execSync: Exec = (command, args, input) =>
    execFileSync(command, args, {
        input,
        encoding: 'utf8',
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
        windowsHide: true,
    });

/** Trailing newline only: a secret that really ends in spaces must survive the round trip. */
function chomp(out: string): string {
    return out.replace(/\r?\n$/, '');
}

// ── Linux: Secret Service via secret-tool ─────────────────────────────────────────────────────────

export function secretToolStore(exec: Exec = execSync): SecretStore {
    return {
        kind: 'secret-tool',
        description: _('in the keyring (Secret Service), never in clear text'),
        get(ref) {
            try {
                return (
                    chomp(exec('secret-tool', ['lookup', 'service', ref.service, ref.attribute, ref.id])) || undefined
                );
            } catch {
                return undefined;
            }
        },
        set(ref, secret, label) {
            if (!secret) return false;
            try {
                exec('secret-tool', ['store', '--label', label, 'service', ref.service, ref.attribute, ref.id], secret);
                return true;
            } catch {
                return false;
            }
        },
        delete(ref) {
            try {
                exec('secret-tool', ['clear', 'service', ref.service, ref.attribute, ref.id]);
            } catch {
                /* nothing stored, or no secret-tool */
            }
        },
    };
}

// ── macOS: login Keychain via security ────────────────────────────────────────────────────────────

/**
 * `security add-generic-password -w` takes the password as an argument (visible in `ps`) or prompts
 * on the terminal — neither is acceptable. `security -i` reads commands from stdin instead, and `-X`
 * takes the password as hex, so no quoting rule applies to what the user typed.
 */
export function keychainStore(exec: Exec = execSync): SecretStore {
    // The account carries attribute and id both, so `keystore=/a` and `entity=/a` cannot collide.
    const account = (ref: SecretRef) => `${ref.attribute}:${ref.id}`;
    // `security -i` splits its input at whitespace and quotes; a value with either needs quoting.
    const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return {
        kind: 'keychain',
        description: _('in the macOS keychain, never in clear text'),
        get(ref) {
            try {
                return (
                    chomp(exec('security', ['find-generic-password', '-s', ref.service, '-a', account(ref), '-w'])) ||
                    undefined
                );
            } catch {
                return undefined;
            }
        },
        set(ref, secret, label) {
            if (!secret) return false;
            const hex = Buffer.from(secret, 'utf8').toString('hex');
            try {
                exec(
                    'security',
                    ['-i'],
                    `add-generic-password -U -s ${quote(ref.service)} -a ${quote(account(ref))} -l ${quote(label)} -X ${hex}\n`,
                );
                return true;
            } catch {
                return false;
            }
        },
        delete(ref) {
            try {
                exec('security', ['delete-generic-password', '-s', ref.service, '-a', account(ref)]);
            } catch {
                /* nothing stored */
            }
        },
    };
}

// ── Windows: DPAPI ────────────────────────────────────────────────────────────────────────────────

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/** Base64 on both sides: PowerShell's console codepage would mangle a non-ASCII PIN passed raw. */
const PS_PROTECT =
    '$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()));' +
    '[Console]::Out.Write((ConvertTo-SecureString $p -AsPlainText -Force | ConvertFrom-SecureString))';
const PS_UNPROTECT =
    '$s=ConvertTo-SecureString ([Console]::In.ReadToEnd().Trim());' +
    '$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);' +
    '$p=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b);' +
    '[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b);' +
    '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p)))';

/**
 * Windows has no command-line keyring, but it has DPAPI: `ConvertFrom-SecureString` without a key
 * encrypts with the current user's logon credentials, so the blob is useless to another user and on
 * another machine. The blobs sit in one JSON file next to the manifest. That is weaker than a
 * Keychain — any program running AS this user can decrypt them — and the description says so.
 */
export function dpapiStore(
    exec: Exec = execSync,
    file: string = join(userConfigDir(), 'secrets.dpapi.json'),
): SecretStore {
    const key = (ref: SecretRef) => JSON.stringify([ref.service, ref.attribute, ref.id]);
    const read = (): Record<string, string> => {
        try {
            return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {};
        } catch {
            return {};
        }
    };
    const write = (all: Record<string, string>) => {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
        try {
            chmodSync(tmp, 0o600);
        } catch {
            /* Windows ignores POSIX modes; the user profile's ACL is what protects the file */
        }
        renameSync(tmp, file);
    };
    return {
        kind: 'dpapi',
        description: _(
            'encrypted with your Windows account (DPAPI) — every program running under this account can read them',
        ),
        get(ref) {
            const blob = read()[key(ref)];
            if (!blob) return undefined;
            try {
                const b64 = exec('powershell.exe', [...PS, PS_UNPROTECT], blob);
                return Buffer.from(b64.trim(), 'base64').toString('utf8') || undefined;
            } catch {
                return undefined;
            }
        },
        set(ref, secret) {
            if (!secret) return false;
            try {
                const blob = exec(
                    'powershell.exe',
                    [...PS, PS_PROTECT],
                    Buffer.from(secret, 'utf8').toString('base64'),
                ).trim();
                if (!blob) return false;
                write({ ...read(), [key(ref)]: blob });
                return true;
            } catch {
                return false;
            }
        },
        delete(ref) {
            const all = read();
            if (!(key(ref) in all)) return;
            delete all[key(ref)];
            try {
                write(all);
            } catch {
                /* unwritable file: nothing more to remove */
            }
        },
    };
}

// ── Selection ─────────────────────────────────────────────────────────────────────────────────────

/** The backend for an OS, or null for one we have none for. Pure: no probing, no I/O. */
export function selectSecretStore(platform: string, exec: Exec = execSync): SecretStore | null {
    switch (platform) {
        case 'linux':
            return secretToolStore(exec);
        case 'darwin':
            return keychainStore(exec);
        case 'win32':
            return dpapiStore(exec);
        default:
            return null;
    }
}

/** True when the backend's program can be started at all — `secret-tool` is often not installed. */
function usable(store: SecretStore, exec: Exec): boolean {
    const probe: Record<SecretStoreKind, [string, string[]]> = {
        'secret-tool': ['secret-tool', ['--version']],
        keychain: ['security', ['help']],
        dpapi: ['powershell.exe', [...PS, '$PSVersionTable.PSVersion.Major']],
    };
    const [command, args] = probe[store.kind];
    try {
        exec(command, args);
        return true;
    } catch (err) {
        // `security help` and `secret-tool --version` may exit non-zero while still existing; only a
        // missing binary means "not here".
        return (err as NodeJS.ErrnoException).code !== 'ENOENT';
    }
}

/** {@link selectSecretStore} plus the check that its program exists on this machine. */
export function pickSecretStore(platform: string, exec: Exec = execSync): SecretStore | null {
    const picked = selectSecretStore(platform, exec);
    return picked && usable(picked, exec) ? picked : null;
}

let cached: SecretStore | null | undefined;

/** The secret store for this machine, or null when there is none — callers then ask every time. */
export function secretStore(): SecretStore | null {
    if (cached === undefined) cached = pickSecretStore(process.platform);
    return cached;
}

/** For tests. */
export function resetSecretStore(): void {
    cached = undefined;
}
