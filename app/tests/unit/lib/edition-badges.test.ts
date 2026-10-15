import { describe, it, expect } from '@gjsify/unit';
import { purchasedFor, type Channel } from '@gjsify/distribution';
import { editionBadgeIds, editionBadges } from '../../../src/core/lib/edition-badges.ts';

const idsFor = (channel: Channel) => editionBadgeIds(purchasedFor(channel)).join(',');

export default async () => {
    await describe('edition badges', async () => {
        await it('only the store channels claim a purchase', async () => {
            expect(idsFor('microsoft-store')).toBe('open-source,purchased');
            expect(idsFor('apple-app-store')).toBe('open-source,purchased');
            for (const free of ['flathub', 'web', 'unknown'] as Channel[]) expect(idsFor(free)).toBe('open-source');
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
