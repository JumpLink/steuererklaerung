import { afterEach, beforeEach, describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    getTaxAssessment,
    type LedgerDatabase,
    listTaxAssessments,
    migrate,
    openLedger,
    removeTaxAssessment,
    upsertTaxAssessment,
} from '@steuererklaerung/store';
import { scanZvEFromBescheid } from '../../../src/core/elster/zve-bescheid.ts';
import { getZvE, listZvE, recordZvE, removeZvE } from '../../../src/core/actions/zve.ts';

// Every figure here is INVENTED. Tax data is data_scope = privat: no real amount, no real
// Steuernummer, no real name ever enters a fixture.
const AT = '2026-08-13T10:00:00.000Z';

function fresh(): LedgerDatabase {
    const db = openLedger(':memory:');
    migrate(db);
    return db;
}

export default async () => {
    await describe('tax assessments repo (schema v13)', async () => {
        await it('records a year with its Bescheid reference and reads it back', async () => {
            const db = fresh();
            const saved = upsertTaxAssessment(
                db,
                { entityId: 'privat', year: 2024, zve: 40000, documentRef: 'paperless:111' },
                AT,
            );
            expect(saved.zve).toBe(40000);
            expect(saved.documentRef).toBe('paperless:111');
            expect(saved.recordedAt).toBe(AT);
            expect(saved.createdAt).toBe(AT);
            expect(getTaxAssessment(db, 'privat', 2024)?.zve).toBe(40000);
            db.close();
        });

        await it('an Änderungsbescheid REPLACES the figure and refreshes the capture date', async () => {
            const db = fresh();
            upsertTaxAssessment(db, { entityId: 'privat', year: 2024, zve: 40000, documentRef: 'paperless:111' }, AT);
            const later = '2026-09-01T08:00:00.000Z';
            const changed = upsertTaxAssessment(
                db,
                { entityId: 'privat', year: 2024, zve: 38500, documentRef: 'paperless:222', note: 'Änderungsbescheid' },
                later,
            );
            expect(changed.zve).toBe(38500);
            expect(changed.documentRef).toBe('paperless:222');
            expect(changed.recordedAt).toBe(later);
            // The first capture stays on the row as the audit trail.
            expect(changed.createdAt).toBe(AT);
            expect(listTaxAssessments(db).length).toBe(1);
            db.close();
        });

        await it('omitted documentRef/note are preserved, explicit null clears them', async () => {
            const db = fresh();
            upsertTaxAssessment(
                db,
                { entityId: 'privat', year: 2024, zve: 40000, documentRef: 'paperless:111', note: 'geprüft' },
                AT,
            );
            const kept = upsertTaxAssessment(db, { entityId: 'privat', year: 2024, zve: 41000 }, AT);
            expect(kept.documentRef).toBe('paperless:111');
            expect(kept.note).toBe('geprüft');
            const cleared = upsertTaxAssessment(
                db,
                { entityId: 'privat', year: 2024, zve: 41000, documentRef: null, note: null },
                AT,
            );
            expect(cleared.documentRef).toBeNull();
            expect(cleared.note).toBeNull();
            db.close();
        });

        await it('lists newest year first, scopes by entity, and removes idempotently', async () => {
            const db = fresh();
            upsertTaxAssessment(db, { entityId: 'privat', year: 2023, zve: 30000 }, AT);
            upsertTaxAssessment(db, { entityId: 'privat', year: 2024, zve: 40000 }, AT);
            upsertTaxAssessment(db, { entityId: 'partner', year: 2024, zve: 20000 }, AT);

            expect(listTaxAssessments(db).map((a) => a.year)).toStrictEqual([2024, 2024, 2023]);
            expect(listTaxAssessments(db, { entityId: 'privat' }).map((a) => a.year)).toStrictEqual([2024, 2023]);

            expect(removeTaxAssessment(db, 'privat', 2023)).toBe(true);
            expect(removeTaxAssessment(db, 'privat', 2023)).toBe(false);
            expect(getTaxAssessment(db, 'privat', 2023)).toBeNull();
            db.close();
        });

        await it('rejects a non-finite amount / a fractional year instead of storing nonsense', async () => {
            const db = fresh();
            expect(() => upsertTaxAssessment(db, { entityId: 'privat', year: 2024, zve: Number.NaN }, AT)).toThrow();
            expect(() => upsertTaxAssessment(db, { entityId: 'privat', year: 2024.5, zve: 1 }, AT)).toThrow();
            db.close();
        });
    });

    await describe('scanZvEFromBescheid (pure OCR scan, synthetic Bescheid text)', async () => {
        await it('reads the amount off the label line and the year off the heading', async () => {
            const scan = scanZvEFromBescheid(
                [
                    'Finanzamt Musterstadt',
                    'Einkommensteuerbescheid für 2024',
                    'Besteuerungsgrundlagen',
                    'Gesamtbetrag der Einkünfte 45.000,00',
                    'zu versteuerndes Einkommen 41.234,00',
                    'festzusetzende Einkommensteuer 7.000,00',
                ].join('\n'),
            );
            expect(scan.vorschlag).toBe(41234);
            expect(scan.jahr).toBe(2024);
            expect(scan.treffer.length).toBe(1);
            expect(scan.hinweise).toStrictEqual([]);
        });

        await it('handles a full-euro figure without decimals (the German thousands dot)', async () => {
            // parseNumericString would read "41.234" as 41.234 — the reason this module parses German
            // amounts itself. Guard the exact shape a Bescheid prints.
            const scan = scanZvEFromBescheid('zu versteuerndes Einkommen 41.234 EUR');
            expect(scan.vorschlag).toBe(41234);
        });

        await it('accepts the declined label and a value split onto the next line (two-column OCR)', async () => {
            const scan = scanZvEFromBescheid(['Berechnung des zu versteuernden Einkommens', '41.234,00'].join('\n'));
            expect(scan.vorschlag).toBe(41234);
        });

        await it('proposes nothing when the label carries no unambiguous amount', async () => {
            const scan = scanZvEFromBescheid(
                ['Einkommensteuerbescheid für 2024', 'Ermittlung des zu versteuernden Einkommens'].join('\n'),
            );
            expect(scan.vorschlag).toBeNull();
            expect(scan.treffer.length).toBe(0);
            expect(scan.hinweise.length).toBe(1);
        });

        await it('never guesses when two different amounts claim the same label', async () => {
            const scan = scanZvEFromBescheid(
                ['zu versteuerndes Einkommen bisher 41.234,00', 'zu versteuerndes Einkommen neu 38.500,00'].join('\n'),
            );
            expect(scan.vorschlag).toBeNull();
            expect(scan.treffer.map((t) => t.betrag)).toStrictEqual([41234, 38500]);
            expect(scan.hinweise.length).toBe(1);
        });

        await it('takes the income, not the tax, from the prose form that names both', async () => {
            // The Bescheid also explains the tariff: "…für ein zu versteuerndes Einkommen von X: Y".
            // Y is the assessed TAX. Reading the last amount on the line would propose the tax.
            const scan = scanZvEFromBescheid(
                'Steuer laut Grundtabelle für ein zu versteuerndes Einkommen von 41.234 EUR: 7.000,00 EUR',
            );
            expect(scan.vorschlag).toBe(41234);
            // …and it says the line is not self-evident, so the Fundstelle gets read.
            expect(scan.hinweise.length).toBe(1);
        });

        await it('flags a single line carrying two value columns (alt/neu) instead of picking silently', async () => {
            const scan = scanZvEFromBescheid('zu versteuerndes Einkommen 41.234,00 38.500,00');
            expect(scan.vorschlag).toBe(41234);
            expect(scan.hinweise.length).toBe(1);
            expect(scan.treffer.length).toBe(1);
        });

        await it('does not mistake a bare four-digit number for an amount', async () => {
            const scan = scanZvEFromBescheid('zu versteuerndes Einkommen Kennziffer 2024');
            expect(scan.vorschlag).toBeNull();
        });

        await it('survives empty input', async () => {
            const scan = scanZvEFromBescheid('');
            expect(scan.vorschlag).toBeNull();
            expect(scan.jahr).toBeNull();
        });
    });

    await describe('actions/zve — the value always carries its Herkunft (temp workspace)', async () => {
        let dir = '';
        const prev = new Map<string, string | undefined>();
        const setEnv = (k: string, v: string) => {
            prev.set(k, process.env[k]);
            process.env[k] = v;
        };
        beforeEach(async () => {
            dir = mkdtempSync(join(tmpdir(), 'bh-zve-'));
            setEnv('TRANSACTIONS_DATA_DIR', dir);
            setEnv('LEDGER_DB_PATH', join(dir, 'ledger.db'));
            const manifest = join(dir, 'steuererklaerung.json');
            writeFileSync(
                manifest,
                JSON.stringify({
                    version: 1,
                    entities: [
                        { id: 'jumplink', name: 'Test EU', kind: 'einzelunternehmen', accounts: [] },
                        { id: 'privat', name: 'Test Privat', kind: 'privat', accounts: [] },
                    ],
                }),
            );
            setEnv('STEUER_WORKSPACE', manifest);
        });
        afterEach(async () => {
            for (const [k, v] of prev) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            prev.clear();
            rmSync(dir, { recursive: true, force: true });
        });

        await it('defaults to the privat entity, not the business one', async () => {
            const saved = recordZvE({ jahr: 2024, betrag: 41234, belegId: 'paperless:111' });
            expect(saved.entityId).toBe('privat');
        });

        await it('returns a recorded value as herkunft=bescheid with its Beleg and capture date', async () => {
            recordZvE({ jahr: 2024, betrag: 41234, belegId: 'paperless:111' });
            const wert = getZvE(2024);
            expect(wert?.betrag).toBe(41234);
            expect(wert?.jahr).toBe(2024);
            expect(wert?.herkunft).toBe('bescheid');
            expect(wert?.belegId).toBe('paperless:111');
            expect(typeof wert?.erfasstAm).toBe('string');
            expect(wert?.hinweis).toBe(undefined);
        });

        await it('flags a Bescheid value recorded without a document as unverifiable', async () => {
            recordZvE({ jahr: 2024, betrag: 41234 });
            const wert = getZvE(2024);
            expect(wert?.herkunft).toBe('bescheid');
            expect(wert?.belegId).toBe(undefined);
            expect(typeof wert?.hinweis).toBe('string');
        });

        await it('returns null for an unrecorded year — an estimate is NEVER handed out unasked', async () => {
            expect(getZvE(2024)).toBeNull();
            // Even when asked for, an entity without an ESt config yields nothing rather than throwing.
            expect(getZvE(2024, { fallback: 'schaetzung' })).toBeNull();
        });

        await it('lists recorded years newest first and drops a year on remove', async () => {
            recordZvE({ jahr: 2023, betrag: 30000, belegId: 'paperless:110' });
            recordZvE({ jahr: 2024, betrag: 41234, belegId: 'paperless:111' });
            expect(listZvE().map((w) => w.jahr)).toStrictEqual([2024, 2023]);
            expect(listZvE().every((w) => w.herkunft === 'bescheid')).toBe(true);
            expect(removeZvE(2023)).toBe(true);
            expect(listZvE().map((w) => w.jahr)).toStrictEqual([2024]);
        });

        await it('fails loud on an unknown entity id instead of silently using the default', async () => {
            expect(() => getZvE(2024, { entityId: 'gibtesnicht' })).toThrow();
        });
    });
};
