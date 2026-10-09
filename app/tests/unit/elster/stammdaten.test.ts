import { describe, it, expect } from '@gjsify/unit';
import { buildStammdaten } from '../../../src/core/actions/elster/stammdaten.ts';
import type { ElsterConfig } from '../../../src/core/config/index.ts';

/** A minimal ELSTER config with fictional Muster values; override the parts under test. */
function elster(over: Partial<ElsterConfig> = {}): ElsterConfig {
    return {
        tax_number: '18/815/08152',
        schema_version: 2025,
        period: { year: 2025, quarter: 4 },
        output_directory: '/tmp',
        test_mode: true,
        taxation_basis: 'ist',
        ust_dauerfristverlaengerung: false,
        exclude_tags: [],
        include_tags: [],
        entity_id: 'artcode',
        account_labels: {},
        gesellschafter: [],
        business_end_date: '2025-10-31',
        betrieb: {
            name: 'Muster & Partner GbR',
            strasse: 'Musterweg',
            hausnummer: '7a',
            plz: '12345',
            ort: 'Musterstadt',
            art: 'visuelle Kommunikation',
            ust_idnr: 'DE123456789',
            widnr: 'DE987654321',
        },
        ...over,
    };
}

export default async () => {
    await describe('buildStammdaten', async () => {
        await it('surfaces the master data with the address split into separate fields', async () => {
            const s = buildStammdaten(elster(), 'gbr');
            expect(s.entityId).toBe('gbr');
            expect(s.name).toBe('Muster & Partner GbR');
            expect(s.art).toBe('visuelle Kommunikation');
            expect(s.anschrift.strasse).toBe('Musterweg');
            expect(s.anschrift.hausnummer).toBe('7a');
            expect(s.anschrift.plz).toBe('12345');
            expect(s.anschrift.ort).toBe('Musterstadt');
            expect(s.ustIdNr).toBe('DE123456789');
            expect(s.wIdNr).toBe('DE987654321');
            expect(s.businessEndDate).toBe('2025-10-31');
            expect(s.versteuerung).toBe('ist');
        });

        await it('derives the 13-digit ELSTER Steuernummer + Bundesfinanzamtsnummer', async () => {
            const s = buildStammdaten(elster(), 'gbr');
            expect(s.steuernummer).toBe('18/815/08152');
            // Niedersachsen "18" → BUFA prefix "23": 18/815/08152 → 2318 0 815 08152.
            expect(s.steuernummerElster).toBe('2318081508152');
            expect(s.finanzamtBufa).toBe('2318');
        });

        await it('splits the Hausnummer from the street when not set explicitly', async () => {
            const s = buildStammdaten(
                elster({
                    betrieb: {
                        name: 'X',
                        strasse: 'Musterstraße 12',
                        plz: '12345',
                        ort: 'Musterstadt',
                        art: 'IT',
                    },
                }),
                'gbr',
            );
            expect(s.anschrift.strasse).toBe('Musterstraße');
            expect(s.anschrift.hausnummer).toBe('12');
        });

        await it('reports null Rechtsform/Einkunftsart when unset (forms apply their defaults)', async () => {
            const s = buildStammdaten(elster(), 'gbr');
            expect(s.rechtsform).toBeNull();
            expect(s.einkunftsart).toBeNull();
        });

        await it('carries the configured Rechtsform/Einkunftsart + Soll-Versteuerung when set', async () => {
            const base = elster();
            const s = buildStammdaten(
                elster({
                    taxation_basis: 'soll',
                    betrieb: { ...base.betrieb!, rechtsform: '270', einkunftsart: '2' },
                }),
                'jumplink',
            );
            expect(s.rechtsform).toBe('270');
            expect(s.einkunftsart).toBe('2');
            expect(s.versteuerung).toBe('soll');
        });

        await it('yields a null Anschrift + null derived numbers when the betrieb block is missing', async () => {
            const s = buildStammdaten(elster({ betrieb: undefined, tax_number: '' }), 'privat');
            expect(s.name).toBeNull();
            expect(s.anschrift).toStrictEqual({ strasse: null, hausnummer: null, plz: null, ort: null });
            expect(s.steuernummerElster).toBeNull();
            expect(s.finanzamtBufa).toBeNull();
        });
    });
};
