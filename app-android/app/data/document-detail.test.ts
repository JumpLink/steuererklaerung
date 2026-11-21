import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentDetail } from './document-detail.ts';

const doc = { id: 3, title: ' Rechnung ', tags: [2, 9], created: '2026-01-05T00:00:00Z', added: null, original_file_name: 'a.pdf', correspondent: 5 };

test('documentDetail resolves tag and correspondent names', () => {
    const d = documentDetail(doc, new Map([[2, 'Rechnung']]), new Map([[5, 'Acme']]));
    assert.deepEqual(d, { title: 'Rechnung', correspondent: 'Acme', created: '2026-01-05', tags: ['Rechnung', '#9'] });
});

test('documentDetail falls back for missing fields', () => {
    const d = documentDetail({ ...doc, title: null, correspondent: null, created: null }, new Map(), new Map());
    assert.deepEqual(d, { title: 'a.pdf', correspondent: '', created: '', tags: ['#2', '#9'] });
});
