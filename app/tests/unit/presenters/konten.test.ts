import { describe, expect, it } from '@gjsify/unit';
import { accountSyncScope, toEntityAccounts, type ConnectionInfo } from '../../../src/core/presenters/konten.ts';

// A ConnectionInfo fixture — accountSyncScope only reads `source` + `accountKey`, but the full shape
// keeps the test honest about the type the desktop Konten view passes in.
function conn(over: Partial<ConnectionInfo>): ConnectionInfo {
    return {
        accountKey: 'qonto:01234567',
        source: 'qonto',
        count: 0,
        totalIn: 0,
        totalOut: 0,
        net: 0,
        ref: '',
        live: true,
        ...over,
    };
}

export default async () => {
    await describe('presenters/konten — accountSyncScope', async () => {
        await it('a FinTS connection scopes to its config name (accountKey segment 2)', async () => {
            expect(accountSyncScope(conn({ source: 'fints', accountKey: 'fints:musterbank-privat:DE123' }))).toBe(
                'musterbank-privat',
            );
        });

        await it('every non-FinTS source scopes to the whole-Qonto sync ("qonto")', async () => {
            expect(accountSyncScope(conn({ source: 'qonto', accountKey: 'qonto:01234567' }))).toBe('qonto');
            expect(accountSyncScope(conn({ source: 'camt', accountKey: 'camt:DE99' }))).toBe('qonto');
            expect(accountSyncScope(conn({ source: 'paypal', accountKey: 'paypal:acct-1' }))).toBe('qonto');
        });
    });

    await describe('presenters/konten — toEntityAccounts', async () => {
        // The web server passes resolved workspace entities (which carry extra fields) into listConnections;
        // the shaping must keep exactly {id,name,accountKeys} — the same triple the desktop derive produced.
        const resolved = [
            { id: 'gbr', name: 'GbR', accountKeys: ['camt:DE1', 'qonto:x'], kind: 'business', demo: false },
            { id: 'privat', name: 'Privat', accountKeys: [] as string[] },
        ];

        await it('reduces each entity to the {id,name,accountKeys} triple, dropping extra fields', async () => {
            const out = toEntityAccounts(resolved);
            expect(out.length).toBe(2);
            expect(out[0].id).toBe('gbr');
            expect(out[0].name).toBe('GbR');
            expect(out[0].accountKeys.join(',')).toBe('camt:DE1,qonto:x');
            expect(Object.keys(out[0]).sort().join(',')).toBe('accountKeys,id,name'); // extra fields dropped
            expect(out[1].accountKeys.length).toBe(0);
        });
    });
};
