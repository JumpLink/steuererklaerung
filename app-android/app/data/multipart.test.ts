import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMultipart } from './multipart.ts';
import { uploadFields, contentTypeForFilename } from './paperless.ts';

test('multipart body carries fields, file bytes and closing boundary', () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 13, 10]);
    const mp = buildMultipart([['title', 'T'], ['tags', '3'], ['tags', '4']], 'document', 'a"b.pdf', bytes, 'application/pdf', 'BND');
    assert.equal(mp.contentType, 'multipart/form-data; boundary=BND');
    assert.ok(mp.body instanceof ArrayBuffer);
    const u = new Uint8Array(mp.body);
    const text = new TextDecoder('latin1').decode(u);
    assert.ok(text.startsWith('--BND\r\nContent-Disposition: form-data; name="title"\r\n\r\nT\r\n'));
    assert.equal(text.match(/name="tags"/g)?.length, 2);
    assert.ok(text.includes('name="document"; filename="a%22b.pdf"\r\nContent-Type: application/pdf\r\n\r\n'));
    assert.ok(text.endsWith('\r\n--BND--\r\n'));
    const start = text.indexOf('\r\n\r\n', text.indexOf('name="document"')) + 4;
    assert.deepEqual([...u.slice(start, start + bytes.length)], [...bytes]);
});

test('body is an exact-size ArrayBuffer (not a view into a larger one)', () => {
    const mp = buildMultipart([], 'document', 'x.png', new Uint8Array(10), 'image/png', 'B');
    assert.equal(mp.body.byteLength, new Uint8Array(mp.body).length);
});

test('upload fields and content types', () => {
    assert.deepEqual(uploadFields({ title: 'x', tags: [1, 2] }), [['title', 'x'], ['tags', '1'], ['tags', '2']]);
    assert.equal(contentTypeForFilename('S.JPG'), 'image/jpeg');
    assert.equal(contentTypeForFilename('x.bin'), 'application/octet-stream');
});
