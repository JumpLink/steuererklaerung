import { describe, it, expect } from '@gjsify/unit';
import { GLOSSARY, GLOSSARY_EN, glossaryFor } from '../../../src/core/lib/glossary.ts';

export default async () => {
    await describe('glossary', async () => {
        await it('explains every term in both languages', async () => {
            expect(Object.keys(GLOSSARY_EN).sort().join()).toBe(Object.keys(GLOSSARY).sort().join());
            for (const entry of Object.values(GLOSSARY_EN)) {
                expect(entry.title.length > 0).toBe(true);
                expect(entry.text.length > 0).toBe(true);
            }
        });

        await it('keeps official German tax terms in the English titles', async () => {
            expect(GLOSSARY_EN.euer.title.startsWith('Anlage EÜR')).toBe(true);
            expect(GLOSSARY_EN.ustva.title.startsWith('Umsatzsteuer-Voranmeldung')).toBe(true);
            expect(GLOSSARY_EN.gewerbesteuer.title.startsWith('Gewerbesteuer')).toBe(true);
        });

        await it('picks German for de and English otherwise', async () => {
            expect(glossaryFor('de')).toBe(GLOSSARY);
            expect(glossaryFor('en')).toBe(GLOSSARY_EN);
            expect(glossaryFor('fr')).toBe(GLOSSARY_EN);
        });
    });
};
