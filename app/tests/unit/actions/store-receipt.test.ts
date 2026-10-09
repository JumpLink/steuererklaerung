/**
 * Storing a receipt: the two rules that are easy to get subtly wrong, and one that is a security
 * boundary.
 *
 * These lived inline in `frontends/web/document-routes.ts` and nowhere else, so the native app's
 * new upload path would have been a second implementation of them — which is exactly how two
 * surfaces end up accepting different files.
 *
 *   - **The type allowlist** decides what may be written at all. The web UI serves stored receipts
 *     back INLINE, so an `image/svg+xml` or a `text/html` "receipt" would run script in the app's
 *     own origin. It is checked at the STORAGE door on purpose: a file that never lands cannot be
 *     mis-served later, and the declared MIME is never trusted over the allowlist.
 *   - **The date rule** keeps a fresh upload inside the year the user is looking at. Get it wrong
 *     and the receipt is stored correctly and vanishes from the list it was just added to.
 */
import { describe, expect, it } from '@gjsify/unit';

import {
    deriveAmounts,
    effectiveReceiptType,
    MAX_RECEIPT_BYTES,
    RECEIPT_PATTERNS,
    storeReceipt,
    updateReceiptMetadata,
    uploadDate,
    validateReceiptMetadata,
} from '../../../src/core/actions/documents.ts';
import type { DmsDocument, DmsProvider } from '@steuererklaerung/dms';

/** A built-in-shaped provider that records what it was asked to do. */
function fakeProvider(over: Partial<DmsProvider> = {}) {
    const stored: Array<{ filename: string; mimeType?: string; created?: string; size: number }> = [];
    const linked: Array<{ id: string; txId: string }> = [];
    const provider: DmsProvider = {
        kind: 'builtin',
        list: async () => [],
        get: async () => null,
        getFile: async () => null,
        store: async (input) => {
            stored.push({
                filename: input.filename,
                mimeType: input.mimeType,
                created: input.created,
                size: input.bytes.length,
            });
            return { id: `doc-${stored.length}`, linkedTxIds: [] } as unknown as DmsDocument;
        },
        link: async (id, txId) => {
            linked.push({ id, txId });
        },
        ...over,
    };
    return { provider, stored, linked };
}

const bytes = (n = 4): Uint8Array => new Uint8Array(n);

/** Run `fn` and return the Error it threw. */
async function caught(fn: () => Promise<unknown>): Promise<Error> {
    try {
        await fn();
    } catch (err) {
        return err as Error;
    }
    throw new Error('erwarteter Fehler blieb aus');
}

export default async () => {
    await describe('effectiveReceiptType', async () => {
        await it('accepts the allowed types by declared MIME', async () => {
            expect(effectiveReceiptType('application/pdf', 'x')).toBe('application/pdf');
            expect(effectiveReceiptType('image/png', 'x')).toBe('image/png');
        });

        await it('tolerates a charset parameter and odd casing', async () => {
            expect(effectiveReceiptType('APPLICATION/PDF; charset=binary', 'x')).toBe('application/pdf');
        });

        await it('falls back to the extension when the MIME is missing or unhelpful', async () => {
            expect(effectiveReceiptType(undefined, 'beleg.pdf')).toBe('application/pdf');
            expect(effectiveReceiptType('application/octet-stream', 'foto.JPG')).toBe('image/jpeg');
        });

        await it('REFUSES the script-carrying types, however they are declared', async () => {
            // The whole point: these render inline in the web UI, so accepting one would put
            // attacker-controlled script in the app's own origin.
            expect(effectiveReceiptType('image/svg+xml', 'beleg.svg')).toBe(null);
            expect(effectiveReceiptType('text/html', 'beleg.html')).toBe(null);
            expect(effectiveReceiptType('application/javascript', 'beleg.js')).toBe(null);
        });

        await it('does not let a lying MIME smuggle a disallowed extension through', async () => {
            // A file claiming application/pdf but named .svg is stored as PDF — which is fine,
            // because the STORED type is the allowlisted one and that is what gets served.
            expect(effectiveReceiptType('application/pdf', 'beleg.svg')).toBe('application/pdf');
            // And the reverse cannot happen: an svg claim never wins.
            expect(effectiveReceiptType('image/svg+xml', 'beleg.pdf')).toBe('application/pdf');
        });

        await it('refuses when neither MIME nor extension says anything usable', async () => {
            expect(effectiveReceiptType(undefined, 'beleg')).toBe(null);
            expect(effectiveReceiptType('', '')).toBe(null);
        });

        await it('offers exactly the allowed types as picker patterns', async () => {
            // The picker and the guard must agree, or the user picks a file the store then refuses.
            for (const pattern of RECEIPT_PATTERNS) {
                expect(effectiveReceiptType(undefined, `beleg${pattern.slice(1)}`)).toBeTruthy();
            }
        });
    });

    await describe('uploadDate', async () => {
        await it('uses today when the user is looking at the current year', async () => {
            expect(uploadDate(2025, '2025-06-14')).toBe('2025-06-14');
        });

        await it('stamps into the VIEWED year, so the upload stays in sight', async () => {
            expect(uploadDate(2024, '2025-06-14')).toBe('2024-12-31');
        });

        await it('handles a future viewed year the same way', async () => {
            expect(uploadDate(2026, '2025-06-14')).toBe('2026-12-31');
        });

        await it('uses today when no year is being viewed', async () => {
            expect(uploadDate(undefined, '2025-06-14')).toBe('2025-06-14');
        });
    });

    await describe('storeReceipt', async () => {
        await it('stores the ALLOWLISTED type, not the caller’s claim', async () => {
            const { provider, stored } = fakeProvider();
            await storeReceipt(provider, {
                bytes: bytes(),
                filename: 'beleg.pdf',
                mimeType: 'image/svg+xml',
                today: '2025-06-14',
            });
            expect(stored[0].mimeType).toBe('application/pdf');
        });

        await it('applies the date rule', async () => {
            const { provider, stored } = fakeProvider();
            await storeReceipt(provider, { bytes: bytes(), filename: 'b.pdf', viewYear: 2023, today: '2025-06-14' });
            expect(stored[0].created).toBe('2023-12-31');
        });

        await it('refuses a provider that cannot store, with an actionable message', async () => {
            const { provider } = fakeProvider({ store: undefined });
            const err = await caught(() => storeReceipt(provider, { bytes: bytes(), filename: 'b.pdf' }));
            expect(err.message.includes('Paperless')).toBe(true);
        });

        await it('refuses an unsupported type and names what IS allowed', async () => {
            const { provider, stored } = fakeProvider();
            const err = await caught(() => storeReceipt(provider, { bytes: bytes(), filename: 'b.svg' }));
            expect(err.message.includes('PDF')).toBe(true);
            expect(stored.length).toBe(0); // nothing was written
        });

        await it('refuses a file over the size limit before writing anything', async () => {
            const { provider, stored } = fakeProvider();
            const err = await caught(() =>
                storeReceipt(provider, { bytes: bytes(MAX_RECEIPT_BYTES + 1), filename: 'b.pdf' }),
            );
            expect(err.message.includes('zu groß')).toBe(true);
            expect(stored.length).toBe(0);
        });

        await it('links to a transaction when asked', async () => {
            const { provider, linked } = fakeProvider();
            await storeReceipt(provider, { bytes: bytes(), filename: 'b.pdf', linkTxId: 'tx-1' });
            expect(linked).toStrictEqual([{ id: 'doc-1', txId: 'tx-1' }]);
        });

        await it('KEEPS the stored document when the link fails, and says so', async () => {
            // A GoBD refusal on a locked period must not silently delete the file the user just
            // handed over — nor be swallowed. The message has to carry both facts.
            const { provider, stored } = fakeProvider({
                link: async () => {
                    throw new Error('Periode 2023 ist festgeschrieben (GoBD)');
                },
            });
            const err = await caught(() =>
                storeReceipt(provider, { bytes: bytes(), filename: 'beleg.pdf', linkTxId: 'tx-1' }),
            );
            expect(stored.length).toBe(1); // the receipt survived
            expect(err.message.includes('gespeichert')).toBe(true);
            expect(err.message.includes('festgeschrieben')).toBe(true);
            expect(err.message.includes('beleg.pdf')).toBe(true);
        });
    });

    await describe('deriveAmounts — the arithmetic a human should not have to do', async () => {
        await it('completes the gross from net and VAT', async () => {
            expect(deriveAmounts({ net: 100, vat: 19 })).toStrictEqual({ net: 100, vat: 19, gross: 119 });
        });

        await it('completes the VAT from net and gross', async () => {
            expect(deriveAmounts({ net: 100, gross: 119 })).toStrictEqual({ net: 100, vat: 19, gross: 119 });
        });

        await it('completes the net from VAT and gross', async () => {
            expect(deriveAmounts({ vat: 19, gross: 119 })).toStrictEqual({ net: 100, vat: 19, gross: 119 });
        });

        await it('splits a GROSS with a rate — the number printed largest on a receipt', async () => {
            expect(deriveAmounts({ gross: 119 }, 0.19)).toStrictEqual({ net: 100, vat: 19, gross: 119 });
            expect(deriveAmounts({ gross: 107 }, 0.07)).toStrictEqual({ net: 100, vat: 7, gross: 107 });
        });

        await it('grosses up a NET with a rate', async () => {
            expect(deriveAmounts({ net: 100 }, 0.19)).toStrictEqual({ net: 100, vat: 19, gross: 119 });
        });

        await it('handles the 0 % case without dividing by anything odd', async () => {
            expect(deriveAmounts({ gross: 100 }, 0)).toStrictEqual({ net: 100, vat: 0, gross: 100 });
        });

        await it('rounds to cents rather than carrying float noise into the books', async () => {
            const { net, vat, gross } = deriveAmounts({ gross: 12.44 }, 0.19);
            expect(net).toBe(10.45);
            expect(vat).toBe(1.99);
            expect(gross).toBe(12.44);
            expect(Math.round(((net as number) + (vat as number)) * 100) / 100).toBe(12.44);
        });

        await it('NEVER guesses from a single figure without a rate', async () => {
            expect(deriveAmounts({ gross: 119 })).toStrictEqual({ net: null, vat: null, gross: 119 });
            expect(deriveAmounts({})).toStrictEqual({ net: null, vat: null, gross: null });
        });

        await it('leaves a complete triple untouched, even a slightly-off one', async () => {
            // Correcting the user's own numbers behind their back is worse than flagging them;
            // validateReceiptMetadata is what complains.
            expect(deriveAmounts({ net: 100, vat: 19, gross: 118.99 })).toStrictEqual({
                net: 100,
                vat: 19,
                gross: 118.99,
            });
        });
    });

    await describe('validateReceiptMetadata', async () => {
        await it('accepts a consistent triple', async () => {
            expect(validateReceiptMetadata({ net: 100, vat: 19, gross: 119 })).toStrictEqual([]);
        });

        await it('REJECTS a triple that does not add up', async () => {
            // The load-bearing check: a wrong Vorsteuer figure flows straight into the USt-VA and
            // nothing downstream notices.
            const problems = validateReceiptMetadata({ net: 100, vat: 19, gross: 150 });
            expect(problems.length).toBe(1);
            expect(problems[0].includes('Brutto')).toBe(true);
        });

        await it('tolerates one cent of per-line rounding', async () => {
            expect(validateReceiptMetadata({ net: 100, vat: 19, gross: 119.01 })).toStrictEqual([]);
            expect(validateReceiptMetadata({ net: 100, vat: 19, gross: 119.02 })).toStrictEqual([]);
            expect(validateReceiptMetadata({ net: 100, vat: 19, gross: 119.05 }).length).toBe(1);
        });

        await it('does not check the arithmetic when a figure is missing', async () => {
            expect(validateReceiptMetadata({ net: 100, gross: 500 })).toStrictEqual([]);
        });

        await it('rejects a malformed date and accepts an ISO one', async () => {
            expect(validateReceiptMetadata({ created: '14.06.2025' }).length).toBe(1);
            expect(validateReceiptMetadata({ created: '2025-06-14' })).toStrictEqual([]);
            expect(validateReceiptMetadata({ created: null })).toStrictEqual([]);
        });

        await it('reports EVERY problem at once', async () => {
            // One issue at a time turns a single form into three round trips.
            expect(validateReceiptMetadata({ created: 'gestern', net: 1, vat: 1, gross: 99 }).length).toBe(2);
        });
    });

    await describe('updateReceiptMetadata', async () => {
        await it('writes only the keys the caller supplied', async () => {
            // `undefined` must not reach the provider as a clear, or a dialog showing four fields
            // would blank the other four.
            const patches: Array<Record<string, unknown>> = [];
            const { provider } = fakeProvider({
                setMetadata: async (_id, meta) => {
                    patches.push(meta as Record<string, unknown>);
                },
            });
            await updateReceiptMetadata(provider, 'doc-1', { title: 'Neu', net: null });
            expect(Object.keys(patches[0]).sort()).toStrictEqual(['net', 'title']);
            expect(patches[0].net).toBe(null); // an explicit null DOES clear
        });

        await it('refuses to write an inconsistent triple', async () => {
            const patches: unknown[] = [];
            const { provider } = fakeProvider({
                setMetadata: async (_id, meta) => {
                    patches.push(meta);
                },
            });
            const err = await caught(() => updateReceiptMetadata(provider, 'doc-1', { net: 1, vat: 1, gross: 99 }));
            expect(err.message.includes('Brutto')).toBe(true);
            expect(patches.length).toBe(0);
        });

        await it('refuses a provider that cannot edit metadata', async () => {
            const { provider } = fakeProvider({ setMetadata: undefined });
            const err = await caught(() => updateReceiptMetadata(provider, 'doc-1', { title: 'X' }));
            expect(err.message.includes('Metadaten')).toBe(true);
        });
    });
};
