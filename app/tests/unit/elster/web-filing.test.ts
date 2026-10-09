import { describe, it, expect } from '@gjsify/unit';
import { planWebFiling, type RecordWebFilingOptions } from '../../../src/core/actions/elster/web-filing.ts';

function opts(over: Partial<RecordWebFilingOptions> = {}): RecordWebFilingOptions {
    return { entity: 'gbr', year: 2025, form: 'feststellung', transferticket: 'ep1963i9uaqkaw', ...over };
}

export default async () => {
    await describe('planWebFiling', async () => {
        await it('maps the form to its filing kind + carries the Transferticket in the note', async () => {
            const p = planWebFiling(opts({ form: 'uste' }), '2026-07-15');
            expect(p.kind).toBe('ust-jahr'); // uste ⇒ the annual ust-jahr obligation
            expect(p.period).toBe('2025');
            expect(p.snapshotable).toBe(true);
            expect(p.note).toContain('ep1963i9uaqkaw');
            expect(p.note).toContain('Web-Formular');
        });

        await it('keys a USt-VA by its Voranmeldungszeitraum, not the bare year', async () => {
            // The register is keyed by (entity, kind, period): a bare-year period would make
            // Q1..Q4 overwrite each other and corrupt the Vorauszahlungssoll (Z119).
            expect(planWebFiling(opts({ form: 'ustva', year: 2026, quarter: 1 }), '2026-07-15').period).toBe('2026-Q1');
            expect(planWebFiling(opts({ form: 'ustva', year: 2026, quarter: 4 }), '2026-07-15').period).toBe('2026-Q4');
            expect(planWebFiling(opts({ form: 'ustva', year: 2026, month: 3 }), '2026-07-15').period).toBe('2026-03');
        });

        await it('refuses a USt-VA without a period instead of silently using the year', async () => {
            expect(() => planWebFiling(opts({ form: 'ustva', year: 2026 }), '2026-07-15')).toThrow();
            expect(() => planWebFiling(opts({ form: 'ustva', year: 2026, quarter: 5 }), '2026-07-15')).toThrow();
            expect(() => planWebFiling(opts({ form: 'ustva', year: 2026, month: 13 }), '2026-07-15')).toThrow();
            expect(() =>
                planWebFiling(opts({ form: 'ustva', year: 2026, quarter: 1, month: 3 }), '2026-07-15'),
            ).toThrow();
        });

        await it('rejects a Voranmeldungszeitraum on the annual forms', async () => {
            expect(() => planWebFiling(opts({ form: 'uste', quarter: 1 }), '2026-07-15')).toThrow();
        });

        await it('defaults the date to today but honours an explicit date', async () => {
            expect(planWebFiling(opts(), '2026-07-15').date).toBe('2026-07-15');
            expect(planWebFiling(opts({ date: '2026-07-14' }), '2026-07-15').date).toBe('2026-07-14');
        });

        await it('marks est as non-snapshotable (no ELSTER XML builder) but still records it', async () => {
            const p = planWebFiling(opts({ form: 'est' }), '2026-07-15');
            expect(p.snapshotable).toBe(false);
            expect(p.kind).toBe('est');
        });

        await it('maps the remaining forms to the Steuertermine kinds', async () => {
            expect(planWebFiling(opts({ form: 'gewst' }), '2026-07-15').kind).toBe('gewst');
            expect(planWebFiling(opts({ form: 'feststellung' }), '2026-07-15').kind).toBe('feststellung');
            expect(planWebFiling(opts({ form: 'euer' }), '2026-07-15').kind).toBe('euer');
            expect(planWebFiling(opts({ form: 'ustva', quarter: 1 }), '2026-07-15').kind).toBe('ustva');
        });

        await it('records who filed it in the note when given', async () => {
            expect(planWebFiling(opts({ recordedBy: 'Max' }), '2026-07-15').note).toContain('erfasst von Max');
        });

        await it('REFUSES a blank Transferticket — it is never fabricated', async () => {
            expect(() => planWebFiling(opts({ transferticket: '   ' }), '2026-07-15')).toThrow();
            expect(() => planWebFiling(opts({ transferticket: '' }), '2026-07-15')).toThrow();
        });

        await it('rejects a malformed date', async () => {
            expect(() => planWebFiling(opts({ date: '15.07.2026' }), '2026-07-15')).toThrow();
        });
    });
};
