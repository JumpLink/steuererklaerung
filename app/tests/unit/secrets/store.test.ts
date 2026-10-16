/**
 * The secret-store selection and its three backends, with the OS programs replaced by a recorder.
 *
 * What is pinned: which backend each platform gets, that a missing program means "no store" (never a
 * silent plaintext fallback), and that no secret ever travels as a command-line argument.
 */

import { afterEach, beforeEach, describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    dpapiStore,
    keychainStore,
    pickSecretStore,
    secretToolStore,
    selectSecretStore,
    type Exec,
    type SecretRef,
} from '../../../src/core/secrets/store.ts';

const REF: SecretRef = { service: 'de.elster.keystore', attribute: 'keystore', id: '/home/u/cert.pfx' };
const PIN = 'pä$$ "wörd" \\ 123';

interface Call {
    command: string;
    args: string[];
    input?: string;
}

function recorder(reply: (c: Call) => string = () => ''): { exec: Exec; calls: Call[] } {
    const calls: Call[] = [];
    const exec: Exec = (command, args, input) => {
        const call = { command, args, input };
        calls.push(call);
        return reply(call);
    };
    return { exec, calls };
}

export default async () => {
    await describe('selectSecretStore', async () => {
        await it('picks the OS-native backend', async () => {
            expect(selectSecretStore('linux')?.kind).toBe('secret-tool');
            expect(selectSecretStore('darwin')?.kind).toBe('keychain');
            expect(selectSecretStore('win32')?.kind).toBe('dpapi');
        });

        await it('has none for an OS it does not know', async () => {
            expect(selectSecretStore('freebsd')).toBeNull();
        });
    });

    await describe('pickSecretStore', async () => {
        await it('returns null when the backend program is missing', async () => {
            const exec: Exec = () => {
                throw Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' });
            };
            expect(pickSecretStore('linux', exec)).toBeNull();
            expect(pickSecretStore('darwin', exec)).toBeNull();
            expect(pickSecretStore('win32', exec)).toBeNull();
        });

        await it('keeps a program that exists but exits non-zero on its probe', async () => {
            const exec: Exec = () => {
                throw Object.assign(new Error('exit 1'), { status: 1 });
            };
            expect(pickSecretStore('darwin', exec)?.kind).toBe('keychain');
        });
    });

    await describe('secret-tool backend', async () => {
        await it('keeps the attributes older builds wrote, and the PIN on stdin only', async () => {
            const { exec, calls } = recorder();
            expect(secretToolStore(exec).set(REF, PIN, 'label')).toBe(true);
            expect(calls[0].command).toBe('secret-tool');
            expect(calls[0].args.join(' ')).toBe(
                ['store', '--label', 'label', 'service', 'de.elster.keystore', 'keystore', '/home/u/cert.pfx'].join(
                    ' ',
                ),
            );
            expect(calls[0].input).toBe(PIN);
            expect(calls[0].args.join(' ').includes('wörd')).toBe(false);
        });

        await it('reads one trailing newline and nothing else', async () => {
            const { exec } = recorder(() => '1234 \n');
            expect(secretToolStore(exec).get(REF)).toBe('1234 ');
        });

        await it('reports absence as undefined, not an error', async () => {
            const exec: Exec = () => {
                throw new Error('exit 1');
            };
            expect(secretToolStore(exec).get(REF)).toBeUndefined();
            expect(secretToolStore(exec).set(REF, PIN, 'l')).toBe(false);
            secretToolStore(exec).delete(REF);
        });

        await it('refuses an empty secret', async () => {
            const { exec, calls } = recorder();
            expect(secretToolStore(exec).set(REF, '', 'l')).toBe(false);
            expect(calls.length).toBe(0);
        });
    });

    await describe('macOS keychain backend', async () => {
        await it('writes through `security -i` with the password as hex, never as an argument', async () => {
            const { exec, calls } = recorder();
            expect(keychainStore(exec).set(REF, PIN, 'Mein "Label"')).toBe(true);
            expect(calls[0].command).toBe('security');
            expect(calls[0].args.join(' ')).toBe(['-i'].join(' '));
            expect(calls[0].input?.startsWith('add-generic-password -U -s "de.elster.keystore"')).toBe(true);
            expect(calls[0].input?.includes(`-X ${Buffer.from(PIN, 'utf8').toString('hex')}`)).toBe(true);
            expect(calls[0].input?.includes('-l "Mein \\"Label\\""')).toBe(true);
            // the account names attribute AND id, so `keystore=x` and `entity=x` never collide
            expect(calls[0].input?.includes('-a "keystore:/home/u/cert.pfx"')).toBe(true);
        });

        await it('looks up and deletes by service + account', async () => {
            const { exec, calls } = recorder(() => 'geheim\n');
            const store = keychainStore(exec);
            expect(store.get(REF)).toBe('geheim');
            store.delete(REF);
            expect(calls[0].args.join(' ')).toBe(
                ['find-generic-password', '-s', 'de.elster.keystore', '-a', 'keystore:/home/u/cert.pfx', '-w'].join(
                    ' ',
                ),
            );
            expect(calls[1].args[0]).toBe('delete-generic-password');
        });
    });

    await describe('Windows DPAPI backend', async () => {
        let dir = '';
        beforeEach(async () => {
            dir = mkdtempSync(join(tmpdir(), 'steuer-dpapi-'));
        });
        afterEach(async () => {
            rmSync(dir, { recursive: true, force: true });
        });

        // Stands in for PowerShell: "encrypts" by reversing the base64 text, which is enough to prove
        // the file holds what the program returned and not the secret.
        const fakePowerShell = (c: Call): string => [...(c.input ?? '')].reverse().join('');

        await it('round-trips a PIN and never writes it to the file in the clear', async () => {
            const file = join(dir, 'secrets.dpapi.json');
            const { exec, calls } = recorder(fakePowerShell);
            const store = dpapiStore(exec, file);

            expect(store.set(REF, PIN, 'l')).toBe(true);
            expect(store.get(REF)).toBe(PIN);

            const onDisk = readFileSync(file, 'utf8');
            expect(onDisk.includes('wörd')).toBe(false);
            expect(onDisk.includes(Buffer.from(PIN, 'utf8').toString('base64'))).toBe(false);
            // the secret reached PowerShell on stdin (as base64), not in its arguments
            expect(calls[0].args.join(' ').includes('wörd')).toBe(false);
            expect(calls[0].input).toBe(Buffer.from(PIN, 'utf8').toString('base64'));
        });

        await it('keeps entries apart and deletes idempotently', async () => {
            const file = join(dir, 'secrets.dpapi.json');
            const store = dpapiStore(recorder(fakePowerShell).exec, file);
            const other: SecretRef = { ...REF, attribute: 'entity', id: 'gbr' };

            store.set(REF, 'one', 'l');
            store.set(other, 'two', 'l');
            expect(store.get(REF)).toBe('one');
            expect(store.get(other)).toBe('two');

            store.delete(REF);
            store.delete(REF);
            expect(store.get(REF)).toBeUndefined();
            expect(store.get(other)).toBe('two');
        });

        await it('says plainly what it is', async () => {
            const text = dpapiStore(recorder().exec, join(dir, 'x.json')).description;
            expect(text.includes('DPAPI')).toBe(true);
            expect(text.includes('every program')).toBe(true);
        });

        await it('reports a failed encryption instead of storing something', async () => {
            const file = join(dir, 'secrets.dpapi.json');
            const exec: Exec = () => {
                throw new Error('powershell failed');
            };
            expect(dpapiStore(exec, file).set(REF, PIN, 'l')).toBe(false);
        });
    });
};
