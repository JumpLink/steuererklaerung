import { afterEach, beforeEach, describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createInvoiceDraft,
    finalizeInvoice,
    getTimeEntry,
    ledgerDbPath,
    migrate,
    openLedger,
    upsertTimeEntry,
    type InvoiceIssuerSnapshot,
    type TimeEntry,
} from '@steuererklaerung/store';
import { loadProjektRechnungenUndZeiten } from '../../../src/core/actions/projekt-zuordnung.ts';
import {
    clearRechnungProjekt,
    danachGiltRechnung,
    getRechnungProjekt,
    loadRechnungProjekte,
    rechnungProjektAnsicht,
    setRechnungProjekt,
    vorschlagProjekt,
} from '../../../src/core/actions/rechnung-projekt.ts';
import {
    buildProjectTimeDraft,
    buildTimeLines,
    checkTimeBeforeFinalize,
    listOpenTimeForInvoice,
    releaseTimeOfDraft,
    reserveTimeForDraft,
    settleTimeOnFinalize,
} from '../../../src/core/actions/time-invoice.ts';
import { jahrZeitraum, projektergebnis, rechnungsAnteil } from '../../../src/core/elster/projekt-ergebnis.ts';

// Customers, projects, hours and amounts below are invented.
const ISSUER: InvoiceIssuerSnapshot = {
    name: 'Beispiel GbR',
    address: 'Musterweg 1',
    zip: '12345',
    city: 'Musterstadt',
    countryCode: 'DE',
    taxNumber: '9198081508152',
};
const AT = '2026-05-01T08:00:00.000Z';

function zeit(id: string, projectId: string, desc: string | null, seconds: number, day: string): TimeEntry {
    return {
        id,
        entityId: 'firma',
        contactId: null,
        project: projectId,
        projectId,
        description: desc,
        startedAt: `${day}T12:00:00.000Z`,
        endedAt: `${day}T13:00:00.000Z`,
        durationSeconds: seconds,
        billable: true,
        invoiceId: null,
        source: 'manual',
        externalId: null,
        note: null,
        createdAt: AT,
        updatedAt: AT,
    };
}

export default async () => {
    await describe('buildTimeLines', async () => {
        const entries = [
            zeit('a', 'p', 'Konzept', 3600, '2026-03-02'),
            zeit('b', 'p', 'konzept ', 1800, '2026-03-04'),
            zeit('c', 'p', 'Umsetzung', 1000, '2026-03-10'),
            zeit('d', 'p', null, 600, '2026-03-03'),
        ];
        const opts = { hourlyRate: 80, vatRate: 0.19, fallbackTitle: 'Relaunch' };

        await it('groups by task, case-insensitively, with the project as title for untitled entries', () => {
            const r = buildTimeLines(entries, { ...opts, grouping: 'task' });
            expect(r.lines.map((l) => l.title).join()).toBe('Konzept,Relaunch,Umsetzung');
            expect(r.lines[0].quantity).toBe(1.5);
            expect(r.lines[0].unit).toBe('Stunde');
        });

        await it('puts everything on one line in „gesamt"', () => {
            const r = buildTimeLines(entries, { ...opts, grouping: 'gesamt' });
            expect(r.lines.length).toBe(1);
            expect(r.lines[0].title).toBe('Relaunch');
            expect(r.lines[0].entryIds.length).toBe(4);
        });

        await it('rounds hours to 2 decimals and the net to the cent', () => {
            const r = buildTimeLines(entries, { ...opts, grouping: 'task' });
            const umsetzung = r.lines.find((l) => l.title === 'Umsetzung')!;
            // 1000 s = 0.2777… h → 0.28 h; 0.28 × 80 = 22.40
            expect(umsetzung.quantity).toBe(0.28);
            expect(umsetzung.net).toBe(22.4);
            expect(r.net).toBe(120 + 22.4 + 13.6);
        });

        await it('takes the Leistungszeitraum from the first to the last entry', () => {
            const r = buildTimeLines(entries, { ...opts, grouping: 'task' });
            expect(r.performanceStart).toBe('2026-03-02');
            expect(r.performanceEnd).toBe('2026-03-10');
        });

        await it('refuses to invent a rate', () => {
            for (const rate of [undefined, null, 0, -5, Number.NaN]) {
                let threw = false;
                try {
                    buildTimeLines(entries, {
                        ...opts,
                        hourlyRate: rate as number | null | undefined,
                        grouping: 'task',
                    });
                } catch {
                    threw = true;
                }
                expect(threw).toBe(true);
            }
        });
    });

    await describe('Projektergebnis: direkte Zuordnung', async () => {
        const projekt = { id: 'p1', name: 'Relaunch' };
        const zeitraum = jahrZeitraum(2026);
        const eingaben = (rechnungen: Parameters<typeof projektergebnis>[1]['rechnungen']) => ({
            kosten: [],
            rechnungen,
            zeiten: [],
        });

        await it('counts a flat-fee invoice without hours in full', () => {
            const e = projektergebnis(
                projekt,
                eingaben([
                    { id: 'r1', nummer: 'R-1', datum: '2026-04-01', netto: 900, sekunden: {}, direktProjekt: 'p1' },
                ]),
                zeitraum,
            );
            expect(e.umsatz).toBe(900);
            expect(e.rechnungen[0].herkunft).toBe('direkt');
        });

        await it('a direct assignment wins over the hours: counted once, for one project', () => {
            const r = {
                id: 'r1',
                nummer: 'R-1',
                datum: '2026-04-01',
                netto: 1000,
                sekunden: { p1: 3600, p2: 3600 },
                direktProjekt: 'p2',
            };
            const p1 = projektergebnis({ id: 'p1', name: 'A' }, eingaben([r]), zeitraum);
            const p2 = projektergebnis({ id: 'p2', name: 'B' }, eingaben([r]), zeitraum);
            expect(p1.umsatz).toBe(0);
            expect(p2.umsatz).toBe(1000);
            expect(rechnungsAnteil(r, 'p1') + rechnungsAnteil(r, 'p2')).toBe(1);
        });

        await it('without a direct assignment the hours still split the invoice', () => {
            const r = { id: 'r1', nummer: null, datum: '2026-04-01', netto: 1000, sekunden: { p1: 3600, p2: 1200 } };
            const p1 = projektergebnis({ id: 'p1', name: 'A' }, eingaben([r]), zeitraum);
            expect(p1.umsatz).toBe(750);
            expect(p1.rechnungen[0].herkunft).toBe('zeiten');
        });
    });

    await describe('vorschlagProjekt', async () => {
        const projekte = [
            { id: 'a', contactId: 'c1' },
            { id: 'b', contactId: 'c2' },
            { id: 'c', contactId: 'c2' },
        ];
        await it('proposes the only project of the customer', () => {
            expect(vorschlagProjekt(projekte, 'c1')).toBe('a');
        });
        await it('proposes nothing for several projects, none, or no customer', () => {
            expect(vorschlagProjekt(projekte, 'c2')).toBe(null);
            expect(vorschlagProjekt(projekte, 'c9')).toBe(null);
            expect(vorschlagProjekt(projekte, null)).toBe(null);
        });
    });

    await describe('Rechnung ↔ Projekt (Ledger)', async () => {
        let dir = '';
        let prev: Record<string, string | undefined> = {};
        beforeEach(async () => {
            prev = { STEUER_WORKSPACE: process.env.STEUER_WORKSPACE, LEDGER_DB_PATH: process.env.LEDGER_DB_PATH };
            dir = mkdtempSync(join(tmpdir(), 'bh-rechnung-projekt-'));
            const manifest = join(dir, 'steuererklaerung.json');
            writeFileSync(
                manifest,
                JSON.stringify({
                    version: 1,
                    entities: [
                        {
                            id: 'firma',
                            name: 'Beispiel GbR',
                            kind: 'gbr',
                            accounts: [],
                            projects: [
                                { id: 'hafenlicht', name: 'Hafenlicht Relaunch', contactId: 'c_hafenlicht' },
                                { id: 'leuchtturm', name: 'Leuchtturm Shop', contactId: 'c_leuchtturm' },
                            ],
                        },
                    ],
                }),
            );
            process.env.STEUER_WORKSPACE = manifest;
            process.env.LEDGER_DB_PATH = join(dir, 'ledger.db');
        });
        afterEach(async () => {
            for (const [k, v] of Object.entries(prev)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
            rmSync(dir, { recursive: true, force: true });
        });

        const draft = () => {
            const db = openLedger(ledgerDbPath());
            try {
                migrate(db);
                return createInvoiceDraft(
                    db,
                    {
                        entityId: 'firma',
                        issueDate: '2026-04-01',
                        dueDate: '2026-04-15',
                        items: [{ title: 'Pauschale', quantity: 1, unitPriceNet: 900, vatRate: 0.19 }],
                    },
                    AT,
                );
            } finally {
                db.close();
            }
        };
        const finalize = (id: string) => {
            const db = openLedger(ledgerDbPath());
            try {
                finalizeInvoice(db, id, { issuer: ISSUER, recipient: { name: 'Hafenlicht GmbH' }, at: AT });
            } finally {
                db.close();
            }
        };
        const addTime = (...entries: TimeEntry[]) => {
            const db = openLedger(ledgerDbPath());
            try {
                migrate(db);
                for (const e of entries) upsertTimeEntry(db, e, AT);
            } finally {
                db.close();
            }
        };
        const invoiceIdOf = (entryId: string) => {
            const db = openLedger(ledgerDbPath());
            try {
                return getTimeEntry(db, entryId)?.invoiceId ?? null;
            } finally {
                db.close();
            }
        };

        await it('persists the assignment, logs it and takes it back with the undo sentence', () => {
            const inv = draft();
            expect(getRechnungProjekt('firma', inv.id)).toBe(null);
            expect(setRechnungProjekt('firma', inv.id, 'hafenlicht', 'test')).toBe('assigned');
            expect(setRechnungProjekt('firma', inv.id, 'hafenlicht')).toBe('unchanged');
            expect(loadRechnungProjekte('firma').get(inv.id)).toBe('hafenlicht');
            const a = rechnungProjektAnsicht('firma', inv.id);
            expect(a.direkt?.name).toBe('Hafenlicht Relaunch');
            expect(a.danach).toBe('Danach gilt: kein Projekt.');
            expect(clearRechnungProjekt('firma', inv.id)).toBe(true);
            expect(clearRechnungProjekt('firma', inv.id)).toBe(false);
            expect(getRechnungProjekt('firma', inv.id)).toBe(null);
            const db = openLedger(ledgerDbPath());
            try {
                const rows = db
                    .prepare(`SELECT action FROM audit_log WHERE action LIKE 'rechnung_projekt.%' ORDER BY id`)
                    .all() as unknown as { action: string }[];
                expect(rows.map((r) => r.action).join()).toBe('rechnung_projekt.assign,rechnung_projekt.clear');
            } finally {
                db.close();
            }
            expect(danachGiltRechnung(true)).toBe('Danach gilt: Zuordnung über die abgerechneten Zeiten.');
        });

        await it('refuses an unknown project', () => {
            let threw = false;
            try {
                setRechnungProjekt('firma', draft().id, 'gibt-es-nicht');
            } catch {
                threw = true;
            }
            expect(threw).toBe(true);
        });

        await it('the loader counts a directly assigned invoice without hours, and lists the unassigned ones', () => {
            const frei = draft();
            const mit = draft();
            finalize(frei.id);
            finalize(mit.id);
            expect(loadProjektRechnungenUndZeiten('firma').ohneProjekt.length).toBe(2);
            setRechnungProjekt('firma', frei.id, 'hafenlicht');
            const l = loadProjektRechnungenUndZeiten('firma');
            expect(l.rechnungen.map((r) => r.direktProjekt).join()).toBe('hafenlicht');
            expect(l.ohneProjekt.map((r) => r.id).join()).toBe(mit.id);
            const e = projektergebnis(
                { id: 'hafenlicht', name: 'Hafenlicht Relaunch' },
                { kosten: [], rechnungen: l.rechnungen, zeiten: l.zeiten },
                jahrZeitraum(2026),
            );
            expect(e.umsatz).toBe(900);
        });

        await it('reserving keeps the entries open; finalize bills them, and only then', () => {
            addTime(
                zeit('t1', 'hafenlicht', 'Konzept', 3600, '2026-03-02'),
                zeit('t2', 'hafenlicht', 'Konzept', 1800, '2026-03-03'),
            );
            const inv = draft();
            reserveTimeForDraft('firma', inv.id, ['t1', 't2']);
            expect(invoiceIdOf('t1')).toBe(null);
            expect(listOpenTimeForInvoice('firma', { projectId: 'hafenlicht' }).length).toBe(0);
            expect(listOpenTimeForInvoice('firma', { projectId: 'hafenlicht' }, inv.id).length).toBe(2);
            expect(checkTimeBeforeFinalize('firma', inv.id).join()).toBe('t1,t2');
            expect(invoiceIdOf('t1')).toBe(null);
            finalize(inv.id);
            expect(settleTimeOnFinalize('firma', inv.id)).toBe(2);
            expect(invoiceIdOf('t1')).toBe(inv.id);
            expect(invoiceIdOf('t2')).toBe(inv.id);
            expect(checkTimeBeforeFinalize('firma', inv.id).length).toBe(0);
        });

        await it('deleting the draft releases the reservation and leaves the entries open', () => {
            addTime(zeit('t1', 'hafenlicht', 'Konzept', 3600, '2026-03-02'));
            const inv = draft();
            reserveTimeForDraft('firma', inv.id, ['t1']);
            releaseTimeOfDraft('firma', inv.id);
            expect(invoiceIdOf('t1')).toBe(null);
            expect(listOpenTimeForInvoice('firma', { projectId: 'hafenlicht' }).length).toBe(1);
        });

        await it('one entry cannot sit on two drafts', () => {
            addTime(zeit('t1', 'hafenlicht', 'Konzept', 3600, '2026-03-02'));
            reserveTimeForDraft('firma', draft().id, ['t1']);
            let threw = false;
            try {
                reserveTimeForDraft('firma', draft().id, ['t1']);
            } catch {
                threw = true;
            }
            expect(threw).toBe(true);
        });

        await it('builds the project draft from only the chosen open entries', () => {
            addTime(
                zeit('t1', 'hafenlicht', 'Konzept', 3600, '2026-03-02'),
                zeit('t2', 'hafenlicht', 'Design', 7200, '2026-03-05'),
            );
            const built = buildProjectTimeDraft(
                'firma',
                { id: 'hafenlicht', name: 'Hafenlicht Relaunch' },
                { grouping: 'task', hourlyRate: 90, vatRate: 0.19, entryIds: ['t2'] },
            );
            expect(built.items.length).toBe(1);
            expect(built.items[0].title).toBe('Design');
            expect(built.items[0].quantity).toBe(2);
            expect(built.entryIds.join()).toBe('t2');
        });

        await it('the invoice detail names the project the hours point to', () => {
            addTime(zeit('t1', 'hafenlicht', 'Konzept', 3600, '2026-03-02'));
            const inv = draft();
            reserveTimeForDraft('firma', inv.id, ['t1']);
            finalize(inv.id);
            settleTimeOnFinalize('firma', inv.id);
            const a = rechnungProjektAnsicht('firma', inv.id);
            expect(a.direkt).toBe(null);
            expect(a.ueberZeiten.map((p) => p.id).join()).toBe('hafenlicht');
            setRechnungProjekt('firma', inv.id, 'leuchtturm');
            expect(rechnungProjektAnsicht('firma', inv.id).danach).toBe(
                'Danach gilt: Zuordnung über die abgerechneten Zeiten.',
            );
        });
    });
};
