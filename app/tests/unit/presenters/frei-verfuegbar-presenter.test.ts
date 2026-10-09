import { describe, it, expect } from '@gjsify/unit';
import type { DmsDocument } from '@steuererklaerung/dms';
import { loadFreiVerfuegbar } from '../../../src/core/presenters/frei-verfuegbar.ts';
import type { PresenterSession } from '../../../src/core/presenters/session.ts';
import type { EntityModel } from '../../../src/core/presenters/workspace.ts';
import type { ElsterConfig } from '../../../src/core/config/index.ts';
import type { EuerTxAggregate, EuerTxDetailRow } from '../../../src/core/elster/euer-transactions.ts';

// Invented data. The store and ledger of the test run are empty temp dirs (isolate-env), so the
// accounts and the filing register are empty — exactly the "nicht berechenbar" cases.

function doc(over: Partial<DmsDocument>): DmsDocument {
    return {
        id: 'd1',
        dms: 'builtin',
        title: null,
        correspondent: 'Lieferant',
        documentType: 'Rechnung',
        direction: 'incoming',
        created: '2026-09-01',
        added: '2026-09-01',
        tags: [],
        invoiceNumber: 'R-1',
        net: 100,
        gross: 119,
        vat: 19,
        linkedTxIds: [],
        mimeType: 'application/pdf',
        pageCount: 1,
        ocrText: null,
        ocrSource: null,
        aiNote: null,
        ...over,
    };
}

function row(over: Partial<EuerTxDetailRow>): EuerTxDetailRow {
    return {
        id: 't',
        accountKey: 'qonto:test',
        bookingDate: '2026-08-01',
        amount: 119,
        kind: 'income',
        source: 'rule',
        category: 'Umsatzerlöse',
        kz: '',
        net: 100,
        vat: 19,
        gross: 119,
        ...over,
    };
}

const session = {
    aggregate: async () =>
        ({
            detail: [row({}), row({ id: 'afa', accountKey: 'adjustment', bookingDate: '2026-09-30', vat: 50 })],
        }) as unknown as EuerTxAggregate,
    documents: async (_e: unknown, year: number) => ({
        dmsKind: 'builtin' as const,
        docs:
            year === 2026
                ? [
                      doc({ id: 'open' }),
                      doc({ id: 'paid', linkedTxIds: ['t'] }),
                      doc({ id: 'out', direction: 'outgoing', gross: 500 }),
                  ]
                : [],
    }),
} as unknown as PresenterSession;

const entity = {
    id: 'firma',
    name: 'Muster GmbH',
    kind: 'einzelunternehmen',
    hasElster: true,
    hasEst: false,
    elster: {
        period: { year: 2026, quarter: 1 },
        gesellschafter: [],
        account_labels: {},
        taxation_basis: 'ist',
    } as unknown as ElsterConfig,
    years: [2026],
    defaultYear: 2026,
    accountKeys: [],
    dmsType: 'builtin',
} as EntityModel;

export default async () => {
    await describe('frei-verfuegbar presenter', async () => {
        const m = await loadFreiVerfuegbar(session, entity, { today: '2026-10-08' });
        const term = (key: string) =>
            [...m.freiVerfuegbar.terme, ...m.steuerruecklage.terme].find((t) => t.key === key)!;

        await it('without accounts says the balance is not computable', async () => {
            expect(term('kontostand').status).toBe('nicht-berechenbar');
            expect(m.freiVerfuegbar.betrag).toBeNull();
        });

        await it('counts cash bookings for the USt, never the synthetic year-end rows', async () => {
            expect(term('ust-seit-va').betrag).toBe(19);
        });

        await it('built-in DMS: an incoming invoice without a linked payment is open', async () => {
            const t = term('offene-eingangsrechnungen');
            expect(t.betrag).toBe(119);
            expect(t.zeilen.length).toBe(2); // the open invoice + the rule line
        });

        await it('names what is missing for the Steuerrücklage', async () => {
            expect(term('est').erklaerung).toContain('keine ESt-Angaben');
            expect(term('gewst').erklaerung).toContain('Hebesatz');
            expect(m.steuerruecklage.betrag).toBeNull();
        });
    });
};
