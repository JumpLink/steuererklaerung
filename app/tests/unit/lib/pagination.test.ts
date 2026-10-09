import { describe, it, expect } from '@gjsify/unit';
import {
    fetchAllPages,
    fetchAllPagesParallel,
    fetchPagesUntil,
    type PaginatedResponse,
} from '@steuererklaerung/paperless';

function makePaginatedFetcher<T>(allItems: T[], pageSize: number) {
    return async (page: number, _pageSize: number): Promise<PaginatedResponse<T>> => {
        const start = (page - 1) * pageSize;
        const results = allItems.slice(start, start + pageSize);
        const hasMore = start + pageSize < allItems.length;
        return {
            results,
            next: hasMore ? `page=${page + 1}` : null,
            count: allItems.length,
        };
    };
}

export default async () => {
    await describe('fetchAllPages', async () => {
        await it('fetches all items across multiple pages', async () => {
            const items = [1, 2, 3, 4, 5];
            const fetcher = makePaginatedFetcher(items, 2);
            const result = await fetchAllPages(fetcher, 2);
            expect(result).toStrictEqual([1, 2, 3, 4, 5]);
        });

        await it('handles a single page', async () => {
            const items = [1, 2];
            const fetcher = makePaginatedFetcher(items, 10);
            const result = await fetchAllPages(fetcher, 10);
            expect(result).toStrictEqual([1, 2]);
        });

        await it('handles empty results', async () => {
            const fetcher = makePaginatedFetcher([], 10);
            const result = await fetchAllPages(fetcher, 10);
            expect(result).toStrictEqual([]);
        });

        await it('handles exact page boundary', async () => {
            const items = [1, 2, 3, 4];
            const fetcher = makePaginatedFetcher(items, 2);
            const result = await fetchAllPages(fetcher, 2);
            expect(result).toStrictEqual([1, 2, 3, 4]);
        });
    });

    await describe('fetchPagesUntil', async () => {
        await it('collects items up to limit', async () => {
            const items = [1, 2, 3, 4, 5, 6, 7, 8];
            const fetcher = makePaginatedFetcher(items, 3);
            const result = await fetchPagesUntil(fetcher, undefined, 5, 3);
            expect(result).toStrictEqual([1, 2, 3, 4, 5]);
        });

        await it('applies predicate filter', async () => {
            const items = [1, 2, 3, 4, 5, 6];
            const fetcher = makePaginatedFetcher(items, 3);
            const result = await fetchPagesUntil(fetcher, (n) => n % 2 === 0, Infinity, 3);
            expect(result).toStrictEqual([2, 4, 6]);
        });

        await it('applies both predicate and limit', async () => {
            const items = [1, 2, 3, 4, 5, 6, 7, 8];
            const fetcher = makePaginatedFetcher(items, 3);
            const result = await fetchPagesUntil(fetcher, (n) => n % 2 === 0, 2, 3);
            expect(result).toStrictEqual([2, 4]);
        });

        await it('returns all matching items when limit is Infinity', async () => {
            const items = [10, 20, 30];
            const fetcher = makePaginatedFetcher(items, 10);
            const result = await fetchPagesUntil(fetcher);
            expect(result).toStrictEqual([10, 20, 30]);
        });
    });

    await describe('fetchAllPagesParallel', async () => {
        await it('fetches every page (via count) and preserves order', async () => {
            const items = Array.from({ length: 250 }, (_, i) => i); // 3 pages of 100
            let calls = 0;
            const fetcher = makePaginatedFetcher(items, 100);
            const result = await fetchAllPagesParallel(
                (page, pageSize) => {
                    calls++;
                    return fetcher(page, pageSize);
                },
                { pageSize: 100, concurrency: 4 },
            );
            expect(result.length).toBe(250);
            expect(result[0]).toBe(0);
            expect(result[249]).toBe(249);
            expect(calls).toBe(3); // count → exactly 3 page fetches
        });

        await it('returns a single page when the count fits', async () => {
            const result = await fetchAllPagesParallel(makePaginatedFetcher([1, 2, 3], 100), { pageSize: 100 });
            expect(result).toStrictEqual([1, 2, 3]);
        });

        await it('falls back to serial next-following when count is absent', async () => {
            const pages: PaginatedResponse<number>[] = [
                { results: [1, 2], next: 'a' },
                { results: [3, 4], next: 'b' },
                { results: [5], next: null },
            ];
            let i = 0;
            const result = await fetchAllPagesParallel(async () => pages[i++], { pageSize: 2 });
            expect(result).toStrictEqual([1, 2, 3, 4, 5]);
        });
    });
};
