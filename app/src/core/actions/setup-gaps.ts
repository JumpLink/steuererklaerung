/**
 * What an installation still needs before it is usable — the one decision behind the setup banner.
 *
 * Essential is deliberately short: without an entity nothing can be saved at all (the pseudo-entity
 * the app falls back to fails every write), and an entity without a bank account has no transactions
 * to compute anything from. Paperless, ELSTER, AI and the rest are optional by design and never count.
 *
 * Demo entities are fictional and never a gap: the demo is complete as shipped, and a banner asking
 * someone to "finish" it would point them at data that is not theirs.
 *
 * Pure: no disk, no GTK. The window feeds it the manifest and the settings and shows the answer.
 */

/** The part of a manifest entity the decision reads. */
export interface SetupGapEntity {
    id: string;
    name: string;
    /** The manifest's account globs, unexpanded — "assigned", not "has transactions yet". */
    accounts: readonly string[];
    demo?: boolean;
}

export type SetupGap = { kind: 'no-entity' } | { kind: 'no-account'; entityId: string; entityName: string };

/** The gaps, in the order they should be fixed. `entities` is `null` when no manifest exists. */
export function setupGaps(entities: readonly SetupGapEntity[] | null): SetupGap[] {
    if (!entities || entities.length === 0) return [{ kind: 'no-entity' }];
    return entities
        .filter((e) => !e.demo && e.accounts.length === 0)
        .map((e) => ({ kind: 'no-account', entityId: e.id, entityName: e.name }));
}

/** One stable key per gap — what a dismissal remembers. */
export function setupGapKey(gap: SetupGap): string {
    return gap.kind === 'no-entity' ? 'no-entity' : `no-account:${gap.entityId}`;
}

/** The keys of all gaps, sorted — stored when the banner is closed. */
export function setupGapFingerprint(gaps: readonly SetupGap[]): string[] {
    return [...new Set(gaps.map(setupGapKey))].sort();
}

/** The per-user settings the decision reads. */
export interface SetupBannerSettings {
    welcomeCompleted: boolean;
    welcomeDeferred?: boolean;
    setupBannerDismissed?: readonly string[];
}

/**
 * Whether the banner shows: only for someone who put the welcome off („Later") and has not finished
 * it since, only while a gap exists, and only when at least one gap is NEW since the last dismissal.
 *
 * Gated on `welcomeDeferred` rather than on "welcome not completed": every installation from before
 * the welcome existed has no settings file, so "not completed" would greet a working setup — say a
 * private entity that never needed an account — with a banner it never asked for.
 */
export function shouldShowSetupBanner(settings: SetupBannerSettings, gaps: readonly SetupGap[]): boolean {
    if (settings.welcomeCompleted || !settings.welcomeDeferred) return false;
    if (gaps.length === 0) return false;
    const dismissed = new Set(settings.setupBannerDismissed ?? []);
    return gaps.some((g) => !dismissed.has(setupGapKey(g)));
}
