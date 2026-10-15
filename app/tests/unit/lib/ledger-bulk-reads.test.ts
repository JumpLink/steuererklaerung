import { describe, it, expect } from '@gjsify/unit';
import {
    openLedger,
    migrate,
    setClassification,
    getManualOverrides,
    linkRefund,
    getRefundLinks,
    saveBookingSplit,
    getBookingSplits,
} from '@steuererklaerung/store';

const AT = '2026-07-09T10:00:00.000Z';
const MANY = 5000;

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

export default async () => {
    // A year's worth of bookings is thousands of ids; binding each one made the EÜR aggregate
    // (and with it every page) slow. The scoped reads must stay correct on the scan path and fast.
    await describe('ledger scoped reads with many ids', async () => {
        await it('getManualOverrides returns only the wanted manual rows', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            setClassification(db, 't1', { category: '4930 Bürobedarf', source: 'manual', status: 'confirmed' }, AT);
            setClassification(db, 'other', { category: '4930 Bürobedarf', source: 'manual', status: 'confirmed' }, AT);
            const t0 = Date.now();
            const got = getManualOverrides(db, ids(MANY));
            expect([...got.keys()].join(',')).toBe('t1');
            expect(Date.now() - t0 < 500).toBe(true);
            db.close();
        });

        await it('getRefundLinks matches refund and original side', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            linkRefund(db, { refundTxId: 't2', originalTxId: 'x9', category: 'c', vatRate: 0.19 }, AT);
            linkRefund(db, { refundTxId: 'y1', originalTxId: 't3', category: 'c', vatRate: 0.19 }, AT);
            linkRefund(db, { refundTxId: 'y2', originalTxId: 'y3', category: 'c', vatRate: 0.19 }, AT);
            const got = getRefundLinks(db, ids(MANY));
            expect(got.map((l) => l.refundTxId).sort().join(',')).toBe('t2,y1');
            db.close();
        });

        await it('getBookingSplits keeps tx/part order and drops foreign ids', async () => {
            const db = openLedger(':memory:');
            migrate(db);
            const parts = [
                { category: 'a', amountCents: 100, vatRate: 0.19 },
                { category: 'b', amountCents: null, vatRate: 0.07 },
            ];
            saveBookingSplit(db, 't5', parts, AT);
            saveBookingSplit(db, 't4', parts, AT);
            saveBookingSplit(db, 'zz', parts, AT);
            const got = getBookingSplits(db, ids(MANY));
            expect(got.map((p) => `${p.txId}#${p.partNo}`).join(',')).toBe('t4#1,t4#2,t5#1,t5#2');
            db.close();
        });
    });
};
