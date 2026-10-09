import { describe, it, expect, afterEach } from '@gjsify/unit';
import { readFileSync, rmSync } from 'node:fs';
import {
    matchAccount,
    resolveEntityAccounts,
    defaultAccountScope,
    loadManifest,
    resolveWorkspaceEntities,
    defaultAppSettings,
    parseAppSettings,
    loadAppSettings,
    saveAppSettings,
    loadEntityDms,
    saveEntityDms,
    loadEntityInvoicing,
    saveEntityInvoicing,
    MCP_GROUPS,
    type ElsterConfig,
} from '../../../src/core/config/index.ts';
import { writeManifestFixture } from '../../helpers/manifest-fixture.ts';

const STORE_KEYS = [
    'camt:DE89370400440532013000',
    'camt:DE62370400440532013001',
    'camt:DE35370400440532013002',
    'qonto:01234567-89ab-7cde-8f01-23456789abcd',
    'fints:musterbank-privat:1234567890',
    'fints:musterbank-privat:9876543210',
    'paypal:hauptkonto',
];

export default async () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    function fixture(manifest: Parameters<typeof writeManifestFixture>[0]): string {
        const { dir, path } = writeManifestFixture(manifest);
        dirs.push(dir);
        return path;
    }

    await describe('workspace registry (manifest)', async () => {
        await describe('matchAccount', async () => {
            await it('matches an exact key', async () => {
                expect(matchAccount('qonto:abc', ['qonto:abc'])).toBe(true);
                expect(matchAccount('qonto:abc', ['qonto:abd'])).toBe(false);
            });
            await it('matches a trailing-* prefix glob', async () => {
                expect(matchAccount('camt:DE15...', ['camt:*'])).toBe(true);
                expect(matchAccount('qonto:01234567-x', ['qonto:01234567*'])).toBe(true);
                expect(matchAccount('qonto:019b0000-x', ['qonto:01234567*'])).toBe(false);
            });
            await it('matches against any pattern in the list', async () => {
                expect(matchAccount('fints:x:1', ['camt:*', 'fints:x:*'])).toBe(true);
            });
        });

        await describe('resolveEntityAccounts', async () => {
            await it('expands a glob to the concrete store keys', async () => {
                expect(resolveEntityAccounts({ accounts: ['camt:*'] }, STORE_KEYS)).toStrictEqual([
                    'camt:DE89370400440532013000',
                    'camt:DE62370400440532013001',
                    'camt:DE35370400440532013002',
                ]);
            });
            await it('expands a qonto prefix to the single matching key', async () => {
                expect(resolveEntityAccounts({ accounts: ['qonto:01234567*'] }, STORE_KEYS)).toStrictEqual([
                    'qonto:01234567-89ab-7cde-8f01-23456789abcd',
                ]);
            });
            await it('returns [] when nothing matches', async () => {
                expect(resolveEntityAccounts({ accounts: ['nope:*'] }, STORE_KEYS)).toStrictEqual([]);
            });
        });

        // Regression: a tax report must be scoped to exactly the ELSTER entity's accounts — never a
        // blanket camt:* sum (which let `--entity jumplink` silently sum the whole GbR).
        await describe('defaultAccountScope', async () => {
            const manifest = () =>
                loadManifest(
                    fixture({
                        entities: [
                            { id: 'gbr', name: 'GbR', kind: 'gbr', accounts: ['camt:*'] },
                            {
                                id: 'jumplink',
                                name: 'JumpLink',
                                kind: 'einzelunternehmen',
                                accounts: ['qonto:01234567*'],
                            },
                        ],
                    }),
                );
            const elster = (entity_id?: string) => ({ entity_id }) as unknown as ElsterConfig;

            await it('scopes to ONLY the entity’s accounts — jumplink never pulls in the GbR camt: accounts', async () => {
                expect(defaultAccountScope(manifest(), STORE_KEYS, elster('jumplink'))).toStrictEqual([
                    'qonto:01234567-89ab-7cde-8f01-23456789abcd',
                ]);
            });
            await it('resolves the GbR to its camt: accounts', async () => {
                expect(defaultAccountScope(manifest(), STORE_KEYS, elster('gbr'))).toStrictEqual([
                    'camt:DE89370400440532013000',
                    'camt:DE62370400440532013001',
                    'camt:DE35370400440532013002',
                ]);
            });
            await it('maps the real GbR config id (ledger `artcode`) to the manifest `gbr` via alias', async () => {
                expect(defaultAccountScope(manifest(), STORE_KEYS, elster('artcode'))).toStrictEqual([
                    'camt:DE89370400440532013000',
                    'camt:DE62370400440532013001',
                    'camt:DE35370400440532013002',
                ]);
            });
            await it('returns [] (empty report, NOT a blanket camt:* sum) for an unknown/absent entity', async () => {
                expect(defaultAccountScope(manifest(), STORE_KEYS, elster('nope'))).toStrictEqual([]);
                expect(defaultAccountScope(manifest(), STORE_KEYS, elster(undefined))).toStrictEqual([]);
            });
        });

        await describe('loadManifest + resolveWorkspaceEntities', async () => {
            await it('loads a valid manifest', async () => {
                const path = fixture({
                    entities: [
                        { id: 'gbr', name: 'GbR', kind: 'gbr', accounts: ['camt:*'] },
                        { id: 'privat', name: 'Privat', kind: 'privat', accounts: ['fints:musterbank-privat:*'] },
                    ],
                });
                const m = loadManifest(path);
                expect(m.entities.length).toBe(2);
                expect(m.entities[1].kind).toBe('privat');
            });

            await it('fails loud on a missing manifest', async () => {
                expect(() => loadManifest('/tmp/definitely-missing-steuererklaerung.json')).toThrow(/migrate|Manifest/);
            });

            await it('throws on an invalid manifest (empty entities)', async () => {
                const path = fixture({ entities: [] });
                expect(() => loadManifest(path)).toThrow();
            });

            await it('resolveWorkspaceEntities maps entities to concrete account keys', async () => {
                const path = fixture({
                    entities: [
                        {
                            id: 'gbr',
                            name: 'GbR',
                            kind: 'gbr',
                            accounts: ['camt:*'],
                            elster: { period: { year: 2025, quarter: 1 } },
                        },
                        { id: 'jl', name: 'JumpLink', kind: 'einzelunternehmen', accounts: ['qonto:01234567*'] },
                    ],
                });
                const resolved = resolveWorkspaceEntities(STORE_KEYS, loadManifest(path));
                expect(resolved.length).toBe(2);
                expect(resolved[0].accountKeys.length).toBe(3);
                expect(resolved[0].elster).toBeDefined();
                expect(resolved[1].accountKeys).toStrictEqual(['qonto:01234567-89ab-7cde-8f01-23456789abcd']);
                expect(resolved[1].elster).toBe(undefined);
            });
        });

        await describe('app settings (assistant + MCP)', async () => {
            await it('defaults: assistant on, MCP on, all groups on, read-only', async () => {
                const d = defaultAppSettings();
                expect(d.assistant.enabled).toBe(true);
                expect(d.mcp.enabled).toBe(true);
                expect(d.mcp.allowWrite).toBe(false);
                for (const g of MCP_GROUPS) expect((d.mcp.groups as Record<string, boolean>)[g]).toBe(true);
            });

            await it('parseAppSettings fills defaults from a partial payload', async () => {
                const s = parseAppSettings({ assistant: { enabled: false }, mcp: { groups: { qonto: false } } });
                expect(s.assistant.enabled).toBe(false);
                expect(s.mcp.enabled).toBe(true); // default
                expect(s.mcp.groups.qonto).toBe(false);
                expect(s.mcp.groups.paperless).toBe(true); // default
                expect(s.mcp.allowWrite).toBe(false); // default
            });

            await it('loadAppSettings reads app.assistant/app.mcp from a manifest', async () => {
                const path = fixture({
                    entities: [{ id: 'x', name: 'X', kind: 'gbr', accounts: ['camt:*'] }],
                    app: {
                        assistant: { enabled: false },
                        mcp: { enabled: true, allowWrite: true, groups: { qonto: false } },
                    },
                });
                const s = loadAppSettings(path);
                expect(s.assistant.enabled).toBe(false);
                expect(s.mcp.allowWrite).toBe(true);
                expect(s.mcp.groups.qonto).toBe(false);
                expect(s.mcp.groups.elster).toBe(true);
            });
        });

        await describe('manifest persistence', async () => {
            function persistFixture(): string {
                return fixture({
                    someFutureKey: { keep: 'me' },
                    entities: [
                        { id: 'a', name: 'A', kind: 'gbr', accounts: ['camt:*'] },
                        { id: 'b', name: 'B', kind: 'einzelunternehmen', accounts: ['qonto:*'] },
                    ],
                });
            }

            await it('saveAppSettings writes settings and preserves unknown keys', async () => {
                const path = persistFixture();
                saveAppSettings(defaultAppSettings(), path);
                const raw = JSON.parse(readFileSync(path, 'utf-8'));
                expect(raw.someFutureKey.keep).toBe('me');
                expect(raw.entities.length).toBe(2);
                expect(raw.app.assistant.enabled).toBe(true);
            });

            await it('saveEntityDms targets one entity and keeps a blank token', async () => {
                const path = persistFixture();
                saveEntityDms(
                    'a',
                    { type: 'paperless', paperlessUrl: 'https://p.example', paperlessToken: 's3cret' },
                    path,
                );
                // Re-saving without a token keeps the previously stored one (write-only field).
                saveEntityDms('a', { type: 'paperless', paperlessUrl: 'https://p.example' }, path);
                const a = loadEntityDms('a', path);
                expect(a.type).toBe('paperless');
                expect(a.hasToken).toBe(true);
                expect(loadEntityDms('b', path).type).toBe('builtin');
            });

            await it('saveEntityInvoicing round-trips and rejects unknown entities', async () => {
                const path = persistFixture();
                saveEntityInvoicing(
                    'b',
                    { type: 'self', iban: 'DE02 1203 0000 0000 2020 51', selfNumberPrefix: 'RE-' },
                    path,
                );
                const b = loadEntityInvoicing('b', path);
                expect(b.type).toBe('self');
                expect(b.iban).toBe('DE02120300000000202051');
                expect(b.selfNumberPrefix).toBe('RE-');
                expect(() => saveEntityInvoicing('nope', { type: 'qonto' }, path)).toThrow();
            });

            await it('round-trips the Sie cover-letter defaults and clears them with an empty string', async () => {
                const path = persistFixture();
                expect(loadEntityInvoicing('b', path).defaultHeaderSie).toBe(null); // old config
                saveEntityInvoicing(
                    'b',
                    {
                        type: 'qonto',
                        defaultHeader: 'Hallo {anrede},',
                        defaultHeaderSie: 'Guten Tag {anrede},',
                        defaultClosingSie: 'MfG',
                    },
                    path,
                );
                const b = loadEntityInvoicing('b', path);
                expect(b.defaultHeader).toBe('Hallo {anrede},');
                expect(b.defaultHeaderSie).toBe('Guten Tag {anrede},');
                expect(b.defaultClosingSie).toBe('MfG');
                saveEntityInvoicing('b', { type: 'qonto', defaultHeaderSie: '' }, path);
                const c = loadEntityInvoicing('b', path);
                expect(c.defaultHeaderSie).toBe(null);
                expect(c.defaultClosingSie).toBe('MfG'); // omitted = untouched
                expect(c.defaultHeader).toBe('Hallo {anrede},');
            });

            await it('preserves the issuer + numberPrefix when a later save omits them', async () => {
                const path = persistFixture();
                saveEntityInvoicing(
                    'b',
                    {
                        type: 'self',
                        selfNumberPrefix: 'RE-',
                        selfIssuer: { name: 'JumpLink', taxNumber: '12/345/67890', kleinunternehmer: true },
                    },
                    path,
                );
                // The settings UI later saves ONLY type + iban + terms (no issuer/prefix).
                saveEntityInvoicing('b', { type: 'self', iban: 'DE02120300000000202051', paymentTermsDays: 30 }, path);
                const b = loadEntityInvoicing('b', path);
                expect(b.selfNumberPrefix).toBe('RE-'); // NOT wiped
                expect(b.selfIssuer?.name).toBe('JumpLink'); // NOT wiped
                expect(b.selfIssuer?.kleinunternehmer).toBe(true);
                expect(b.iban).toBe('DE02120300000000202051');
                expect(b.paymentTermsDays).toBe(30);
            });
        });
    });
};
