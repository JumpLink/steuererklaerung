import { describe, it, expect } from '@gjsify/unit';
import { toElsterSteuernummer, bufaFromElsterSteuernummer } from '../../../src/core/elster/steuernummer.ts';

export default async () => {
    await describe('steuernummer', async () => {
        await it('converts a regional Niedersachsen number to 13-digit ELSTER form', async () => {
            // 18/815/08152 → BuFa prefix 23 → 2318 0 815 08152
            expect(toElsterSteuernummer('18/815/08152')).toBe('2318081508152');
        });

        await it('passes a 13-digit number through unchanged', async () => {
            expect(toElsterSteuernummer('2318081508152')).toBe('2318081508152');
        });

        await it('throws on an unknown Landeskennung', async () => {
            expect(() => toElsterSteuernummer('99/815/08152')).toThrow();
        });

        await it('throws on a non-regional shape', async () => {
            expect(() => toElsterSteuernummer('1881508152')).toThrow();
        });

        await it('derives the BuFa (Empfaenger) from the first 4 digits', async () => {
            expect(bufaFromElsterSteuernummer('2318081508152')).toBe('2318');
        });
    });
};
