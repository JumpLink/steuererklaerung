import { describe, it, expect } from '@gjsify/unit';
import {
    steuerkontoScope,
    steuernummerToken,
    type SteuerkontoScope,
} from '../../../src/core/actions/elster/steuerkonto.ts';
import type { Manifest } from '../../../src/core/config/index.ts';

/**
 * The Steuerkonto overview attributes a Finanzamt booking to an entity purely by the
 * Steuernummer in its reference text. Those numbers used to be compiled in — three of them,
 * belonging to one person — which made the report wrong (and the app useless) for anyone else.
 * These tests pin the replacement: every number comes from the manifest.
 */

/** A manifest with fictional Muster entities; `over` replaces the entity list wholesale. */
function manifest(entities: Manifest['entities']): Manifest {
    return { version: 1, entities } as Manifest;
}

type Entity = Manifest['entities'][number];

function business(id: string, name: string, taxNumber: string, extra: Partial<Entity> = {}): Entity {
    return {
        id,
        name,
        kind: 'gbr',
        accounts: [],
        elster: { tax_number: taxNumber },
        ...extra,
    } as unknown as Entity;
}

function privat(id: string, name: string, steuernummer?: string): Entity {
    return {
        id,
        name,
        kind: 'privat',
        accounts: [],
        est: steuernummer ? { person: { steuernummer } } : {},
    } as unknown as Entity;
}

function labels(scope: SteuerkontoScope): string[] {
    return scope.entities.map((e) => e.label);
}

export default async () => {
    await describe('steuernummerToken', async () => {
        await it('takes the last block of a regional Steuernummer', async () => {
            expect(steuernummerToken('11/222/33333')).toBe('33333');
            expect(steuernummerToken('9/111/22222')).toBe('22222');
        });

        await it('takes the trailing five digits of a 13-digit ELSTER number', async () => {
            expect(steuernummerToken('9198011310010')).toBe('10010');
        });

        await it('ignores punctuation and whitespace inside the block', async () => {
            expect(steuernummerToken(' 11 / 222 / 3 33 33 ')).toBe('33333');
        });

        await it('refuses a token too short to match on safely', async () => {
            // A 3-digit needle would hit half the amounts in a bank file.
            expect(steuernummerToken('11/222/333')).toBe('');
            expect(steuernummerToken('')).toBe('');
            expect(steuernummerToken('   ')).toBe('');
        });
    });

    await describe('steuerkontoScope', async () => {
        await it('derives one entry per configured Steuernummer, business and private alike', async () => {
            const scope = steuerkontoScope(
                manifest([
                    business('gbr', 'Muster & Partner GbR', '11/222/33333'),
                    business('solo', 'Muster Einzelunternehmen', '11/222/44444'),
                    privat('privat', 'Privat', '11/222/55555'),
                ]),
            );
            expect(scope.entities.map((e) => e.token)).toStrictEqual(['33333', '44444', '55555']);
            expect(labels(scope)).toStrictEqual([
                'Muster & Partner GbR (11/222/33333)',
                'Muster Einzelunternehmen (11/222/44444)',
                'Privat (11/222/55555)',
            ]);
            expect(scope.entities.map((e) => e.business)).toStrictEqual([true, true, false]);
        });

        await it('lets the first entity keep a Steuernummer two entities share', async () => {
            // A sole trader and its owner's private return legitimately file under one number.
            const scope = steuerkontoScope(
                manifest([
                    business('solo', 'Muster Einzelunternehmen', '11/222/44444'),
                    privat('privat', 'Privat', '11/222/44444'),
                ]),
            );
            expect(scope.entities.length).toBe(1);
            expect(labels(scope)).toStrictEqual(['Muster Einzelunternehmen (11/222/44444)']);
        });

        await it('skips entities without a usable Steuernummer instead of inventing one', async () => {
            const scope = steuerkontoScope(
                manifest([business('gbr', 'Muster & Partner GbR', ''), privat('zweit', 'Zweite Person')]),
            );
            expect(scope.entities).toStrictEqual([]);
        });

        await it('collects the own-account names used to spot internal tax transfers', async () => {
            const scope = steuerkontoScope(
                manifest([
                    business('gbr', 'Muster & Partner GbR', '11/222/33333', {
                        elster: {
                            tax_number: '11/222/33333',
                            account_labels: { 'camt:DE89370400440532013000': 'Hauptkonto Muster' },
                        },
                    } as unknown as Partial<Entity>),
                ]),
            );
            expect(scope.ownAccountNames.includes('muster & partner gbr')).toBe(true);
            expect(scope.ownAccountNames.includes('hauptkonto muster')).toBe(true);
        });

        await it('marks only business entities as Gewerbesteuer-capable', async () => {
            // An untagged Gewerbesteuer flow falls back to the first business entity; a private
            // entity never owes Gewerbesteuer, so it must never be that fallback.
            const scope = steuerkontoScope(
                manifest([
                    privat('privat', 'Privat', '11/222/55555'),
                    business('gbr', 'Muster & Partner GbR', '11/222/33333'),
                ]),
            );
            expect(scope.entities.find((e) => e.business)?.label).toBe('Muster & Partner GbR (11/222/33333)');
        });
    });
};
