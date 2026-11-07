/**
 * Remember the last navigated section per entity.
 *
 * The native app keeps the collapsed sidebar as the root page on a phone; restoring the previously
 * open section saves one tap on every launch. The same logic runs on desktop so an entity switch
 * lands where the person left it.
 *
 * Storage is GSettings when the schema is available (installed app), falling back to the existing
 * JSON user-settings file during development or when the schema has not been compiled yet. The
 * public surface is a tiny store interface so the logic can be unit-tested without GTK.
 */

import Gio from '@girs/gio-2.0';

import { loadUserSettings, updateUserSettings } from '../../core/config/user-settings.ts';
import type { NavViewId } from './nav.ts';

export interface LastSectionStore {
    /** Read the stored view for an entity, or undefined if nothing was stored. */
    getLastSection(entityId: string): NavViewId | undefined;
    /** Store the view that was last open for an entity. */
    setLastSection(entityId: string, view: NavViewId): void;
}

const SCHEMA_ID = 'eu.jumplink.Steuererklaerung';
const KEY = 'last-sections';
/** Unit separator: entity id and view id must never contain this character. */
const SEP = '\x1f';
const USER_KEY = 'lastSections' as const;

/** Encode one entity/view pair for the GSettings string array. */
export function encodeLastSection(entityId: string, view: NavViewId): string {
    return `${entityId}${SEP}${view}`;
}

/** Decode the GSettings string array into a map of entity id → view id. */
export function parseLastSections(values: readonly string[]): Map<string, NavViewId> {
    const map = new Map<string, NavViewId>();
    for (const value of values) {
        const idx = value.indexOf(SEP);
        if (idx <= 0 || idx === value.length - 1) continue;
        const entityId = value.slice(0, idx);
        const view = value.slice(idx + 1);
        if (entityId) map.set(entityId, view as NavViewId);
    }
    return map;
}

/** Build the GSettings string array from a map of entity id → view id. */
export function buildLastSections(map: ReadonlyMap<string, NavViewId>): string[] {
    const out: string[] = [];
    for (const [entityId, view] of map) {
        out.push(encodeLastSection(entityId, view));
    }
    return out;
}

/** Whether the compiled GSettings schema is present in the given (or default) source. */
export function schemaIsAvailable(
    source: Gio.SettingsSchemaSource | null = Gio.SettingsSchemaSource.get_default(),
): boolean {
    return source !== null && source.lookup(SCHEMA_ID, true) !== null;
}

/** A GSettings-backed store. Returns null when the schema is not installed/compiled. */
export function gioSettingsStore(): LastSectionStore | null {
    // `new Gio.Settings({ schema_id })` aborts the process when the schema is missing, so we must
    // check the schema source first. The try/catch stays as a second line of defence.
    if (!schemaIsAvailable()) return null;
    let settings: Gio.Settings;
    try {
        settings = new Gio.Settings({ schema_id: SCHEMA_ID });
    } catch {
        return null;
    }
    return {
        getLastSection(entityId) {
            const values = settings.get_strv(KEY);
            return parseLastSections(values).get(entityId);
        },
        setLastSection(entityId, view) {
            const values = settings.get_strv(KEY);
            const map = parseLastSections(values);
            map.set(entityId, view);
            settings.set_strv(KEY, buildLastSections(map));
        },
    };
}

/** JSON user-settings fallback for development or when GSettings is unavailable. */
export function userSettingsStore(): LastSectionStore {
    return {
        getLastSection(entityId) {
            const sections = loadUserSettings()[USER_KEY] as Record<string, NavViewId> | undefined;
            return sections?.[entityId];
        },
        setLastSection(entityId, view) {
            updateUserSettings((settings) => {
                const sections = (settings[USER_KEY] ??= {}) as Record<string, NavViewId>;
                sections[entityId] = view;
            });
        },
    };
}

/** Best-effort store: GSettings if compiled, otherwise the JSON user-settings fallback. */
export function lastSectionStore(): LastSectionStore {
    return gioSettingsStore() ?? userSettingsStore();
}

/**
 * Pick the view to restore for an entity.
 *
 * Unknown, empty or no-longer-visible values fall back to the start page (`home`). This is the one
 * place that decides “can this stored value be shown again”, so the UI never crashes on stale data.
 */
export function resolveLastSection(
    entityId: string,
    visibleViews: readonly NavViewId[],
    store: LastSectionStore,
    fallback: NavViewId = 'home',
): NavViewId {
    if (visibleViews.length === 0) return fallback;
    const stored = store.getLastSection(entityId);
    if (stored && visibleViews.includes(stored)) return stored;
    return fallback;
}
