/**
 * `elster pin` — put the ELSTER keystore PIN into the login keyring, or take it back out.
 *
 * The PIN is read from STDIN, never from an argument: an argument is visible in the shell history
 * and in `ps`, and npm echoes the resolved command line before running it. Piping is what makes
 * this safe, so the command is usable both interactively and from a script:
 *
 *   elster pin speichern --entity jumplink            # asks, input hidden by the terminal
 *   pass elster/jumplink | elster pin speichern -e …  # from a password manager
 */

import type { CommandModule as YargsCommandModule } from 'yargs';
import { pickArgv } from '../output.ts';
import { resolveEntityElster } from '../../../core/config/accessors.ts';
import { storePinInKeyring, clearPinFromKeyring, resolveElsterPin } from '../../../core/elster/pin.ts';

/** The keystore this entity signs with — the key a stored PIN hangs on. */
function keystoreFor(entity: string): string {
    const config = resolveEntityElster(entity);
    if (!config) throw new Error(`Entität '${entity}' hat keine ELSTER-Config.`);
    if (!config.keystore_path) throw new Error(`Entität '${entity}' hat keinen keystore_path in der Config.`);
    return config.keystore_path;
}

/** Read one line from stdin without echoing it, when the terminal allows turning echo off. */
async function readSecret(prompt: string): Promise<string> {
    const { createInterface } = await import('node:readline');
    process.stdout.write(prompt);
    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean; setRawMode?: (m: boolean) => void };
    // Only a TTY can hide input. Piped input is already invisible, so it needs no masking — and
    // forcing raw mode on a pipe would fail.
    const hide = Boolean(stdin.isTTY && stdin.setRawMode);
    if (hide) stdin.setRawMode?.(true);
    try {
        const rl = createInterface({ input: process.stdin, terminal: hide });
        const line = await new Promise<string>((resolve) => rl.once('line', (l: string) => resolve(l)));
        rl.close();
        return line.trim();
    } finally {
        if (hide) stdin.setRawMode?.(false);
        process.stdout.write('\n');
    }
}

export const pinSubcommand: YargsCommandModule = {
    command: 'pin <aktion>',
    describe: 'Zertifikats-PIN im Schlüsselbund ablegen (speichern), löschen oder prüfen (status).',
    builder: (y: any) =>
        y
            .positional('aktion', { choices: ['speichern', 'loeschen', 'status'], describe: 'Was getan werden soll' })
            .option('entity', {
                type: 'string',
                demandOption: true,
                describe: 'Workspace-Entität (gbr|jumplink|privat)',
            }),
    handler: async (argv: Record<string, unknown>) => {
        const raw = argv as Record<string, unknown>;
        const entity = pickArgv<string>(raw, 'entity') as string;
        const aktion = pickArgv<string>(raw, 'aktion') as string;
        const keystore = keystoreFor(entity);

        if (aktion === 'loeschen') {
            clearPinFromKeyring(keystore);
            console.log(`PIN für ${entity} aus dem Schlüsselbund entfernt.`);
            return;
        }

        if (aktion === 'status') {
            try {
                const { source } = resolveElsterPin(undefined, keystore);
                console.log(`PIN für ${entity} verfügbar — Quelle: ${source}.`);
            } catch {
                console.log(`Für ${entity} ist keine PIN hinterlegt.`);
            }
            return;
        }

        const pin = await readSecret(`PIN für ${entity} (${keystore}): `);
        if (!pin) throw new Error('Keine PIN eingegeben — nichts gespeichert.');
        storePinInKeyring(keystore, pin);
        console.log(`PIN für ${entity} im Schlüsselbund gespeichert.`);
        console.log('Ab jetzt finden `elster submit` und `elster kontoabfrage` sie von selbst — ohne --pin.');
    },
};
