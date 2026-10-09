import { afterEach, beforeEach, describe, expect, it } from '@gjsify/unit';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createInvoiceDraft,
    finalizeInvoice,
    ledgerDbPath,
    markTimeEntriesInvoiced,
    migrate,
    openLedger,
    upsertTimeEntry,
    type InvoiceIssuerSnapshot,
} from '@steuererklaerung/store';
import {
    entferneProjektRegel,
    entscheideProjekt,
    loadProjektEntscheidungen,
    loadProjektRechnungenUndZeiten,
    loadProjektRegeln,
    merkeProjektRegel,
    nimmProjektEntscheidungZurueck,
} from '../../../src/core/actions/projekt-zuordnung.ts';
import { getDecisionLog } from '../../../src/core/actions/classifications.ts';
import { removeAufteilung, saveAufteilung } from '../../../src/core/actions/aufteilungen.ts';
import { berechneTeile } from '../../../src/core/elster/splitbuchung.ts';
import {
    danachGilt,
    jahrZeitraum,
    projektergebnis,
    projektFuerBuchung,
} from '../../../src/core/elster/projekt-ergebnis.ts';

// All projects, customers, bookings and amounts below are invented.
const ISSUER: InvoiceIssuerSnapshot = {
    name: 'Beispiel GbR',
    address: 'Musterweg 1',
    zip: '12345',
    city: 'Musterstadt',
    countryCode: 'DE',
    taxNumber: '9198081508152',
};
const AT = '2026-05-01T08:00:00.000Z';

export default async () => {
    await describe('Projekt: Zuordnung und Regeln (Ledger, Manifest)', async () => {
        let dir = '';
        let prev: Record<string, string | undefined> = {};
        beforeEach(async () => {
            prev = { STEUER_WORKSPACE: process.env.STEUER_WORKSPACE, LEDGER_DB_PATH: process.env.LEDGER_DB_PATH };
            dir = mkdtempSync(join(tmpdir(), 'bh-projekt-'));
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

        await it('has no decisions without a ledger, and reading creates none', () => {
            expect(loadProjektEntscheidungen().size).toBe(0);
            expect(loadProjektRechnungenUndZeiten('firma').zeiten.length).toBe(0);
            expect(existsSync(process.env.LEDGER_DB_PATH!)).toBe(false);
            expect(loadProjektRegeln('firma').length).toBe(0);
        });

        await it('assigns several bookings at once and persists the decisions', () => {
            const r = entscheideProjekt(['a', 'b', 'c'], 'hafenlicht', { decidedBy: 'test' });
            expect(r.map((x) => x.change).join()).toBe('assigned,assigned,assigned');
            const e = loadProjektEntscheidungen(['a', 'b', 'c', 'zzz']);
            expect([...e.keys()].join()).toBe('a,b,c');
            expect(e.get('b')?.[0].projectId).toBe('hafenlicht');
            expect(e.get('b')?.[0].teilNr).toBe(0);
        });

        await it('writing the same decision again changes nothing and logs nothing', () => {
            entscheideProjekt(['a'], 'hafenlicht');
            const again = entscheideProjekt(['a'], 'hafenlicht');
            expect(again[0].change).toBe('unchanged');
            expect(getDecisionLog('a').length).toBe(1);
        });

        await it('reassigning replaces the decision; the log keeps every step', () => {
            entscheideProjekt(['a'], 'hafenlicht');
            entscheideProjekt(['a'], 'leuchtturm');
            expect(loadProjektEntscheidungen(['a']).get('a')?.[0].projectId).toBe('leuchtturm');
            const log = getDecisionLog('a');
            expect(log.map((l) => l.action).join()).toBe('projekt.assign,projekt.assign');
            expect((log[1].detail as { previous: string }).previous).toBe('hafenlicht');
        });

        await it('„kein Projekt" is a decision of its own and logs as an exclusion', () => {
            entscheideProjekt(['a'], null);
            const d = loadProjektEntscheidungen(['a']).get('a')!;
            expect(d[0].projectId).toBe(null);
            expect(getDecisionLog('a')[0].action).toBe('projekt.exclude');
        });

        await it('takes a decision back, says what applies then, and logs it', () => {
            const regeln = [{ muster: 'küstenlicht', projekt: 'hafenlicht' }];
            const buchung = { id: 'a', amount: -10, counterparty: 'Küstenlicht Bildagentur' };
            const namen = new Map([['hafenlicht', 'Hafenlicht Relaunch']]);
            entscheideProjekt(['a'], null);
            expect(
                projektFuerBuchung(buchung, loadProjektEntscheidungen().get('a') ?? [], regeln, new Set(namen.keys()))
                    .projectId,
            ).toBe(null);
            const vorher = loadProjektEntscheidungen(['a']).get('a')!;
            expect(nimmProjektEntscheidungZurueck(['a', 'nie-entschieden']).join()).toBe('a');
            expect(loadProjektEntscheidungen().size).toBe(0);
            expect(danachGilt(buchung, vorher, regeln, namen)).toBe(
                'Danach gilt: via Regel „küstenlicht“ → Projekt „Hafenlicht Relaunch“.',
            );
            expect(
                getDecisionLog('a')
                    .map((l) => l.action)
                    .join(),
            ).toBe('projekt.exclude,projekt.clear');
        });

        await it('stores a decision per part of a split booking, and drops them with the split', () => {
            const teile = berechneTeile(-238, [
                { category: '4930 Bürobedarf', betrag: 119, vatRate: 0.19 },
                { category: '1800 Privatentnahme', rest: true, vatRate: 0.19 },
            ]);
            saveAufteilung('s', teile);
            entscheideProjekt(['s'], 'hafenlicht');
            entscheideProjekt(['s'], 'leuchtturm', { teilNr: 1 });
            expect(
                loadProjektEntscheidungen(['s'])
                    .get('s')!
                    .map((e) => `${e.teilNr}:${e.projectId}`)
                    .join(),
            ).toBe('0:hafenlicht,1:leuchtturm');
            removeAufteilung('s');
            // The part decision is gone, the decision about the whole booking stays.
            expect(
                loadProjektEntscheidungen(['s'])
                    .get('s')!
                    .map((e) => `${e.teilNr}:${e.projectId}`)
                    .join(),
            ).toBe('0:hafenlicht');
        });

        await it('remembers a rule in the manifest, idempotently, with exceptions merged', () => {
            const first = merkeProjektRegel('firma', ' Küstenlicht ', 'hafenlicht', { ausnahmen: ['x1'] });
            expect(first.added).toBe(true);
            expect(loadProjektRegeln('firma')).toStrictEqual([
                { muster: 'Küstenlicht', projekt: 'hafenlicht', ausnahmen: ['x1'] },
            ]);
            expect(merkeProjektRegel('firma', 'küstenlicht', 'hafenlicht').added).toBe(false);
            expect(merkeProjektRegel('firma', 'küstenlicht', 'hafenlicht', { ausnahmen: ['x2'] }).added).toBe(false);
            expect(loadProjektRegeln('firma').length).toBe(1);
            expect(loadProjektRegeln('firma')[0].ausnahmen).toStrictEqual(['x1', 'x2']);
            // Same pattern, other project: appended, the older one still wins.
            expect(merkeProjektRegel('firma', 'küstenlicht', 'leuchtturm').added).toBe(true);
            expect(
                loadProjektRegeln('firma')
                    .map((r) => r.projekt)
                    .join(),
            ).toBe('hafenlicht,leuchtturm');
            const raw = JSON.parse(readFileSync(process.env.STEUER_WORKSPACE!, 'utf8'));
            expect(raw.entities[0].elster.klassifizierung.projekt_regeln.length).toBe(2);
        });

        await it('refuses a rule for an unknown project or without a pattern', () => {
            let msg = '';
            try {
                merkeProjektRegel('firma', 'x', 'gibt-es-nicht');
            } catch (err) {
                msg = err instanceof Error ? err.message : String(err);
            }
            expect(msg).toContain('gibt-es-nicht');
            msg = '';
            try {
                merkeProjektRegel('firma', '   ', 'hafenlicht');
            } catch (err) {
                msg = err instanceof Error ? err.message : String(err);
            }
            expect(msg).toContain('Muster');
            expect(loadProjektRegeln('firma').length).toBe(0);
        });

        await it('creates the ELSTER section for an entity without one, so its rules can be written', () => {
            writeFileSync(
                process.env.STEUER_WORKSPACE!,
                JSON.stringify({
                    version: 1,
                    entities: [
                        {
                            id: 'solo',
                            name: 'Solo',
                            kind: 'einzelunternehmen',
                            accounts: [],
                            projects: [{ id: 'p', name: 'Projekt', contactId: 'c_p' }],
                        },
                    ],
                }),
            );
            expect(merkeProjektRegel('solo', 'abc', 'p').added).toBe(true);
            expect(loadProjektRegeln('solo')[0].muster).toBe('abc');
        });

        await it('removes a rule, and a decision of the person survives it', () => {
            merkeProjektRegel('firma', 'küstenlicht', 'hafenlicht');
            entscheideProjekt(['a'], 'hafenlicht');
            expect(entferneProjektRegel('firma', 'KÜSTENLICHT')).toBe(true);
            expect(entferneProjektRegel('firma', 'küstenlicht')).toBe(false);
            expect(loadProjektRegeln('firma').length).toBe(0);
            expect(loadProjektEntscheidungen(['a']).size).toBe(1);
        });

        await it('asks for the project when a pattern is used for several', () => {
            merkeProjektRegel('firma', 'küstenlicht', 'hafenlicht');
            merkeProjektRegel('firma', 'küstenlicht', 'leuchtturm');
            let msg = '';
            try {
                entferneProjektRegel('firma', 'küstenlicht');
            } catch (err) {
                msg = err instanceof Error ? err.message : String(err);
            }
            expect(msg).toContain('Projekt angeben');
            expect(entferneProjektRegel('firma', 'küstenlicht', 'leuchtturm')).toBe(true);
            expect(
                loadProjektRegeln('firma')
                    .map((r) => r.projekt)
                    .join(),
            ).toBe('hafenlicht');
        });

        await it('reads Umsatz and hours from the ledger: billed time makes the invoice a project invoice', () => {
            const db = openLedger(ledgerDbPath());
            try {
                migrate(db);
                const e = (id: string, projectId: string, start: string, hours: number, invoiceId?: string) =>
                    upsertTimeEntry(
                        db,
                        {
                            id,
                            entityId: 'firma',
                            project: projectId,
                            projectId,
                            startedAt: start,
                            endedAt: new Date(Date.parse(start) + hours * 3600_000).toISOString(),
                            durationSeconds: hours * 3600,
                            invoiceId: invoiceId ?? null,
                        },
                        AT,
                    );
                const inv = createInvoiceDraft(
                    db,
                    {
                        entityId: 'firma',
                        issueDate: '2026-04-30',
                        items: [{ title: 'Relaunch', quantity: 10, unitPriceNet: 80, vatRate: 0.19 }],
                    },
                    AT,
                );
                finalizeInvoice(db, inv.id, { issuer: ISSUER, recipient: { name: 'Hafenlicht GmbH' }, at: AT });
                e('t1', 'hafenlicht', '2026-04-02T08:00:00.000Z', 6);
                e('t2', 'hafenlicht', '2026-04-03T08:00:00.000Z', 4);
                e('t3', 'hafenlicht', '2026-04-20T08:00:00.000Z', 2);
                markTimeEntriesInvoiced(db, ['t1', 't2'], inv.id, AT);
                // A draft invoice is no Umsatz yet.
                const entwurf = createInvoiceDraft(
                    db,
                    {
                        entityId: 'firma',
                        issueDate: '2026-05-02',
                        items: [{ title: 'Mehr', quantity: 1, unitPriceNet: 500, vatRate: 0.19 }],
                    },
                    AT,
                );
                e('t4', 'hafenlicht', '2026-05-02T08:00:00.000Z', 1);
                markTimeEntriesInvoiced(db, ['t4'], entwurf.id, AT);
            } finally {
                db.close();
            }
            const { rechnungen, zeiten } = loadProjektRechnungenUndZeiten('firma');
            expect(rechnungen.length).toBe(1);
            expect(rechnungen[0].netto).toBe(800);
            expect(rechnungen[0].sekunden.hafenlicht).toBe(36000);
            expect(zeiten.length).toBe(4);
            const e = projektergebnis(
                { id: 'hafenlicht', name: 'Hafenlicht Relaunch' },
                { kosten: [], rechnungen, zeiten },
                jahrZeitraum(2026),
            );
            expect(e.umsatz).toBe(800);
            expect(e.stunden).toBe(13);
            expect(e.ergebnisProStunde).toBe(61.54);
            expect(loadProjektRechnungenUndZeiten('anderer').rechnungen.length).toBe(0);
        });
    });
};
