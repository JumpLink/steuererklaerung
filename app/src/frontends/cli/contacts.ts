/**
 * `contacts` — manual single-record access to the unified contact master (parties: customers +
 * suppliers). The bulk path is `paperless correspondents` + Qonto clients pulled in automatically
 * via `importContacts` (see the web UI's Kontakte tab); this command is for the one-off case —
 * adding/checking/removing a single party by hand, e.g. a new point-of-contact at a customer.
 *
 *   contacts add --entity <entity-id> --kind individual --name "Erika Mustermann" \
 *     --notes "Ansprechpartnerin für example.com"
 *   contacts list [--entity <entity-id>] [--json]
 *   contacts remove --entity <entity-id> --id c_...
 *
 * `add` always INSERTS a new contact unless `--id` is given (then it merge-updates that one, same
 * as saveContact/upsertContact) — there is no name-based dedup here (that only happens on import).
 * Run `contacts list` first to check for an existing entry before adding a likely duplicate.
 */

import type { CommandModule } from 'yargs';
import type { Contact, ContactKind } from '@steuererklaerung/store';
import { contactDisplayName } from '@steuererklaerung/store';
import { listEntityContacts, removeContact, saveContact } from '../../core/actions/contacts.ts';
import { defaultEntityFor, requireEntity } from '../../core/config/entities.ts';
import { loadManifest } from '../../core/config/index.ts';

const CONTACT_KINDS: ContactKind[] = ['company', 'individual', 'freelancer', 'organization'];

/** `--entity` omitted on a read command falls back to the manifest's default business entity. */
function resolveEntityId(entityArg: string | undefined): string {
    const manifest = loadManifest();
    const entity = entityArg ? requireEntity(manifest, entityArg) : defaultEntityFor(manifest);
    return entity.id;
}

function printContact(c: Contact): void {
    const flags = [c.isCustomer ? 'Kunde' : null, c.isSupplier ? 'Lieferant' : null].filter(Boolean).join(', ');
    console.log(`  ${c.id}  [${c.kind}]  ${contactDisplayName(c)}${flags ? `  (${flags})` : ''}`);
    if (c.email) console.log(`        ${c.email}`);
    if (c.notes) console.log(`        ${c.notes}`);
    for (const l of c.links) console.log(`        ↳ ${l.system}:${l.externalId}`);
}

export const contactsCommand: CommandModule = {
    command: 'contacts',
    describe: 'Kontakte-/Parteienstamm: einzelne Kontakte anlegen, auflisten, entfernen',
    builder: (yargs) =>
        yargs
            .demandCommand(1, 'Choose: add, list, or remove')
            .command({
                command: 'add',
                describe: 'Einen Kontakt anlegen (ohne --id) oder aktualisieren (mit --id, merge)',
                builder: (y) =>
                    y
                        .option('id', {
                            type: 'string',
                            describe: 'Vorhandenen Kontakt aktualisieren statt neu anlegen',
                        })
                        .option('entity', {
                            type: 'string',
                            demandOption: true,
                            describe: 'Workspace-Entität (gbr|jumplink|privat)',
                        })
                        .option('kind', { type: 'string', choices: CONTACT_KINDS, describe: 'Art (default: company)' })
                        .option('name', { type: 'string', describe: 'Firmen-/Anzeigename' })
                        .option('first-name', { type: 'string' })
                        .option('last-name', { type: 'string' })
                        .option('email', { type: 'string' })
                        .option('vat-number', { type: 'string', describe: 'USt-IdNr.' })
                        .option('tax-id', { type: 'string', describe: 'Steuer-ID/-nummer' })
                        .option('iban', { type: 'string' })
                        .option('currency', { type: 'string', describe: 'Default: EUR' })
                        .option('locale', { type: 'string', describe: 'Default: de' })
                        .option('address', { type: 'string' })
                        .option('zip', { type: 'string' })
                        .option('city', { type: 'string' })
                        .option('country-code', { type: 'string' })
                        .option('is-customer', { type: 'boolean' })
                        .option('is-supplier', { type: 'boolean' })
                        .option('notes', { type: 'string', describe: 'Freitext, z. B. Rolle/Ansprechpartner-Kontext' })
                        .check((argv) => {
                            if (!argv.id && !argv.name && !argv.firstName && !argv.lastName) {
                                throw new Error('Mindestens --name oder --first-name/--last-name angeben.');
                            }
                            return true;
                        }),
                handler: (argv) => {
                    try {
                        const saved = saveContact({
                            id: argv.id != null ? String(argv.id) : undefined,
                            entityId: String(argv.entity),
                            kind: argv.kind as ContactKind | undefined,
                            name: argv.name != null ? String(argv.name) : undefined,
                            firstName: argv.firstName != null ? String(argv.firstName) : undefined,
                            lastName: argv.lastName != null ? String(argv.lastName) : undefined,
                            email: argv.email != null ? String(argv.email) : undefined,
                            vatNumber: argv.vatNumber != null ? String(argv.vatNumber) : undefined,
                            taxId: argv.taxId != null ? String(argv.taxId) : undefined,
                            iban: argv.iban != null ? String(argv.iban) : undefined,
                            currency: argv.currency != null ? String(argv.currency) : undefined,
                            locale: argv.locale != null ? String(argv.locale) : undefined,
                            address: argv.address != null ? String(argv.address) : undefined,
                            zip: argv.zip != null ? String(argv.zip) : undefined,
                            city: argv.city != null ? String(argv.city) : undefined,
                            countryCode: argv.countryCode != null ? String(argv.countryCode) : undefined,
                            isCustomer: typeof argv.isCustomer === 'boolean' ? argv.isCustomer : undefined,
                            isSupplier: typeof argv.isSupplier === 'boolean' ? argv.isSupplier : undefined,
                            notes: argv.notes != null ? String(argv.notes) : undefined,
                        });
                        console.log(`${argv.id ? 'Aktualisiert' : 'Angelegt'}:`);
                        printContact(saved);
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'list',
                describe: 'Kontakte einer Entität auflisten (Default: die Standard-Entität)',
                builder: (y) =>
                    y
                        .option('entity', { type: 'string', describe: 'Workspace-Entität (Default: Standard-Entität)' })
                        .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON' }),
                handler: (argv) => {
                    try {
                        const entityId = resolveEntityId(argv.entity != null ? String(argv.entity) : undefined);
                        const contacts = listEntityContacts(entityId);
                        if (argv.json) {
                            console.log(JSON.stringify(contacts, null, 2));
                        } else if (contacts.length === 0) {
                            console.log(`Keine Kontakte für „${entityId}".`);
                        } else {
                            console.log(`\nKontakte „${entityId}" (${contacts.length})\n`);
                            for (const c of contacts) printContact(c);
                            console.log('');
                        }
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'remove',
                describe: 'Einen Kontakt löschen (inkl. seiner Links)',
                builder: (y) =>
                    y
                        .option('entity', { type: 'string', demandOption: true, describe: 'Workspace-Entität' })
                        .option('id', { type: 'string', demandOption: true, describe: 'Kontakt-ID' }),
                handler: (argv) => {
                    try {
                        removeContact(String(argv.entity), String(argv.id));
                        console.log(`Gelöscht: ${argv.id}`);
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            }),
    handler: () => {},
};
