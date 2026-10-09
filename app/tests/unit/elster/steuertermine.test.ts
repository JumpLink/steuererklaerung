import { describe, it, expect } from '@gjsify/unit';
import { computeSteuertermine, type SteuerTerminEntity } from '../../../src/core/elster/steuertermine.ts';

const TODAY = '2026-07-04';

/** JumpLink-like active Einzelunternehmen: quarterly USt-VA, started Nov 2025, no Dauerfrist. */
const jumplink: SteuerTerminEntity = {
    entityId: 'jumplink',
    entityName: 'JumpLink',
    ustCadence: 'quarter',
    dauerfrist: false,
    filesUst: true,
    isGbr: false,
    hasGewerbe: false,
    businessStart: '2025-11-01',
};

/** GbR-like ceased business: quarterly, ended Oct 2025, Gewerbe + 2 Gesellschafter. */
const gbr: SteuerTerminEntity = {
    entityId: 'gbr',
    entityName: 'Muster & Partner GbR',
    ustCadence: 'quarter',
    dauerfrist: false,
    filesUst: true,
    isGbr: true,
    hasGewerbe: true,
    businessEnd: '2025-10-31',
};

export default async () => {
    await describe('computeSteuertermine — USt-VA (quarterly, future-only)', async () => {
        const t = computeSteuertermine(jumplink, TODAY, 200);

        await it('surfaces the upcoming Q2/2026 at the base deadline (10 Jul), not overdue', async () => {
            const q2 = t.find((x) => x.key === 'jumplink:ustva:2026-Q2');
            expect(q2?.dueDate).toBe('2026-07-10');
            expect(q2?.daysUntil).toBe(6);
            expect(q2?.overdue).toBe(false);
            expect(q2?.estimated).toBe(true);
        });

        await it('does NOT list already-past periods (Q1/2026 is handled by the reactive layer)', async () => {
            expect(t.some((x) => x.key === 'jumplink:ustva:2026-Q1')).toBe(false);
        });

        await it('lists the next few quarters within the horizon (Q2, Q3, Q4 2026)', async () => {
            const vaKeys = t.filter((x) => x.kind === 'ustva').map((x) => x.period);
            expect(vaKeys).toStrictEqual(['2026-Q2', '2026-Q3', '2026-Q4']);
        });

        await it('never emits a VA for a period before the business began', async () => {
            expect(t.some((x) => x.kind === 'ustva' && x.period.startsWith('2025'))).toBe(false);
        });
    });

    await describe('computeSteuertermine — Dauerfristverlängerung', async () => {
        await it('shifts every USt-VA deadline by one month when granted', async () => {
            const t = computeSteuertermine({ ...jumplink, dauerfrist: true }, TODAY, 200);
            const q2 = t.find((x) => x.key === 'jumplink:ustva:2026-Q2');
            expect(q2?.dueDate).toBe('2026-08-10');
            expect(q2?.note).toContain('inkl. Dauerfristverlängerung');
        });

        await it('notes the missing extension as a caveat when not granted', async () => {
            const t = computeSteuertermine(jumplink, TODAY, 200);
            const q2 = t.find((x) => x.key === 'jumplink:ustva:2026-Q2');
            expect(q2?.note).toContain('ohne Dauerfristverlängerung');
        });
    });

    await describe('computeSteuertermine — Jahreserklärungen', async () => {
        await it('emits USt-Jahres + Anlage EÜR for an Einzelunternehmer, due 31 Jul (base §149)', async () => {
            const t = computeSteuertermine(jumplink, TODAY, 200);
            const annual = t.filter((x) => x.period === '2025').map((x) => x.kind);
            expect(annual).toStrictEqual(['euer', 'ust-jahr']); // sorted by key: euer < ust-jahr
            const euer = t.find((x) => x.key === 'jumplink:euer:2025');
            expect(euer?.dueDate).toBe('2026-07-31');
            expect(euer?.note).toContain('§149');
        });

        await it('emits USt-Jahres + Feststellung + GewSt for a GbR', async () => {
            const t = computeSteuertermine(gbr, TODAY, 200);
            const annual = t
                .filter((x) => x.period === '2025')
                .map((x) => x.kind)
                .sort();
            expect(annual).toStrictEqual(['feststellung', 'gewst', 'ust-jahr']);
            expect(t.every((x) => x.dueDate === '2026-07-31')).toBe(true); // GbR has no future VAs
        });
    });

    await describe('computeSteuertermine — ceased business', async () => {
        await it('emits NO USt-VA after the business ended', async () => {
            const t = computeSteuertermine(gbr, TODAY, 200);
            expect(t.some((x) => x.kind === 'ustva')).toBe(false);
        });
    });

    await describe('computeSteuertermine — non-USt entity', async () => {
        await it('emits nothing when there is no USt cadence and no obligations', async () => {
            const priv: SteuerTerminEntity = {
                entityId: 'privat',
                entityName: 'Privat',
                ustCadence: null,
                dauerfrist: false,
                filesUst: false,
                isGbr: false,
                hasGewerbe: false,
            };
            const t = computeSteuertermine(priv, TODAY, 200);
            expect(t).toStrictEqual([]);
        });
    });

    await describe('computeSteuertermine — private Einkommensteuer', async () => {
        const priv: SteuerTerminEntity = {
            entityId: 'privat',
            entityName: 'Privat',
            ustCadence: null,
            dauerfrist: false,
            filesUst: false,
            isGbr: false,
            hasGewerbe: false,
            filesEst: true,
        };

        await it('emits ONLY the annual est deadline for an est-only entity (31 Jul, §149 base)', async () => {
            const t = computeSteuertermine(priv, TODAY, 200);
            expect(t.map((x) => x.key)).toStrictEqual(['privat:est:2025']);
            expect(t[0].dueDate).toBe('2026-07-31');
            expect(t[0].label).toBe('Einkommensteuererklärung 2025');
            expect(t[0].note).toContain('§149');
        });

        await it('adds est independently of a ceased business window', async () => {
            // A ceased GbR-like entity that ALSO files a private ESt: the business annuals stay
            // gated on the business window, the est deadline is not.
            const t = computeSteuertermine({ ...gbr, filesEst: true, businessEnd: '2023-06-30' }, TODAY, 200);
            expect(t.some((x) => x.kind === 'est' && x.period === '2025')).toBe(true);
            expect(t.some((x) => x.kind === 'ust-jahr')).toBe(false); // business over before 2025
        });
    });
};
