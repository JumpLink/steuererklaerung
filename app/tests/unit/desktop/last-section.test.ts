/**
 * Tests for remembering the last section per entity.
 *
 * The public logic is store-agnostic; real GSettings is never needed here.
 */

import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';
import { describe, expect, it } from '@gjsify/unit';

import type { NavViewId } from '../../../src/frontends/desktop/nav.ts';
import {
    buildLastSections,
    encodeLastSection,
    gioSettingsStore,
    parseLastSections,
    resolveLastSection,
    schemaIsAvailable,
    type LastSectionStore,
} from '../../../src/frontends/desktop/last-section.ts';

function makeStore(initial: Record<string, NavViewId> = {}): LastSectionStore {
    const data = new Map<string, NavViewId>(Object.entries(initial));
    return {
        getLastSection: (id) => data.get(id),
        setLastSection: (id, view) => {
            data.set(id, view);
        },
    };
}

export default async () => {
    await describe('last-section', async () => {
        it('encode and parse round-trip', () => {
            const encoded = encodeLastSection('gbr', 'transactions');
            expect(encoded).toBe('gbr\x1ftransactions');
            const map = parseLastSections([encoded]);
            expect(map.get('gbr')).toBe('transactions');
        });

        it('parse ignores malformed entries', () => {
            const map = parseLastSections([
                'gbr\x1ftransactions',
                'no-separator',
                '\x1ftransactions',
                'gbr\x1f',
                '',
                'privat\x1fhome',
            ]);
            expect(map.size).toBe(2);
            expect(map.get('gbr')).toBe('transactions');
            expect(map.get('privat')).toBe('home');
        });

        it('build produces one encoded entry per entity', () => {
            const map = new Map<string, NavViewId>([
                ['gbr', 'rechnungen'],
                ['privat', 'settings'],
            ]);
            const built = buildLastSections(map);
            expect(built.length).toBe(2);
            expect(parseLastSections(built).get('gbr')).toBe('rechnungen');
            expect(parseLastSections(built).get('privat')).toBe('settings');
        });

        it('resolve returns stored view when it is visible', () => {
            const store = makeStore({ gbr: 'transactions' });
            expect(resolveLastSection('gbr', ['home', 'transactions', 'settings'], store)).toBe('transactions');
        });

        it('resolve falls back to home when nothing is stored', () => {
            const store = makeStore();
            expect(resolveLastSection('gbr', ['home', 'transactions'], store)).toBe('home');
        });

        it('resolve falls back to home for an unknown view id', () => {
            const store = makeStore({ gbr: 'not-a-view' as NavViewId });
            expect(resolveLastSection('gbr', ['home', 'transactions'], store)).toBe('home');
        });

        it('resolve falls back to home for a view hidden for this entity', () => {
            const store = makeStore({ privat: 'rechnungen' });
            expect(resolveLastSection('privat', ['home', 'fristen', 'settings'], store)).toBe('home');
        });

        it('resolve never crashes on empty visible list', () => {
            const store = makeStore({ gbr: 'home' });
            expect(resolveLastSection('gbr', [], store)).toBe('home');
        });

        it('setLastSection stores a value the store can read back', () => {
            const store = makeStore();
            store.setLastSection('gbr', 'konten');
            expect(store.getLastSection('gbr')).toBe('konten');
        });

        it('schemaIsAvailable reports whether the default source has the schema', () => {
            const source = Gio.SettingsSchemaSource.get_default();
            const has = source !== null && source.lookup('eu.jumplink.Steuererklaerung', true) !== null;
            expect(schemaIsAvailable()).toBe(has);
        });

        it('gioSettingsStore returns null when the schema is absent', () => {
            const source = Gio.SettingsSchemaSource.get_default();
            const has = source !== null && source.lookup('eu.jumplink.Steuererklaerung', true) !== null;
            if (has) {
                expect(gioSettingsStore()).not.toBe(null);
            } else {
                expect(gioSettingsStore()).toBe(null);
            }
        });
    });
};
