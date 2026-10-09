import { describe, expect, it } from '@gjsify/unit';
import { buildReminder, type RecurringDueEntry } from '../../../src/core/invoices/recurring.ts';

/**
 * What a reminder SAYS is business logic, so it is tested like business logic.
 *
 * It used to live in a shell script beside the app: the wording was assembled in bash from the
 * CLI's JSON, which meant nothing here could be asserted and only one machine in the world ever
 * reminded anyone. Measured 2026-09-18, while that script did not yet exist: eight recurring
 * invoices totalling 1204,28 EUR stood overdue, the oldest by 260 days. The dashboard had been
 * right the whole time — nobody was told.
 */

function entry(over: Partial<RecurringDueEntry> = {}): RecurringDueEntry {
    return {
        id: 'beispiel-de',
        entityId: 'jumplink',
        customer: 'Beispiel GmbH',
        description: 'Website Hosting beispiel.de',
        domains: ['beispiel.de'],
        projectId: null,
        dueDate: '2026-01-01',
        period: { start: '2026-01-01', end: '2026-12-31' },
        totals: { net: 108, vat: 20.52, gross: 128.52 },
        currency: 'EUR',
        status: 'overdue',
        daysUntilDue: -260,
        lastInvoiceNumber: 'RE-24440',
        ...over,
    };
}

export default async () => {
    await describe('Erinnerung an wiederkehrende Rechnungen', async () => {
        await it('schweigt, wenn nichts zu tun ist — und zwar als null, nicht als leere Liste', () => {
            const reminder = buildReminder([
                entry({ status: 'upcoming', daysUntilDue: 200 }),
                entry({ status: 'paused', daysUntilDue: -5 }),
                entry({ status: 'cancelled', daysUntilDue: -900 }),
            ]);
            // Ein eigener Typ fuer "nichts zu melden" verhindert, dass ein Aufrufer versehentlich
            // ueber eine leere Liste benachrichtigt: das waere eine Erinnerung, die nichts meint.
            expect(reminder).toBe(null);
        });

        await it('nennt Anzahl, Summe und wie lange die aelteste schon laeuft', () => {
            const reminder = buildReminder([
                entry({ daysUntilDue: -260 }),
                entry({ daysUntilDue: -14, totals: { net: 122, vat: 23.18, gross: 145.18 } }),
                entry({ status: 'due-soon', daysUntilDue: 28, totals: { net: 36, vat: 6.84, gross: 42.84 } }),
            ]);
            expect(reminder?.title).toBe('3 Rechnungen offen, 316,54 EUR — älteste seit 260 Tagen');
            expect(reminder?.oldestOverdueDays).toBe(260);
        });

        await it('sagt "1 Rechnung", nicht "1 Rechnungen"', () => {
            const reminder = buildReminder([entry()]);
            expect(reminder?.title.startsWith('1 Rechnung offen,')).toBe(true);
        });

        await it('laesst den Nachsatz weg, wenn nichts ueberfaellig ist — nur bald faellig', () => {
            const reminder = buildReminder([entry({ status: 'due-soon', daysUntilDue: 20 })]);
            expect(reminder?.title.includes('älteste')).toBe(false);
            expect(reminder?.oldestOverdueDays).toBe(0);
        });

        await it('schreibt Betraege deutsch, mit Tausenderpunkt', () => {
            const reminder = buildReminder([entry({ totals: { net: 1049.68, vat: 199.44, gross: 1249.12 } })]);
            expect(reminder?.title.includes('1.249,12 EUR')).toBe(true);
        });

        await it('sortiert das Dringendste nach oben und kennzeichnet es', () => {
            const reminder = buildReminder([
                entry({ status: 'due-soon', daysUntilDue: 28, description: 'bald' }),
                entry({ daysUntilDue: -260, description: 'ganz alt' }),
                entry({ daysUntilDue: -14, description: 'neulich' }),
            ]);
            expect(reminder?.lines[0].includes('ganz alt')).toBe(true);
            expect(reminder?.lines[0].includes('ÜBERFÄLLIG')).toBe(true);
            expect(reminder?.lines[2].includes('bald fällig')).toBe(true);
        });

        await it('faellt auf den Kundennamen zurueck, wenn keine Beschreibung da ist', () => {
            const reminder = buildReminder([entry({ description: null })]);
            expect(reminder?.lines[0].includes('Beispiel GmbH')).toBe(true);
        });

        await it('zaehlt nur, was wirklich ansteht — pausierte und gekuendigte bleiben draussen', () => {
            const reminder = buildReminder([
                entry({ daysUntilDue: -260 }),
                entry({ status: 'paused', daysUntilDue: -300 }),
                entry({ status: 'cancelled', daysUntilDue: -400 }),
                entry({ status: 'upcoming', daysUntilDue: 90 }),
            ]);
            expect(reminder?.entries.length).toBe(1);
            expect(reminder?.totalGross).toBe(128.52);
        });
    });
};
