import { describe, it, expect } from '@gjsify/unit';
import { editionBadgeIds, editionBadges } from '../../../src/core/lib/edition-badges.ts';

const idsFor = (pricing: 'free' | 'paid') => editionBadgeIds(pricing === 'paid').join(',');

export default async () => {
    await describe('edition badges', async () => {
        await it('only a paid build claims a purchase, a free store download does not', async () => {
            expect(idsFor('paid')).toBe('open-source,purchased');
            expect(idsFor('free')).toBe('open-source');
        });
        await it('open source always comes first', async () => {
            expect(editionBadges(true)[0].id).toBe('open-source');
            expect(editionBadges(false).length).toBe(1);
        });
        await it('never words a support as a donation or a tax deduction', async () => {
            const text = editionBadges(true)
                .map((b) => `${b.title} ${b.detail}`)
                .join(' ')
                .toLowerCase();
            for (const banned of ['donat', 'spende', 'steuer', 'tax', 'deduct']) expect(text.includes(banned)).toBe(false);
        });
    });
};
