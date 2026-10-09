import { describe, it, expect } from '@gjsify/unit';
import { qontoCategoryLabel, qontoOperationTypeLabel, humanizeKey } from '../../../src/core/lib/qonto-categories.ts';

export default async function () {
    describe('qontoCategoryLabel', () => {
        it('maps known Qonto categories to German labels', () => {
            expect(qontoCategoryLabel('other_expense')).toBe('Sonstige Ausgaben');
            expect(qontoCategoryLabel('online_service')).toBe('Online-Dienste');
            expect(qontoCategoryLabel('fees')).toBe('Gebühren');
            expect(qontoCategoryLabel('subscription')).toBe('Abonnements');
        });
        it('humanizes an unmapped snake_case key', () => {
            expect(qontoCategoryLabel('some_new_category')).toBe('Some New Category');
        });
        it('passes an already-human label through unchanged', () => {
            expect(qontoCategoryLabel('Sonstige')).toBe('Sonstige');
        });
    });

    describe('qontoOperationTypeLabel', () => {
        it('maps known Qonto operation types to German', () => {
            expect(qontoOperationTypeLabel('swift_income')).toBe('Auslandseingang (SWIFT)');
            expect(qontoOperationTypeLabel('qonto_fee')).toBe('Qonto-Gebühr');
            expect(qontoOperationTypeLabel('direct_debit')).toBe('Lastschrift');
        });
        it('humanizes an unmapped type', () => {
            expect(qontoOperationTypeLabel('some_type')).toBe('Some Type');
        });
    });

    describe('humanizeKey', () => {
        it('turns snake_case into Title Case', () => {
            expect(humanizeKey('other_service')).toBe('Other Service');
        });
    });
}
