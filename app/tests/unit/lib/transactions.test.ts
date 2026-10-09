import { afterEach, beforeEach, describe, expect, it } from '@gjsify/unit';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    camtContentId,
    dedupeKey,
    fintsContentId,
    matchesFilter,
    normalizeCamt,
    normalizeFints,
    toIsoDate,
    loadAll,
    upsertAccount,
    type UnifiedTransaction,
} from '@steuererklaerung/store';
import { normalizeQonto } from '../../../src/core/lib/transactions/normalize-qonto.ts';
import { importCamt } from '../../../src/core/actions/transactions.ts';

const MINIMAL_CAMT = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <Stmt>
      <Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy><Ownr><Nm>Muster & Partner GbR</Nm></Ownr></Acct>
      <Ntry>
        <Amt Ccy="EUR">119.00</Amt><CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2024-03-01</Dt></BookgDt><ValDt><Dt>2024-03-01</Dt></ValDt>
        <NtryDtls><TxDtls><RmtInf><Ustrd>Qonto top-up</Ustrd><Ustrd>Verkaufserlöse</Ustrd></RmtInf><RltdPties><Dbtr><Nm>Kunde GmbH</Nm></Dbtr></RltdPties></TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">9.90</Amt><CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2024-03-02</Dt></BookgDt><ValDt><Dt>2024-03-02</Dt></ValDt>
        <NtryDtls><TxDtls><RmtInf><Ustrd>Bankgebühren</Ustrd></RmtInf><RltdPties><Cdtr><Nm>Qonto</Nm></Cdtr></RltdPties></TxDtls></NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

export default async () => {
    await describe('toIsoDate', async () => {
        await it('normalizes strings and Dates to YYYY-MM-DD', async () => {
            expect(toIsoDate('2026-06-13T12:05:36Z')).toBe('2026-06-13');
            expect(toIsoDate(new Date('2026-01-02T00:00:00Z'))).toBe('2026-01-02');
            expect(toIsoDate(undefined)).toBeUndefined();
            expect(toIsoDate('not-a-date')).toBeUndefined();
        });
    });

    await describe('normalizeQonto', async () => {
        await it('signs the amount via side and maps fields', async () => {
            const t = normalizeQonto('qonto:acc1', 'DE00', {
                id: 'abc',
                amount_cents: 35700,
                currency: 'EUR',
                side: 'debit',
                settled_at: '2026-04-28T18:31:28Z',
                emitted_at: '2026-04-28T18:31:25Z',
                label: 'FINANZAMT',
                reference: '1000000000011',
                category: 'other_expense',
                operation_type: 'transfer',
            } as never);
            expect(t).toMatchObject({
                id: 'abc',
                source: 'qonto',
                accountKey: 'qonto:acc1',
                amount: -357,
                bookingDate: '2026-04-28',
                counterparty: 'FINANZAMT',
                reference: '1000000000011',
            });
        });

        await it('keeps credits positive', async () => {
            const t = normalizeQonto('qonto:a', undefined, {
                id: 'x', amount_cents: 10000, currency: 'EUR', side: 'credit', settled_at: '2026-06-01T00:00:00Z',
            } as never);
            expect(t.amount).toBe(100);
        });
    });

    await describe('normalizeFints + fintsContentId', async () => {
        const raw = {
            valueDate: '2026-03-30T11:00:00.000Z',
            entryDate: '2026-03-31T11:00:00.000Z',
            amount: -538.53,
            purpose: 'Elterngeld Rueckforderung',
            remoteName: 'BUNDESKASSE',
            bankReference: 'REF1',
        };

        await it('maps a FinTS booking to the unified shape (signed amount preserved)', async () => {
            const t = normalizeFints('fints:mb:1234567890', 'DE09', raw);
            expect(t).toMatchObject({
                source: 'fints',
                accountKey: 'fints:mb:1234567890',
                amount: -538.53,
                bookingDate: '2026-03-31',
                valueDate: '2026-03-30',
                counterparty: 'BUNDESKASSE',
                purpose: 'Elterngeld Rueckforderung',
            });
            expect(t.id.startsWith('fints_')).toBe(true);
        });

        await it('is deterministic and account-scoped', async () => {
            expect(fintsContentId('a', raw)).toBe(fintsContentId('a', raw));
            expect(fintsContentId('a', raw)).not.toBe(fintsContentId('b', raw));
        });

        await it('drops NOTPROVIDED e2e references in favor of bankReference', async () => {
            const t = normalizeFints('k', undefined, { ...raw, e2eReference: 'NOTPROVIDED' });
            expect(t.reference).toBe('REF1');
        });
    });

    await describe('normalizeCamt + camtContentId', async () => {
        const raw = {
            valueDate: '2024-03-01T12:00:00.000Z',
            entryDate: '2024-03-01T12:00:00.000Z',
            amount: 119,
            purpose: 'Verkaufserlöse',
            remoteName: 'Kunde GmbH',
        };

        await it('tags the source camt and prefixes the id', async () => {
            const t = normalizeCamt('camt:DE15', 'DE15', raw);
            expect(t).toMatchObject({ source: 'camt', accountKey: 'camt:DE15', amount: 119, purpose: 'Verkaufserlöse' });
            expect(t.id.startsWith('camt_')).toBe(true);
        });

        await it('shares the content hash with FinTS but differs only by prefix (distinct dedupeKey)', async () => {
            expect(camtContentId('a', raw).slice(5)).toBe(fintsContentId('a', raw).slice(6));
            expect(dedupeKey(normalizeCamt('a', undefined, raw))).not.toBe(dedupeKey(normalizeFints('a', undefined, raw)));
        });
    });

    await describe('importCamt (standalone / closed account)', async () => {
        let dir: string;
        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), 'camtimp-'));
            process.env.TRANSACTIONS_DATA_DIR = dir;
        });
        afterEach(() => {
            delete process.env.TRANSACTIONS_DATA_DIR;
            rmSync(dir, { recursive: true, force: true });
        });

        await it('creates a camt:<iban> account for an unmatched export, preserving UTF-8 umlauts and signs', async () => {
            const file = join(dir, 'hauptkonto.xml');
            writeFileSync(file, MINIMAL_CAMT); // UTF-8

            const { reports } = importCamt(file);
            expect(reports).toHaveLength(1);
            expect(reports[0]).toMatchObject({
                accountKey: 'camt:DE89370400440532013000',
                added: 2,
                total: 2,
                imported: 2,
            });

            const all = loadAll();
            expect(all).toHaveLength(2);
            const credit = all.find((t) => t.amount > 0);
            const debit = all.find((t) => t.amount < 0);
            // UTF-8 umlaut intact + multiple <Ustrd> lines joined (not dropped).
            expect(credit).toMatchObject({ source: 'camt', amount: 119, counterparty: 'Kunde GmbH', purpose: 'Qonto top-up Verkaufserlöse' });
            expect(debit).toMatchObject({ source: 'camt', amount: -9.9 });
        });

        await it('is idempotent — re-importing the same file adds nothing', async () => {
            const file = join(dir, 'hauptkonto.xml');
            writeFileSync(file, MINIMAL_CAMT);
            importCamt(file);
            const { reports } = importCamt(file);
            expect(reports[0]).toMatchObject({ added: 0, updated: 2, total: 2 });
            expect(loadAll()).toHaveLength(2);
        });

        await it('preserves content-identical-but-distinct bookings (no unique reference)', async () => {
            // Two identical credits same day, same payer, no reference — must both survive.
            const twin = `
      <Ntry>
        <Amt Ccy="EUR">238.00</Amt><CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2025-09-19</Dt></BookgDt><ValDt><Dt>2025-09-19</Dt></ValDt>
        <NtryDtls><TxDtls><RltdPties><Dbtr><Nm>Kirsten Musterfrau</Nm></Dbtr></RltdPties></TxDtls></NtryDtls>
      </Ntry>`;
            const xml = MINIMAL_CAMT.replace('    </Stmt>', `${twin}${twin}\n    </Stmt>`);
            const file = join(dir, 'hauptkonto.xml');
            writeFileSync(file, xml);

            const { reports } = importCamt(file);
            expect(reports[0]).toMatchObject({ parsed: 4, added: 4, total: 4 });
            expect(loadAll().filter((t) => t.counterparty === 'Kirsten Musterfrau')).toHaveLength(2);
            // Re-import stays idempotent (same file → same positions).
            importCamt(file);
            expect(loadAll()).toHaveLength(4);
        });
    });

    await describe('matchesFilter', async () => {
        const tx: UnifiedTransaction = {
            id: '1', source: 'fints', accountKey: 'fints:vb:1', bookingDate: '2026-04-10',
            amount: -123.45, currency: 'EUR', counterparty: 'FINANZAMT', purpose: '1000000000011',
        };
        await it('matches by query, date range, amount, side', async () => {
            expect(matchesFilter(tx, { query: 'finanzamt' })).toBe(true);
            expect(matchesFilter(tx, { query: 'edeka' })).toBe(false);
            expect(matchesFilter(tx, { from: '2026-04-01', to: '2026-04-30' })).toBe(true);
            expect(matchesFilter(tx, { from: '2026-05-01' })).toBe(false);
            expect(matchesFilter(tx, { side: 'expense' })).toBe(true);
            expect(matchesFilter(tx, { side: 'income' })).toBe(false);
            expect(matchesFilter(tx, { minAmount: 100, maxAmount: 200 })).toBe(true);
            expect(matchesFilter(tx, { minAmount: 200 })).toBe(false);
            expect(matchesFilter(tx, { source: 'qonto' })).toBe(false);
        });
    });

    await describe('store upsert (NDJSON, dedup)', async () => {
        let dir: string;
        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), 'txstore-'));
            process.env.TRANSACTIONS_DATA_DIR = dir;
        });
        afterEach(() => {
            delete process.env.TRANSACTIONS_DATA_DIR;
            rmSync(dir, { recursive: true, force: true });
        });

        await it('adds new and dedupes repeated transactions across syncs', async () => {
            const a: UnifiedTransaction = { id: '1', source: 'qonto', accountKey: 'qonto:x', bookingDate: '2026-01-01', amount: -10, currency: 'EUR' };
            const b: UnifiedTransaction = { id: '2', source: 'qonto', accountKey: 'qonto:x', bookingDate: '2026-01-02', amount: 20, currency: 'EUR' };
            expect(upsertAccount('qonto:x', [a, b])).toStrictEqual({ added: 2, updated: 0, total: 2 });
            // second sync re-sends b (overlap) plus a new c → b updates, c adds
            const c: UnifiedTransaction = { id: '3', source: 'qonto', accountKey: 'qonto:x', bookingDate: '2026-01-03', amount: -5, currency: 'EUR' };
            expect(upsertAccount('qonto:x', [b, c])).toStrictEqual({ added: 1, updated: 1, total: 3 });
            expect(loadAll().map((t) => t.id).sort()).toStrictEqual(['1', '2', '3']);
        });
    });
};
