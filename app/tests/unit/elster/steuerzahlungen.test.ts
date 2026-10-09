import { describe, it, expect } from '@gjsify/unit';
import {
    addOneMonthClamped,
    computeBescheidAbweichungen,
    computeOffeneSteuerzahlungen,
    shiftToBusinessDay,
    type SteuerzahlungEntity,
} from '../../../src/core/elster/steuerzahlungen.ts';
import type { Filing } from '@steuererklaerung/store';

const TODAY = '2026-07-18';
const AT = '2026-07-18T10:00:00.000Z';

/** A filed, unpaid filing with sensible defaults; override any field. */
function filing(over: Partial<Filing>): Filing {
    return {
        entityId: 'jumplink',
        kind: 'ustva',
        period: '2026-Q1',
        filedAt: '2026-07-15',
        paidAt: null,
        amount: null,
        declaredAmount: 34.41,
        surcharge: null,
        assessedAmount: null,
        assessedAt: null,
        note: null,
        createdAt: AT,
        updatedAt: AT,
        ...over,
    };
}

const jumplink: SteuerzahlungEntity = {
    ids: ['jumplink'],
    entityId: 'jumplink',
    entityName: 'JumpLink',
    dauerfrist: true,
};
const gbr: SteuerzahlungEntity = {
    ids: ['gbr', 'artcode'],
    entityId: 'gbr',
    entityName: 'Muster & Partner GbR',
    dauerfrist: false,
};
const ENTITIES = [jumplink, gbr];

export default async () => {
    await describe('steuerzahlungen — date helpers', async () => {
        await it('shifts Saturday and Sunday deadlines to the following Monday (§108 Abs. 3 AO)', async () => {
            expect(shiftToBusinessDay('2026-08-15')).toBe('2026-08-17'); // Sat → Mon
            expect(shiftToBusinessDay('2026-05-10')).toBe('2026-05-11'); // Sun → Mon
            expect(shiftToBusinessDay('2026-08-17')).toBe('2026-08-17'); // Mon stays
        });

        await it('adds one Fristende-month, clamped to the shorter month (§188 BGB)', async () => {
            expect(addOneMonthClamped('2026-07-15')).toBe('2026-08-15');
            expect(addOneMonthClamped('2026-01-31')).toBe('2026-02-28'); // clamp: Feb has no 31st
            expect(addOneMonthClamped('2026-12-15')).toBe('2027-01-15'); // year rollover
        });
    });

    await describe('computeOffeneSteuerzahlungen — USt-VA', async () => {
        await it('puts the Zahllast due on the statutory VA deadline (Dauerfrist + weekend shift), overdue when filed late', async () => {
            const z = computeOffeneSteuerzahlungen([filing({})], ENTITIES, TODAY);
            expect(z.length).toBe(1);
            // Q1 + Dauerfrist → 10 May 2026 (Sunday) → Monday 11 May; filed 15 Jul ⇒ long overdue.
            expect(z[0].dueDate).toBe('2026-05-11');
            expect(z[0].overdue).toBe(true);
            expect(z[0].amount).toBe(34.41);
            expect(z[0].label).toBe('USt-VA Q1/2026 — Zahllast');
            expect(z[0].key).toBe('jumplink:ustva:2026-Q1:zahlung');
        });

        await it('uses the early base deadline without Dauerfrist', async () => {
            const z = computeOffeneSteuerzahlungen(
                [filing({ entityId: 'gbr', period: '2025-Q4', declaredAmount: 440.57 })],
                ENTITIES,
                TODAY,
            );
            // Q4/2025 base → 10 Jan 2026 (Saturday) → Monday 12 Jan.
            expect(z[0].dueDate).toBe('2026-01-12');
        });

        await it('resolves the entity under a ledger alias (artcode ⇒ gbr)', async () => {
            const z = computeOffeneSteuerzahlungen(
                [filing({ entityId: 'artcode', period: '2025-Q4', declaredAmount: 100 })],
                ENTITIES,
                TODAY,
            );
            expect(z[0].entityId).toBe('gbr');
            expect(z[0].entityName).toBe('Muster & Partner GbR');
        });
    });

    await describe('computeOffeneSteuerzahlungen — USt-Jahr', async () => {
        await it('falls due one month after Eingang (§18 Abs. 4 UStG), weekend-shifted', async () => {
            const z = computeOffeneSteuerzahlungen(
                [filing({ entityId: 'gbr', kind: 'ust-jahr', period: '2025', declaredAmount: 1091.16 })],
                ENTITIES,
                TODAY,
            );
            // filed 15 Jul → 15 Aug 2026 (Saturday) → Monday 17 Aug.
            expect(z[0].dueDate).toBe('2026-08-17');
            expect(z[0].overdue).toBe(false);
            expect(z[0].label).toBe('USt-Jahreserklärung 2025 — Abschlusszahlung');
        });
    });

    await describe('computeOffeneSteuerzahlungen — filtering', async () => {
        await it('skips paid, unfiled, refund and no-payment-kind rows', async () => {
            const z = computeOffeneSteuerzahlungen(
                [
                    filing({ paidAt: '2026-07-16' }), // paid
                    filing({ period: '2026-Q2', filedAt: null }), // not filed
                    filing({ period: '2026-Q3', declaredAmount: -12.5 }), // Erstattung
                    filing({ kind: 'feststellung', period: '2025', declaredAmount: 100 }), // never a payment
                    filing({ kind: 'dauerfrist', period: '2026', declaredAmount: 100 }), // never a payment
                ],
                ENTITIES,
                TODAY,
            );
            expect(z.length).toBe(0);
        });

        await it('prefers the declared Soll over the legacy amount', async () => {
            const z = computeOffeneSteuerzahlungen([filing({ declaredAmount: 34.41, amount: 35.91 })], ENTITIES, TODAY);
            expect(z[0].amount).toBe(34.41);
        });

        await it('lists Bescheid-driven kinds (gewst/est) without a due date, sorted last', async () => {
            const z = computeOffeneSteuerzahlungen(
                [
                    filing({ kind: 'est', period: '2025', declaredAmount: 500 }),
                    filing({ entityId: 'gbr', kind: 'ust-jahr', period: '2025', declaredAmount: 1091.16 }),
                ],
                ENTITIES,
                TODAY,
            );
            expect(z.length).toBe(2);
            expect(z[0].kind).toBe('ust-jahr'); // dated first
            expect(z[1].kind).toBe('est');
            expect(z[1].dueDate).toBeNull();
            expect(z[1].overdue).toBe(false);
            expect(z[1].note).toContain('Bescheid');
        });

        await it('keeps an unknown register entity visible with safe defaults (no Dauerfrist)', async () => {
            const z = computeOffeneSteuerzahlungen(
                [filing({ entityId: 'fremd', period: '2026-Q1', declaredAmount: 10 })],
                ENTITIES,
                TODAY,
            );
            expect(z[0].entityName).toBe('fremd');
            // No Dauerfrist assumed → early base deadline 10 Apr 2026 (Friday, no shift).
            expect(z[0].dueDate).toBe('2026-04-10');
        });
    });

    /**
     * The Finanzamt's own figure decides what is owed.
     *
     * The live case: the GbR declared an Abschlusszahlung of 1.091,16 € for USt 2025, and the
     * Finanzamt's Abrechnung came back with a 354,98 € REFUND — it had counted 1.886,71 € as
     * already paid where the declaration named a Vorauszahlungssoll of 440,57 €. Before the
     * assessed figure existed, the tracker kept demanding 1.091,16 € that nobody owed, and the
     * only way to silence it would have been to overwrite the declared figure — destroying the
     * Z119 basis and the comparison in one move.
     */
    await describe('assessed amount overrides the declared Soll', async () => {
        await it('drops a filing the Finanzamt settled as a refund', async () => {
            const f = filing({
                entityId: 'gbr',
                kind: 'ust-jahr',
                period: '2025',
                filedAt: '2025-07-15',
                declaredAmount: 1091.16,
                assessedAmount: -354.98,
                assessedAt: '2026-09-01',
            });
            expect(computeOffeneSteuerzahlungen([f], ENTITIES, TODAY).length).toBe(0);
        });

        await it('still lists it as open without a Bescheid — the discriminator', async () => {
            const f = filing({
                entityId: 'gbr',
                kind: 'ust-jahr',
                period: '2025',
                filedAt: '2025-07-15',
                declaredAmount: 1091.16,
            });
            const out = computeOffeneSteuerzahlungen([f], ENTITIES, TODAY);
            expect(out.length).toBe(1);
            expect(out[0].amount).toBe(1091.16);
            expect(out[0].amountSource).toBe('declared');
        });

        await it('uses the assessed figure when the Finanzamt asks for MORE', async () => {
            const f = filing({ declaredAmount: 34.41, assessedAmount: 51.0, assessedAt: '2026-08-01' });
            const out = computeOffeneSteuerzahlungen([f], ENTITIES, TODAY);
            expect(out.length).toBe(1);
            expect(out[0].amount).toBe(51.0);
            expect(out[0].amountSource).toBe('assessed');
        });

        await it('leaves the declared figure untouched — Z119 must keep summing what we sent', async () => {
            const f = filing({ declaredAmount: 1091.16, assessedAmount: -354.98 });
            expect(f.declaredAmount).toBe(1091.16);
        });
    });

    await describe('computeBescheidAbweichungen', async () => {
        await it('reports the gap between declaration and Bescheid', async () => {
            const f = filing({
                entityId: 'gbr',
                kind: 'ust-jahr',
                period: '2025',
                declaredAmount: 1091.16,
                assessedAmount: -354.98,
                assessedAt: '2026-09-01',
            });
            const out = computeBescheidAbweichungen([f], ENTITIES);
            expect(out.length).toBe(1);
            expect(out[0].difference).toBe(-1446.14);
            expect(out[0].entityName).toBe('Muster & Partner GbR');
            expect(out[0].assessedAt).toBe('2026-09-01');
        });

        await it('reports a settled filing too — that is why it is not part of the open list', async () => {
            // The refund case is PAID/closed and vanishes from every payment view. If the
            // divergence were only reported there, a 1.446,14 € gap would be visible nowhere.
            const f = filing({
                kind: 'ust-jahr',
                period: '2025',
                paidAt: '2026-09-09',
                declaredAmount: 1091.16,
                assessedAmount: -354.98,
            });
            expect(computeOffeneSteuerzahlungen([f], ENTITIES, TODAY).length).toBe(0);
            expect(computeBescheidAbweichungen([f], ENTITIES).length).toBe(1);
        });

        await it('stays silent when the Bescheid matches', async () => {
            const f = filing({ declaredAmount: 186.4, assessedAmount: 186.4 });
            expect(computeBescheidAbweichungen([f], ENTITIES).length).toBe(0);
        });

        await it('ignores float noise below a cent', async () => {
            const f = filing({ declaredAmount: 0.1 + 0.2, assessedAmount: 0.3 });
            expect(computeBescheidAbweichungen([f], ENTITIES).length).toBe(0);
        });

        await it('says nothing without a Bescheid, and nothing without a declaration', async () => {
            expect(computeBescheidAbweichungen([filing({})], ENTITIES).length).toBe(0);
            // A legacy row carries a PAYMENT in `amount`; "Bescheid ≠ payment" is a different
            // statement and must not be reported as a divergence from a declaration.
            const legacy = filing({ declaredAmount: null, amount: 440.57, assessedAmount: 500 });
            expect(computeBescheidAbweichungen([legacy], ENTITIES).length).toBe(0);
        });
    });
};
