import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaperlessClient } from './paperless.ts';

test('listInbox asks for the requested page and looks the inbox tag up once', async () => {
    const real = globalThis.fetch;
    const urls: string[] = [];
    try {
        globalThis.fetch = (async (url: string) => {
            urls.push(String(url));
            const body = String(url).includes('/api/tags/')
                ? { count: 1, next: null, results: [{ id: 7, name: 'Neu' }] }
                : { count: 30, next: null, results: [] };
            return new Response(JSON.stringify(body), { status: 200 });
        }) as unknown as typeof fetch;
        const client = createPaperlessClient({ url: 'https://p.example.org/', token: 't' });
        await client.listInbox(1);
        await client.listInbox(2);
        assert.equal(urls.filter((u) => u.includes('/api/tags/')).length, 1);
        assert.match(urls[1], /page=1/);
        assert.match(urls[2], /page=2/);
        assert.match(urls[2], /tags__id__all=7/);
    } finally {
        globalThis.fetch = real;
    }
});
