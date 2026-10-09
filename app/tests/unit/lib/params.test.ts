import { describe, it, expect } from '@gjsify/unit';
import { buildBody, buildQueryString } from '../../../src/core/lib/params.ts';

export default async () => {
    await describe('buildBody', async () => {
        await it('filters out null and undefined values', async () => {
            const result = buildBody({ name: 'Acme', description: null, count: undefined, active: true });
            expect(result).toStrictEqual({ name: 'Acme', active: true });
        });

        await it('keeps falsy but defined values (0, false, empty string)', async () => {
            const result = buildBody({ count: 0, active: false, label: '' });
            expect(result).toStrictEqual({ count: 0, active: false, label: '' });
        });

        await it('returns empty object for all-null params', async () => {
            const result = buildBody({ a: null, b: undefined });
            expect(result).toStrictEqual({});
        });

        await it('applies field mapping', async () => {
            const result = buildBody(
                { dateFrom: '2024-01-01', dateTo: '2024-12-31', name: 'test' },
                { dateFrom: 'date_from', dateTo: 'date_to' },
            );
            expect(result).toStrictEqual({ date_from: '2024-01-01', date_to: '2024-12-31', name: 'test' });
        });

        await it('handles empty params', async () => {
            expect(buildBody({})).toStrictEqual({});
        });
    });

    await describe('buildQueryString', async () => {
        await it('builds query string from params', async () => {
            const result = buildQueryString({ page: 1, limit: 100 });
            expect(result).toBe('page=1&limit=100');
        });

        await it('filters out null and undefined', async () => {
            const result = buildQueryString({ page: 1, filter: null, sort: undefined });
            expect(result).toBe('page=1');
        });

        await it('handles arrays by repeating keys', async () => {
            const result = buildQueryString({ tags: [1, 2, 3] });
            expect(result).toBe('tags=1&tags=2&tags=3');
        });

        await it('encodes special characters', async () => {
            const result = buildQueryString({ query: 'hello world' });
            expect(result).toBe('query=hello%20world');
        });

        await it('handles boolean values', async () => {
            const result = buildQueryString({ active: true, deleted: false });
            expect(result).toBe('active=true&deleted=false');
        });

        await it('returns empty string for empty params', async () => {
            expect(buildQueryString({})).toBe('');
        });
    });
};
