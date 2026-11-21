import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedOnce, nameMap, namesFor } from './lookup.ts';
import { createPaperlessClient } from './paperless.ts';

test('namesFor keeps order and marks unknown ids', () => {
    const names = nameMap([{ id: 1, name: 'Neu' }, { id: 2, name: 'Rechnung' }]);
    assert.deepEqual(namesFor([2, 1, 9], names), ['Rechnung', 'Neu', '#9']);
    assert.deepEqual(namesFor([], names), []);
});

test('cachedOnce loads once and retries after a failure', async () => {
    let calls = 0;
    const get = cachedOnce(async () => {
        calls++;
        if (calls === 1) throw new Error('down');
        return calls;
    });
    await assert.rejects(get(), /down/);
    assert.equal(await get(), 2);
    assert.equal(await get(), 2);
    assert.equal(calls, 2);
});

test('the client fetches tags and correspondents once each', async () => {
    const real = globalThis.fetch;
    const urls: string[] = [];
    try {
        globalThis.fetch = (async (url: string) => {
            urls.push(String(url));
            const results = String(url).includes('/api/tags/') ? [{ id: 2, name: 'Rechnung' }] : [{ id: 5, name: 'Acme' }];
            return new Response(JSON.stringify({ count: 1, next: null, results }), { status: 200 });
        }) as unknown as typeof fetch;
        const client = createPaperlessClient({ url: 'https://p.example.org/', token: 't' });
        assert.equal((await client.tagNames()).get(2), 'Rechnung');
        await client.tagNames();
        assert.equal((await client.correspondentNames()).get(5), 'Acme');
        await client.correspondentNames();
        assert.equal(urls.length, 2);
    } finally {
        globalThis.fetch = real;
    }
});
