import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePaperlessUrl, paperlessHost } from './paperless-url.ts';

test('accepts http(s) addresses and strips trailing slashes', () => {
    assert.equal(normalizePaperlessUrl(' https://paperless.example.org// '), 'https://paperless.example.org');
    assert.equal(normalizePaperlessUrl('HTTP://host:8000/sub/'), 'http://host:8000/sub');
});

test('refuses everything that is not an http(s) URL with a host', () => {
    for (const bad of ['', 'paperless.example.org', 'ftp://host', 'https://', 'https:// host']) {
        assert.equal(normalizePaperlessUrl(bad), null, bad);
    }
});

test('host extraction', () => {
    assert.equal(paperlessHost('https://paperless.example.org:8443/x'), 'paperless.example.org:8443');
    assert.equal(paperlessHost('nonsense'), 'nonsense');
});
