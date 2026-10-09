/**
 * The setup assistant's model and the account assignment behind "add a bank account".
 *
 *   - which pages each mode shows, per kind (the new-entity path never shows the welcome),
 *   - "later" writes nothing for the question it skipped,
 *   - a workspace that already uses Paperless preselects it, token included,
 *   - building a draft never touches the disk: a cancelled run leaves the manifest byte-identical,
 *   - the one write adds the entity and MOVES exact account keys; globs elsewhere stay,
 *   - assignAccount refuses an unknown entity without writing.
 *
 * Everything runs against temp dirs; LEDGER_DB_PATH points at a file that does not exist, so the GoBD
 * lookup never walks up to a real ledger.
 */
import { afterEach, beforeEach, describe, expect, it } from '@gjsify/unit';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { connectionAccountPattern, importedAccountKeys } from '../../../src/core/actions/accounts.ts';
import { assignAccount } from '../../../src/core/actions/entities.ts';
import {
    accountOwner,
    applyEntitySetup,
    entitySetupPages,
    entitySetupSections,
    freeEntityId,
    newEntitySetupDraft,
    nextEntitySetupPage,
} from '../../../src/core/actions/entity-setup.ts';
import { loadManifest } from '../../../src/core/config/index.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';

const PAPERLESS = { type: 'paperless', paperless: { url: 'https://paperless.example', token: 'tok-1' } };

export default async () => {
    await describe('entity setup', async () => {
        let dir = '';
        let path = '';
        let ledgerBefore: string | undefined;

        beforeEach(() => {
            ({ dir, path } = writeManifestFixture({
                entities: [
                    {
                        id: 'muster',
                        name: 'Muster & Partner GbR',
                        kind: 'gbr',
                        accounts: ['camt:DE89370400440532013000', 'qonto:*'],
                        dms: PAPERLESS,
                        elster: { entity_id: 'muster', period: { year: 2026, quarter: 1 } },
                    },
                    { id: 'privat', name: 'Privat', kind: 'privat' },
                ],
            }));
            ledgerBefore = process.env.LEDGER_DB_PATH;
            process.env.LEDGER_DB_PATH = join(dir, 'no-ledger.db');
        });

        afterEach(() => {
            if (ledgerBefore === undefined) delete process.env.LEDGER_DB_PATH;
            else process.env.LEDGER_DB_PATH = ledgerBefore;
            rmSync(dir, { recursive: true, force: true });
        });

        await it('shows the welcome only on the first run', async () => {
            expect(entitySetupPages('first-run', 'privat')).toStrictEqual(['welcome', 'entity', 'dms', 'finish']);
            for (const kind of ['einzelunternehmen', 'gbr', 'privat'] as const) {
                expect(entitySetupPages('new-entity', kind).includes('welcome')).toBe(false);
                expect(entitySetupPages('new-entity', kind)[0]).toBe('kind');
            }
        });

        await it('asks business questions for a business and private ones for a household', async () => {
            expect(entitySetupPages('new-entity', 'gbr')).toStrictEqual([
                'kind',
                'business',
                'accounts',
                'dms',
                'finish',
            ]);
            expect(entitySetupPages('new-entity', 'einzelunternehmen')).toStrictEqual([
                'kind',
                'business',
                'accounts',
                'dms',
                'finish',
            ]);
            expect(entitySetupPages('new-entity', 'privat')).toStrictEqual([
                'kind',
                'private',
                'accounts',
                'dms',
                'finish',
            ]);
            expect(nextEntitySetupPage('new-entity', 'privat', 'kind')).toBe('private');
            expect(nextEntitySetupPage('new-entity', 'gbr', 'kind')).toBe('business');
            expect(nextEntitySetupPage('new-entity', 'gbr', 'finish')).toBe(null);
            expect(nextEntitySetupPage('new-entity', 'gbr', 'private')).toBe(null);
        });

        await it('preselects the Paperless instance the other entities use', async () => {
            const draft = newEntitySetupDraft(loadManifest(path));
            expect(draft.dms).toBe('paperless');
            expect(draft.paperlessUrl).toBe('https://paperless.example');
            expect(draft.dmsFrom).toBe('muster');
            expect(newEntitySetupDraft(null).dms).toBe('builtin');
        });

        await it('writes nothing for a question answered with later', async () => {
            const manifest = loadManifest(path);
            const business = { ...newEntitySetupDraft(null, 'einzelunternehmen'), name: 'Muster' };
            const sections = entitySetupSections(business, 'x', manifest, 2026);
            expect(sections.invoicing).toBeUndefined();
            expect(sections.elster).toStrictEqual({ entity_id: 'x', period: { year: 2026, quarter: 1 } });

            const privat = { ...newEntitySetupDraft(null, 'privat'), name: 'Privat 2' };
            expect(entitySetupSections(privat, 'y', manifest).est).toBeUndefined();
        });

        await it('writes the country and tax switch only when they differ from the default', async () => {
            const manifest = loadManifest(path);
            const base = { ...newEntitySetupDraft(null, 'einzelunternehmen'), name: 'Muster' };
            const germany = entitySetupSections({ ...base, country: 'DE', taxModule: 'de' }, 'x', manifest);
            expect('country' in germany || 'taxModule' in germany).toBe(false);
            const off = entitySetupSections({ ...base, country: 'DE', taxModule: 'none' }, 'x', manifest);
            expect(off.taxModule).toBe('none');
            expect('country' in off).toBe(false);
            const other = entitySetupSections({ ...base, country: 'ZZ', taxModule: 'none' }, 'x', manifest);
            expect(other.country).toBe('ZZ');
            expect('taxModule' in other).toBe(false);
        });

        await it('maps every answer onto an existing field', async () => {
            const manifest = loadManifest(path);
            const business = {
                ...newEntitySetupDraft(manifest, 'einzelunternehmen'),
                name: 'Muster',
                taxNumber: ' 11/222/33333 ',
                kleinunternehmer: true,
                ustCadence: 'month' as const,
            };
            const s = entitySetupSections(business, 'x', manifest, 2026);
            expect(s.elster).toStrictEqual({
                entity_id: 'x',
                period: { year: 2026, month: 1 },
                tax_number: '11/222/33333',
            });
            expect(s.invoicing).toStrictEqual({ self: { issuer: { kleinunternehmer: true } } });
            // The token of the entity the setup was copied from, since none was typed.
            expect(s.dms).toStrictEqual(PAPERLESS);

            const privat = {
                ...newEntitySetupDraft(null, 'privat'),
                name: 'Erika Muster',
                taxNumber: '11/222/33333',
                veranlagung: 'splitting' as const,
            };
            expect(entitySetupSections(privat, 'y', manifest).est).toStrictEqual({
                entity_id: 'y',
                veranlagung: 'splitting',
                person: { name: 'Erika Muster', steuernummer: '11/222/33333' },
            });
        });

        await it('picks a free id instead of failing on a duplicate', async () => {
            const manifest = loadManifest(path);
            expect(freeEntityId('Privat', manifest)).toBe('privat-2');
            expect(freeEntityId('Neue Firma', manifest)).toBe('neue-firma');
        });

        await it('leaves the manifest byte-identical when the run is cancelled', async () => {
            const before = readFileSync(path);
            const manifest = loadManifest(path);
            const draft = { ...newEntitySetupDraft(manifest, 'gbr'), name: 'Abgebrochen', taxNumber: '11/222/33333' };
            draft.accounts = ['camt:DE89370400440532013000'];
            entitySetupSections(draft, freeEntityId(draft.name, manifest), manifest);
            accountOwner(manifest, 'camt:DE89370400440532013000');
            // Cancel = applyEntitySetup is never called.
            expect(readFileSync(path).equals(before)).toBe(true);
        });

        await it('adds the entity in one write and moves exact account keys', async () => {
            const draft = {
                ...newEntitySetupDraft(loadManifest(path), 'privat'),
                name: 'Privat',
                veranlagung: 'einzel' as const,
                accounts: ['camt:DE89370400440532013000', 'qonto:123'],
            };
            const id = applyEntitySetup(draft, path);
            expect(id).toBe('privat-2');
            const after = loadManifest(path);
            const created = after.entities.find((e) => e.id === id);
            expect(created?.kind).toBe('privat');
            expect(created?.accounts).toStrictEqual(['camt:DE89370400440532013000', 'qonto:123']);
            expect(created?.est?.veranlagung).toBe('einzel');
            expect(created?.dms?.paperless?.token).toBe('tok-1');
            // The exact key moved; the glob stays with its owner.
            expect(after.entities.find((e) => e.id === 'muster')?.accounts).toStrictEqual(['qonto:*']);
        });

        await it('assigns an account and reports a glob that still matches', async () => {
            const res = assignAccount('qonto:123', 'privat', path);
            expect(res.manifest.entities.find((e) => e.id === 'privat')?.accounts).toStrictEqual(['qonto:123']);
            expect(res.sharedWith).toStrictEqual([{ id: 'muster', name: 'Muster & Partner GbR' }]);

            const moved = assignAccount('camt:DE89370400440532013000', 'privat', path);
            expect(moved.sharedWith).toStrictEqual([]);
            expect(moved.manifest.entities.find((e) => e.id === 'muster')?.accounts).toStrictEqual(['qonto:*']);
        });

        await it('knows the key pattern a new connection will produce', async () => {
            expect(connectionAccountPattern('qonto')).toBe('qonto:*');
            expect(connectionAccountPattern('fints', ' Sparkasse ')).toBe('fints:Sparkasse:*');
            expect(
                importedAccountKeys({
                    format: 'camt',
                    reports: [
                        { accountKey: 'camt:DE89370400440532013000' },
                        { accountKey: 'camt:DE89370400440532013000' },
                    ] as never,
                }),
            ).toStrictEqual(['camt:DE89370400440532013000']);
            expect(
                importedAccountKeys({ format: 'amazon', enrich: { matched: 1, updated: 1, accounts: 1 } }),
            ).toStrictEqual([]);
        });

        await it('routes a connection pattern to an entity', async () => {
            const res = assignAccount(connectionAccountPattern('fints', 'Sparkasse'), 'privat', path);
            expect(res.manifest.entities.find((e) => e.id === 'privat')?.accounts).toStrictEqual(['fints:Sparkasse:*']);
            expect(res.sharedWith).toStrictEqual([]);
        });

        await it('refuses an unknown entity without writing', async () => {
            const before = readFileSync(path);
            let caught: unknown;
            try {
                assignAccount('qonto:123', 'gibt-es-nicht', path);
            } catch (err) {
                caught = err;
            }
            expect(caught instanceof Error).toBe(true);
            expect(readFileSync(path).equals(before)).toBe(true);
        });
    });
};
