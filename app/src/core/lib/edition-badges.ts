import { _ } from './i18n.ts';

/**
 * Which edition badges a build shows in the About dialog.
 *
 * Every build is open source and says so. A build bought in a store says one thing more: that the
 * purchase supported the project. A free build must never claim a purchase, so `isPurchased` is the
 * `purchased()` capability of `@gjsify/distribution` — never a channel-name comparison, never
 * anything the user can toggle. Wording is "Support", never "donation", and no word about tax.
 */
export type EditionBadgeId = 'open-source' | 'purchased';

export interface EditionBadge {
    id: EditionBadgeId;
    title: string;
    detail: string;
}

/** The ids to show, in display order. */
export function editionBadgeIds(isPurchased: boolean): EditionBadgeId[] {
    return isPurchased ? ['open-source', 'purchased'] : ['open-source'];
}

/** The badges with their translated texts, in display order. */
export function editionBadges(isPurchased: boolean): EditionBadge[] {
    const all: Record<EditionBadgeId, EditionBadge> = {
        'open-source': {
            id: 'open-source',
            title: _('Open Source'),
            detail: _('Thank you for using open source software.'),
        },
        purchased: {
            id: 'purchased',
            title: _('Supporter'),
            detail: _('You supported this open source project by buying the app. Thank you!'),
        },
    };
    return editionBadgeIds(isPurchased).map((id) => all[id]);
}
