import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyNetworkError, describeNetworkError } from './network-error.ts';
import { requestJson } from './http.ts';

test('classifies JVM and Node causes', () => {
    assert.equal(classifyNetworkError(new Error('java.net.UnknownHostException: Unable to resolve host "x"')), 'host-not-found');
    assert.equal(classifyNetworkError(new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }) })), 'host-not-found');
    assert.equal(classifyNetworkError(new Error('java.net.ConnectException: failed to connect to /10.0.0.1 (port 8000)')), 'refused');
    assert.equal(classifyNetworkError(new Error('javax.net.ssl.SSLHandshakeException: Trust anchor for certification path not found')), 'tls');
    assert.equal(classifyNetworkError(new Error('Network request failed')), 'unknown');
    assert.equal(classifyNetworkError('boom'), 'unknown');
});

test('the message names host and cause, and keeps the raw text when the cause is unknown', () => {
    assert.match(describeNetworkError(new Error('UnknownHostException'), 'p.example.org', 'Paperless'), /host p\.example\.org was not found/);
    assert.match(describeNetworkError(new Error('Network request failed'), 'p.example.org', 'Paperless'), /p\.example\.org failed \(Network request failed\)/);
});

test('requestJson reports the cause of a failed fetch and still maps aborts to a timeout', async () => {
    const real = globalThis.fetch;
    try {
        globalThis.fetch = (async () => { throw new Error('java.net.ConnectException: failed to connect'); }) as typeof fetch;
        await assert.rejects(requestJson('http://p.example.org:8000/api/', {}, 1000, 'Paperless'), /p\.example\.org:8000 refused the connection/);
        globalThis.fetch = (async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); }) as typeof fetch;
        await assert.rejects(requestJson('http://p/', {}, 1000, 'Paperless'), /did not answer within 1 s/);
    } finally {
        globalThis.fetch = real;
    }
});
