import { describe, it, expect } from '@gjsify/unit';
import {
    type ContractRecord,
    getContractDocuments,
    getContractTransactions,
    listContracts,
    migrate,
    openLedger,
    saveContract,
    archiveContract,
    setContractDocument,
    setContractTransaction,
} from '@steuererklaerung/store';
import {
    buildContractIcsEvents,
    type ContractBooking,
    contractCandidates,
    contractFindings,
    expectedDates,
    minusMonths,
    monthlyAmount,
    noticeDeadline,
    upcomingDeadlines,
} from '../../../src/core/contracts/contracts.ts';
import {
    decideContractTransaction,
    loadContracts,
    matchContract,
    saveContractRecord,
} from '../../../src/core/actions/contracts.ts';

// Invented supplier, identifiers and amounts only.
const AT = '2026-01-01T10:00:00Z';
const SUPPLIER = 'Beispiel Strom GmbH';
const CREDITOR = 'DE98ZZZ09999999999';
const MANDATE = 'MUSTER-4711';

const contract = (over: Partial<ContractRecord> = {}): ContractRecord => ({
    id: 'ct_test',
    entityId: 'privat',
    name: 'Strom',
    counterparty: SUPPLIER,
    counterpartyRef: null,
    contractNumber: null,
    accountKey: 'acc1',
    category: 'Energie',
    amount: 80,
    cycle: 'monatlich',
    amountTolerance: 2,
    startDate: '2025-01-15',
    initialTermMonths: 12,
    renewalMonths: 12,
    noticeValue: 1,
    noticeUnit: 'months',
    autoRenewal: true,
    endDate: null,
    paymentMethod: 'lastschrift',
    creditorId: CREDITOR,
    mandateReference: MANDATE,
    counterpartyIban: null,
    matchText: null,
    status: 'active',
    notes: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
});

let n = 0;
const tx = (bookingDate: string, amount: number, over: Partial<ContractBooking> = {}): ContractBooking => ({
    id: `t${n++}`,
    bookingDate,
    amount,
    accountKey: 'acc1',
    counterparty: SUPPLIER,
    purpose: `Abschlag ${CREDITOR} MREF ${MANDATE}`,
    ...over,
});

export default async () => {
    await describe('contracts — notice deadlines', async () => {
        await it('counts the notice back from the term end', async () => {
            const d = noticeDeadline(contract(), '2025-06-01');
            expect(d.kind).toBe('fixed');
            if (d.kind !== 'fixed') return;
            expect(d.termEnd).toBe('2026-01-14');
            expect(d.latestNotice).toBe('2025-12-14');
        });

        await it('rolls to the next term once the deadline passed', async () => {
            const d = noticeDeadline(contract(), '2025-12-20');
            expect(d.kind === 'fixed' && d.termEnd).toBe('2027-01-14');
        });

        await it('is cancellable any time without a renewal period', async () => {
            const d = noticeDeadline(contract({ renewalMonths: null }), '2026-03-10');
            expect(d.kind).toBe('anytime');
            expect(d.kind === 'anytime' && d.termEnd).toBe('2026-04-10');
        });

        await it('says why when there is no deadline', async () => {
            expect(noticeDeadline(contract({ noticeValue: null }), '2025-06-01').kind).toBe('none');
            expect(noticeDeadline(contract({ status: 'cancelled', endDate: '2026-01-14' }), '2025-06-01').kind).toBe(
                'none',
            );
        });

        await it('counts months back from a month end to a month end', async () => {
            expect(minusMonths('2026-04-30', 3)).toBe('2026-01-31');
            expect(minusMonths('2026-03-15', 1)).toBe('2026-02-15');
        });

        await it('lists upcoming deadlines soonest first and exports them as calendar events', async () => {
            const a = contract({ id: 'ct_a', name: 'A', startDate: '2025-03-01' });
            const b = contract({ id: 'ct_b', name: 'B', startDate: '2025-02-01' });
            const items = upcomingDeadlines([a, b, contract({ id: 'ct_c', noticeValue: null })], '2025-12-01', 90);
            expect(items.map((i) => i.contract.id).join(',')).toBe('ct_b,ct_a');
            const events = buildContractIcsEvents(items);
            expect(events[0].date).toBe(items[0].deadline.latestNotice);
            expect(events[0].alarmDaysBefore).toBe(14);
        });
    });

    await describe('contracts — matching and findings', async () => {
        await it('matches by creditor id and skips unrelated or rejected bookings', async () => {
            const own = tx('2025-01-15', -80);
            const other = tx('2025-01-16', -80, { counterparty: 'Andere AG', purpose: 'Miete' });
            const rejected = tx('2025-02-15', -80);
            const c = contract();
            const cands = contractCandidates(
                c,
                [own, other, rejected],
                [{ contractId: c.id, txId: rejected.id, status: 'rejected', decidedAt: AT, decidedBy: null }],
            );
            expect(cands.length).toBe(1);
            expect(cands[0].txId).toBe(own.id);
            expect(cands[0].via).toBe('creditor_id');
        });

        await it('reports a returned direct debit, a missing payment and a changed amount', async () => {
            const c = contract({ startDate: '2025-01-15' });
            const jan = tx('2025-01-15', -80);
            const feb = tx('2025-02-15', -80);
            const febBack = tx('2025-02-19', 80, { purpose: `Ruecklastschrift ${MANDATE}` });
            // March missing; April with a price change.
            const apr = tx('2025-04-15', -95);
            const findings = contractFindings(c, [jan, feb, febBack, apr], [], '2025-04-30');
            const kinds = findings.map((f) => f.kind).join(',');
            expect(kinds).toBe('returned,missing,changed');
            const returned = findings.find((f) => f.kind === 'returned');
            expect(returned?.kind === 'returned' && returned.originalTxId).toBe(feb.id);
            const missing = findings.find((f) => f.kind === 'missing');
            expect(missing?.kind === 'missing' && missing.expectedDate).toBe('2025-03-15');
        });

        await it('does not report a date within the tolerance of asOf as missing', async () => {
            const c = contract({ startDate: '2025-01-15' });
            expect(contractFindings(c, [tx('2025-01-15', -80)], [], '2025-02-17').length).toBe(0);
        });

        await it('steps expected dates by the cycle and sums to a monthly amount', async () => {
            const c = contract({ cycle: 'vierteljaehrlich', amount: 90, startDate: '2025-01-31' });
            expect(expectedDates(c, '2025-08-01').join(',')).toBe('2025-01-31,2025-04-30,2025-07-31');
            expect(monthlyAmount(c)).toBe(30);
        });
    });

    await describe('contracts — store', async () => {
        await it('creates, updates, links and archives with audit rows', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const c = saveContract(db, { entityId: 'privat', name: 'Strom', amount: 80, cycle: 'monatlich' }, AT);
            expect(c.id.startsWith('ct_')).toBe(true);
            expect(c.autoRenewal).toBe(true);
            const u = saveContract(db, { id: c.id, amount: 85, counterparty: SUPPLIER }, AT);
            expect(u.amount).toBe(85);
            expect(u.cycle).toBe('monatlich');
            expect(saveContract(db, { id: c.id, counterparty: null }, AT).counterparty).toBe(null);

            const other = saveContract(db, { entityId: 'privat', name: 'Gas' }, AT);
            setContractTransaction(db, c.id, 'tx1', 'linked', AT, 'test');
            setContractTransaction(db, other.id, 'tx1', 'linked', AT, 'test');
            expect(getContractTransactions(db, c.id).length).toBe(0);
            expect(getContractTransactions(db, other.id)[0].status).toBe('linked');

            setContractDocument(db, c.id, 'paperless:1', 'contract', AT);
            setContractDocument(db, c.id, 'paperless:1', 'invoice', AT);
            expect(getContractDocuments(db, c.id)[0].role).toBe('invoice');
            setContractDocument(db, c.id, 'paperless:1', null, AT);
            expect(getContractDocuments(db, c.id).length).toBe(0);

            expect(archiveContract(db, c.id, AT)).toBe(true);
            expect(listContracts(db).length).toBe(1);
            expect(listContracts(db, { includeArchived: true }).length).toBe(2);
            const audit = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'contract.%'`).get() as {
                n: number;
            };
            expect(audit.n > 5).toBe(true);
            db.close();
        });

        await it('refuses a new contract without entity or name', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            expect(() => saveContract(db, { name: 'x' }, AT)).toThrow();
            db.close();
        });
    });

    await describe('contracts — actions', async () => {
        await it('saves through the sandbox ledger and matches against given bookings', async () => {
            const c = saveContractRecord({
                entityId: 'privat-test',
                name: 'Strom Test',
                counterparty: SUPPLIER,
                accountKey: 'acc1',
                amount: 80,
                cycle: 'monatlich',
                startDate: '2025-01-15',
                creditorId: CREDITOR,
            });
            const feb = tx('2025-02-15', -80);
            decideContractTransaction(c.id, feb.id, 'linked', 'test');
            const m = matchContract(c.id, [tx('2025-01-15', -80), feb, tx('2025-02-20', 80)]);
            expect(m?.asOf).toBe('2025-02-20');
            expect(m?.candidates.find((x) => x.txId === feb.id)?.linked).toBe(true);
            expect(m?.findings.some((f) => f.kind === 'returned')).toBe(true);
            expect(loadContracts({ entityId: 'privat-test' })[0].monthlyAmount).toBe(80);
        });

        await it('rejects a malformed date', async () => {
            expect(() => saveContractRecord({ entityId: 'privat-test', name: 'x', startDate: '15.01.2025' })).toThrow();
        });
    });
};
