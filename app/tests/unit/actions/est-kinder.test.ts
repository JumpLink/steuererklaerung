import { describe, it, expect } from '@gjsify/unit';
import { kindKey } from '../../../src/core/actions/est-kinder.ts';

export default async () => {
    await describe('kindKey', async () => {
        await it('identifies by IdNr when there is one', async () => {
            // The tax office identifies a child by its IdNr; so should we, rather than by a random
            // id that means nothing to anyone reading the manifest.
            expect(kindKey({ idnr: '12345678901', vorname: 'Mia', geburtsdatum: '2016-04-02' })).toBe(
                'idnr:12345678901',
            );
        });

        await it('falls back to name and date of birth, which is what a fresh entry has', async () => {
            // The IdNr arrives by post and is often missing when the child is first entered. Without
            // this fallback the second edit would append a duplicate instead of updating.
            expect(kindKey({ vorname: 'Mia', geburtsdatum: '2016-04-02' })).toBe('name:mia|2016-04-02');
        });

        await it('ignores case and padding in the name, but never in the date', async () => {
            expect(kindKey({ vorname: '  MIA ', geburtsdatum: '2016-04-02' })).toBe('name:mia|2016-04-02');
            // Two children of the same name born on different days are two children.
            expect(kindKey({ vorname: 'Mia', geburtsdatum: '2018-04-02' })).not.toBe(
                kindKey({ vorname: 'Mia', geburtsdatum: '2016-04-02' }),
            );
        });

        await it('treats an IdNr-identified child as the same one after the name is corrected', async () => {
            const before = kindKey({ idnr: '12345678901', vorname: 'Mia', geburtsdatum: '2016-04-02' });
            const after = kindKey({ idnr: '12345678901', vorname: 'Mia-Sophie', geburtsdatum: '2016-04-02' });
            expect(after).toBe(before);
        });
    });
};
