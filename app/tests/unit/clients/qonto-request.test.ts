import { describe, it, expect, vi, beforeEach, afterEach } from '@gjsify/unit';
import { listAll } from '../../../src/core/clients/qonto/request.ts';

// Extends the fetch-mock harness to a second hand-rolled client (Qonto), covering
// the error-prone listAll pagination loop (meta.total_pages + maxPages cap).
export default async () => {
    await describe('qonto listAll() pagination', async () => {
        beforeEach(() => {
            process.env.QONTO_ENV = 'production';
            process.env.QONTO_SIGN_IN = 'org-id';
            process.env.QONTO_SECRET_KEY = 'secret';
        });
        afterEach(() => {
            vi.unstubAllGlobals();
            delete process.env.QONTO_ENV;
            delete process.env.QONTO_SIGN_IN;
            delete process.env.QONTO_SECRET_KEY;
        });

        await it('accumulates items across pages until total_pages', async () => {
            const pages = [
                { transactions: [{ id: 'a' }, { id: 'b' }], meta: { current_page: 1, total_pages: 2 } },
                { transactions: [{ id: 'c' }], meta: { current_page: 2, total_pages: 2 } },
            ];
            let i = 0;
            const fetchFn = vi.fn(async () => ({
                ok: true,
                status: 200,
                text: async () => JSON.stringify(pages[i++]),
            }));
            vi.stubGlobal('fetch', fetchFn);

            const all = await listAll<{ id: string }>('transactions');
            expect(all.map((t) => t.id)).toStrictEqual(['a', 'b', 'c']);
            expect(fetchFn).toHaveBeenCalledTimes(2);
        });

        await it('stops at the maxPages cap', async () => {
            const page = { transactions: [{ id: 'x' }], meta: { current_page: 1, total_pages: 99 } };
            const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(page) }));
            vi.stubGlobal('fetch', fetchFn);

            const all = await listAll<{ id: string }>('transactions', {}, { maxPages: 3 });
            expect(fetchFn).toHaveBeenCalledTimes(3);
            expect(all).toHaveLength(3);
        });
    });
};
