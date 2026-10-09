import { describe, expect, it } from '@gjsify/unit';
import type { Contact } from '@steuererklaerung/store';
import {
    formatDuration,
    matchProjectToContact,
    parseLegacyTimeCsv,
    splitCsvLine,
    toHours,
} from '../../../src/core/actions/time.ts';

function customer(name: string, over: Partial<Contact> = {}): Contact {
    return {
        id: `c_${name.toLowerCase().replace(/\W+/g, '-')}`,
        entityId: 'jumplink',
        kind: 'company',
        name,
        firstName: null,
        lastName: null,
        email: null,
        vatNumber: null,
        taxId: null,
        iban: null,
        currency: 'EUR',
        locale: 'de',
        address: null,
        zip: null,
        city: null,
        countryCode: null,
        isCustomer: true,
        isSupplier: false,
        notes: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        links: [],
        ...over,
    };
}

const HEADER = 'Project,Start Time,End Time,Description,ID,Billed,%l%H:%M:%S,%l%s';

export default async () => {
    await describe('legacy time CSV import', async () => {
        await it('splits quoted fields containing commas', async () => {
            expect(splitCsvLine('a,"b,c",d')).toStrictEqual(['a', 'b,c', 'd']);
            expect(splitCsvLine('a,"say ""hi""",b')).toStrictEqual(['a', 'say "hi"', 'b']);
        });

        await it('parses the tracker date format and normalises it to ISO/UTC', async () => {
            const csv = [
                HEADER,
                'Nordwerk,Wed Jul 15 2026 17:57:49 GMT+0200 (Mitteleuropäische Sommerzeit),Wed Jul 15 2026 18:27:51 GMT+0200 (Mitteleuropäische Sommerzeit),Weitere Umleitungen,9876543210987,false,00:30:02,1802',
            ].join('\n');
            const { rows, skipped } = parseLegacyTimeCsv(csv);
            expect(skipped.length).toBe(0);
            expect(rows.length).toBe(1);
            // 17:57:49 +02:00 == 15:57:49 UTC — the instant must survive the offset.
            expect(rows[0].startedAt).toBe('2026-07-15T15:57:49.000Z');
            expect(rows[0].endedAt).toBe('2026-07-15T16:27:51.000Z');
            expect(rows[0].project).toBe('Nordwerk');
            expect(rows[0].externalId).toBe('9876543210987');
            expect(rows[0].billed).toBe(false);
        });

        await it('reports unparsable rows instead of guessing', async () => {
            const csv = [HEADER, 'Nordwerk,not-a-date,also-not,desc,1,false,,'].join('\n');
            const { rows, skipped } = parseLegacyTimeCsv(csv);
            expect(rows.length).toBe(0);
            expect(skipped.length).toBe(1);
        });

        await it('reads the billed flag case-insensitively', async () => {
            const csv = [
                HEADER,
                'Leuchtturm,Tue Jul 14 2026 13:11:33 GMT+0200 (X),Tue Jul 14 2026 14:25:40 GMT+0200 (X),Website,1,TRUE,01:14:07,4447',
            ].join('\n');
            expect(parseLegacyTimeCsv(csv).rows[0].billed).toBe(true);
        });
    });

    await describe('project → customer matching', async () => {
        const contacts = [
            customer('Nordwerk Studios GmbH & Co. KG'),
            customer('Leuchtturm Am Hafen | Jan Mustermann'),
            customer('Segelverein Musterstadt e.V.'),
            customer('Gymnasium Musterstadt', { isCustomer: false }),
        ];

        await it('matches a short label inside a long customer name', async () => {
            expect(matchProjectToContact('Nordwerk', contacts)).toBe(contacts[0].id);
            expect(matchProjectToContact('Leuchtturm', contacts)).toBe(contacts[1].id);
        });

        await it('ignores non-customers', async () => {
            expect(matchProjectToContact('Gymnasium Musterstadt', contacts)).toBe(null);
        });

        await it('does not resolve an abbreviation it cannot see in the name', async () => {
            // "NVC" is not a substring of "Segelverein Musterstadt e.V." — guessing here would
            // silently put worked hours on a customer nobody chose.
            expect(matchProjectToContact('NVC', contacts)).toBe(null);
        });

        await it('stays unassigned when more than one customer matches', async () => {
            const ambiguous = [customer('Nordwerk Nord'), customer('Nordwerk Süd')];
            expect(matchProjectToContact('Nordwerk', ambiguous)).toBe(null);
        });
    });

    await describe('duration formatting', async () => {
        await it('formats seconds as hh:mm:ss and decimal hours', async () => {
            expect(formatDuration(4447)).toBe('01:14:07');
            expect(formatDuration(0)).toBe('00:00:00');
            expect(toHours(4447)).toBe(1.24);
        });
    });
};
