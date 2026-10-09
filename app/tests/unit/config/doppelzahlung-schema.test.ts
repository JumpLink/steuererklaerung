import { describe, it, expect } from '@gjsify/unit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ElsterConfigRawSchema, normalizeElsterConfig } from '../../../src/core/config/schema/elster.ts';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'legacy-config', 'elster-config.json');

export default async () => {
    await describe('elster schema — doppelzahlungen / zahlungen_geprueft', async () => {
        await it('loads an old config without the new fields (defaults applied)', async () => {
            const cfg = normalizeElsterConfig(ElsterConfigRawSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf-8'))));
            const dz = cfg.adjustments?.doppelzahlungen ?? [];
            expect(dz.length).toBeGreaterThan(0);
            expect(dz[0].rechnung_id).toBe(undefined);
            expect(dz[0].rueckzahlung_transaktion_id).toBe(undefined);
            expect(cfg.adjustments?.zahlungen_geprueft).toStrictEqual([]);
        });

        await it('accepts the new optional fields and the geprueft decisions', async () => {
            const raw = JSON.parse(readFileSync(FIXTURE, 'utf-8'));
            raw.adjustments.doppelzahlungen = [
                {
                    transaktion_id: 'tx-1',
                    rechnung_id: 'inv-1',
                    rueckzahlung_transaktion_id: 'tx-2',
                    rueckzahlung_am: '2026-05-01',
                },
            ];
            raw.adjustments.zahlungen_geprueft = [
                { transaktion_id: 'tx-3', entscheidung: 'andere_rechnung', rechnung_id: 'inv-2' },
                { transaktion_id: 'tx-4', entscheidung: 'in_ordnung' },
            ];
            const cfg = normalizeElsterConfig(ElsterConfigRawSchema.parse(raw));
            expect(cfg.adjustments?.doppelzahlungen[0].rueckzahlung_transaktion_id).toBe('tx-2');
            expect(cfg.adjustments?.doppelzahlungen[0].rueckzahlung_am).toBe('2026-05-01');
            expect(cfg.adjustments?.zahlungen_geprueft.length).toBe(2);
        });

        await it('rejects an unknown entscheidung', async () => {
            const raw = JSON.parse(readFileSync(FIXTURE, 'utf-8'));
            raw.adjustments.zahlungen_geprueft = [{ transaktion_id: 'tx-3', entscheidung: 'egal' }];
            expect(ElsterConfigRawSchema.safeParse(raw).success).toBe(false);
        });
    });
};
