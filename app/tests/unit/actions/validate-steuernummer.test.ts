import { describe, it, expect } from '@gjsify/unit';
import { validateSteuernummer } from '../../../src/core/actions/validate-steuernummer.ts';

export default async () => {
    await describe('validateSteuernummer', async () => {
        await it('says WHICH authority answered, never just "valid"', async () => {
            // The distinction is the point: ERiC knows the per-Land rules, a format check knows the
            // shape. Reporting a shape pass as "valid" is a promise the shape check cannot keep.
            const result = await validateSteuernummer('18/815/08152');
            expect(result.checked === 'eric' || result.checked === 'format').toBe(true);
            if (result.checked === 'format') {
                expect(result.message.includes('keine vollständige Prüfung')).toBe(true);
            }
        });

        await it('converts to the 13-digit ELSTER form on the way', async () => {
            const result = await validateSteuernummer('18/815/08152');
            expect(result.elster).toBe('2318081508152');
        });

        await it('refuses what cannot be a Steuernummer, without asking ERiC', async () => {
            for (const input of ['', '   ', 'abc', '42', '1234567890123456']) {
                const result = await validateSteuernummer(input);
                expect(result.ok).toBe(false);
                expect(result.checked).toBe('format');
            }
        });

        await it('reports a conversion failure as the message, not as a crash', async () => {
            // An unknown Land prefix throws inside toElsterSteuernummer; the row must be able to
            // show that rather than the dialog dying.
            const result = await validateSteuernummer('99/999/99999');
            expect(result.ok === false || result.ok === true).toBe(true);
            expect(typeof result.message).toBe('string');
            expect(result.message.length > 0).toBe(true);
        });
    });
};
