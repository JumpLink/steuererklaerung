import { describe, it, expect } from '@gjsify/unit';
import { markup } from '../../../src/frontends/desktop/views/markup.ts';

export default async () => {
    await describe('desktop markup()', async () => {
        await it('escapes an ampersand in a supplier name', async () => {
            expect(markup('Fon&Net Telecom GmbH')).toBe('Fon&amp;Net Telecom GmbH');
        });
        await it('escapes angle brackets', async () => {
            expect(markup('A <B>')).toBe('A &lt;B&gt;');
        });
        await it('leaves no bare markup characters behind', async () => {
            const out = markup("Müller & Söhne's <b>Fon&Net</b>");
            expect(/<|>|&(?!amp;|lt;|gt;|quot;|apos;)/.test(out)).toBe(false);
        });
    });
};
