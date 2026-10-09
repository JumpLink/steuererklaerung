import { describe, it, expect, beforeEach, afterEach } from '@gjsify/unit';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
    getInvoiceCapabilities,
    finalizeOutgoingInvoice,
    markOutgoingInvoicePaid,
    cancelOutgoingInvoice,
} from '../../../src/core/actions/outgoing-invoices.ts';

export default async () => {
    await describe('invoice actions (capability gating)', async () => {
        let tmpDir = '';
        let path = '';
        beforeEach(() => {
            tmpDir = mkdtempSync('/tmp/invoice-actions-test-');
            path = join(tmpDir, 'steuererklaerung.json');
            writeFileSync(
                path,
                JSON.stringify({
                    version: 1,
                    entities: [
                        {
                            id: 'q',
                            name: 'Qonto Co',
                            kind: 'einzelunternehmen',
                            accounts: ['qonto:demo*'],
                            invoicing: { type: 'qonto' },
                        },
                        {
                            id: 's',
                            name: 'Self Co',
                            kind: 'einzelunternehmen',
                            accounts: [],
                            invoicing: { type: 'self', self: { numberPrefix: 'RE-' } },
                        },
                    ],
                }),
            );
        });
        afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

        await it('reports the back-end + capabilities per entity', async () => {
            const q = getInvoiceCapabilities('q', path);
            expect(q.providerType).toBe('qonto');
            expect(q.capabilities.finalize).toBe(false);
            expect(q.capabilities.createDraft).toBe(false); // Qonto form create is not offered

            const s = getInvoiceCapabilities('s', path);
            expect(s.providerType).toBe('self');
            expect(s.capabilities.finalize).toBe(true);
            expect(s.capabilities.cancelStorno).toBe(true);
        });

        await it('throws a uniform "unterstützt … nicht" for an unsupported action on Qonto', async () => {
            const grab = async (fn: () => Promise<unknown>): Promise<string> => {
                try {
                    await fn();
                    return '';
                } catch (e) {
                    return e instanceof Error ? e.message : String(e);
                }
            };
            expect(await grab(() => finalizeOutgoingInvoice('q', 'x', path))).toContain('unterstützt');
            expect(await grab(() => markOutgoingInvoicePaid('q', 'x', { path }))).toContain('unterstützt');
            expect(await grab(() => cancelOutgoingInvoice('q', 'x', { path }))).toContain('unterstützt');
        });
    });
};
