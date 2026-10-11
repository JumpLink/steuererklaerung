import { describe, expect, it } from '@gjsify/unit';
import type { ContractSummary } from '../../../src/core/actions/contracts.ts';
import type { ContractFinding, NoticeDeadline } from '../../../src/core/contracts/contracts.ts';
import {
    DEADLINE_SOON_DAYS,
    DEADLINE_URGENT_DAYS,
    deadlineUrgency,
    filterContracts,
    findingDate,
    latestFinding,
    monthlyTotal,
} from '../../../src/core/presenters/contracts.ts';

function contract(over: Partial<ContractSummary>): ContractSummary {
    return {
        id: 'v1',
        entityId: 'gbr',
        name: 'Hosting',
        counterparty: null,
        counterpartyRef: null,
        contractNumber: null,
        accountKey: null,
        category: null,
        amount: null,
        cycle: null,
        amountTolerance: null,
        startDate: null,
        initialTermMonths: null,
        renewalMonths: null,
        noticeValue: null,
        noticeUnit: null,
        autoRenewal: false,
        endDate: null,
        paymentMethod: null,
        creditorId: null,
        mandateReference: null,
        counterpartyIban: null,
        matchText: null,
        status: 'active',
        notes: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        monthlyAmount: null,
        deadline: { kind: 'none', reason: 'keine Kündigungsfrist' },
        ...over,
    };
}

const fixed = (daysLeft: number): NoticeDeadline => ({
    kind: 'fixed',
    termEnd: '2027-01-31',
    latestNotice: '2026-10-31',
    daysLeft,
});

export default async () => {
    await describe('presenters/contracts — monthlyTotal', async () => {
        await it('sums only the active contracts, rounded to cents', async () => {
            const list = [
                contract({ id: 'a', monthlyAmount: 68.19 }),
                contract({ id: 'b', monthlyAmount: 24.1, status: 'cancelled' }),
                contract({ id: 'c', monthlyAmount: 24.1075 }),
                contract({ id: 'd', monthlyAmount: null }),
            ];
            expect(monthlyTotal(list)).toBe(92.3);
        });

        await it('empty list is zero, not NaN', async () => {
            expect(monthlyTotal([])).toBe(0);
        });
    });

    await describe('presenters/contracts — deadlineUrgency', async () => {
        await it('grades a fixed deadline by the days left', async () => {
            expect(deadlineUrgency(fixed(0))).toBe('urgent');
            expect(deadlineUrgency(fixed(DEADLINE_URGENT_DAYS))).toBe('urgent');
            expect(deadlineUrgency(fixed(DEADLINE_URGENT_DAYS + 1))).toBe('soon');
            expect(deadlineUrgency(fixed(DEADLINE_SOON_DAYS))).toBe('soon');
            expect(deadlineUrgency(fixed(DEADLINE_SOON_DAYS + 1))).toBe('later');
        });

        await it('no fixed notice date is never urgent', async () => {
            expect(deadlineUrgency({ kind: 'anytime', termEnd: '2026-12-31' })).toBe('none');
            expect(deadlineUrgency({ kind: 'none', reason: 'beendet' })).toBe('none');
        });
    });

    await describe('presenters/contracts — findings', async () => {
        const missing: ContractFinding = { kind: 'missing', expectedDate: '2026-05-03', expectedAmount: 68.19 };
        const changed: ContractFinding = {
            kind: 'changed',
            txId: 't1',
            date: '2026-06-14',
            amount: -35.7,
            expectedAmount: 29.75,
            direction: 'increase',
        };
        const noData: ContractFinding = { kind: 'no_data', since: '2026-07-15' };

        await it('dates every kind by the field it is about', async () => {
            expect(findingDate(missing)).toBe('2026-05-03');
            expect(findingDate(changed)).toBe('2026-06-14');
            expect(findingDate(noData)).toBe('2026-07-15');
            expect(
                findingDate({ kind: 'returned', txId: 't2', date: '2026-03-01', amount: 68.19, originalTxId: 't1' }),
            ).toBe('2026-03-01');
        });

        await it('latestFinding is the newest contract-specific one', async () => {
            expect(latestFinding([missing, changed])).toBe(changed);
            expect(latestFinding([changed, missing])).toBe(changed);
        });

        await it('a newer no_data never masks a contract-specific finding', async () => {
            expect(latestFinding([missing, changed, noData])).toBe(changed);
            expect(latestFinding([noData, changed, missing])).toBe(changed);
        });

        await it('no_data wins when it is all there is', async () => {
            expect(latestFinding([noData])).toBe(noData);
        });

        await it('no findings → undefined', async () => {
            expect(latestFinding([])).toBe(undefined);
            expect(latestFinding(undefined)).toBe(undefined);
        });
    });

    await describe('presenters/contracts — filterContracts', async () => {
        const list = [
            contract({ id: 'active-later', deadline: fixed(120) }),
            contract({ id: 'active-soon', deadline: fixed(30) }),
            contract({ id: 'cancelled', status: 'cancelled', deadline: fixed(5) }),
            contract({ id: 'archived', status: 'archived', deadline: fixed(5) }),
        ];
        const ids = (filter: Parameters<typeof filterContracts>[1]) =>
            filterContracts(list, filter)
                .map((c) => c.id)
                .join(',');

        await it('all hides the archived ones', async () => {
            expect(ids('all')).toBe('active-later,active-soon,cancelled');
        });

        await it('active keeps only status active', async () => {
            expect(ids('active')).toBe('active-later,active-soon');
        });

        await it('deadline keeps the near ones, archived still excluded', async () => {
            expect(ids('deadline')).toBe('active-soon,cancelled');
        });

        await it('archived shows only those', async () => {
            expect(ids('archived')).toBe('archived');
        });

        await it('never mutates the input', async () => {
            const before = list.map((c) => c.id).join(',');
            filterContracts(list, 'deadline');
            expect(list.map((c) => c.id).join(',')).toBe(before);
        });
    });
};
