/**
 * The support prompt: once per tax year, and only where the distribution channel allows donation UI.
 * The channel gate is the policy that keeps a store build free of any donation UI; the year ledger is
 * what keeps a free build from asking twice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from '@gjsify/unit';
import { donationsAllowedFor, type Channel } from '@gjsify/distribution';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    claimSupportPrompt,
    shouldPromptSupport,
    supportLang,
    supportUrl,
} from '../../../src/core/config/support-prompt.ts';
import { loadUserSettings } from '../../../src/core/config/user-settings.ts';

export default async () => {
    await describe('support prompt — channel gating', async () => {
        await it('free channels allow it, store channels and unset builds never do', async () => {
            const allowed: Channel[] = ['flathub', 'web'];
            const blocked: Channel[] = ['microsoft-store', 'apple-app-store', 'unknown'];
            for (const c of allowed) expect(donationsAllowedFor(c)).toBe(true);
            for (const c of blocked) expect(donationsAllowedFor(c)).toBe(false);
        });

        await it('a blocked channel never prompts, even for a year not yet shown', async () => {
            expect(shouldPromptSupport(donationsAllowedFor('microsoft-store'), [], 2025)).toBe(false);
            expect(shouldPromptSupport(donationsAllowedFor('unknown'), undefined, 2025)).toBe(false);
            expect(shouldPromptSupport(donationsAllowedFor('flathub'), [], 2025)).toBe(true);
        });
    });

    await describe('support prompt — once per tax year', async () => {
        let dir = '';
        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), 'support-prompt-'));
            vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'config'));
        });
        afterEach(() => {
            vi.unstubAllEnvs();
            rmSync(dir, { recursive: true, force: true });
        });

        await it('asks the first time for a year, then never again for that year', async () => {
            expect(claimSupportPrompt(2025, true)).toBe(true);
            expect(claimSupportPrompt(2025, true)).toBe(false);
            expect(JSON.stringify(loadUserSettings().supportPromptYears)).toBe(JSON.stringify([2025]));
        });

        await it('the next tax year asks again, and the ledger stays sorted', async () => {
            expect(claimSupportPrompt(2025, true)).toBe(true);
            expect(claimSupportPrompt(2024, true)).toBe(true);
            expect(claimSupportPrompt(2026, true)).toBe(true);
            expect(JSON.stringify(loadUserSettings().supportPromptYears)).toBe(JSON.stringify([2024, 2025, 2026]));
        });

        await it('a blocked channel records nothing, so a later free build still asks', async () => {
            expect(claimSupportPrompt(2025, false)).toBe(false);
            expect(loadUserSettings().supportPromptYears).toBeUndefined();
            expect(claimSupportPrompt(2025, true)).toBe(true);
        });
    });

    await describe('support prompt — the link', async () => {
        await it('German sessions get the German page, everything else the English one', async () => {
            expect(supportLang(['de_DE.UTF-8', 'de_DE', 'de', 'C'])).toBe('de');
            expect(supportLang(['en_US.UTF-8', 'en', 'C'])).toBe('en');
            expect(supportLang(['C'])).toBe('en');
            expect(supportLang([])).toBe('en');
        });

        await it('points at the per-language support page', async () => {
            expect(supportUrl('de')).toBe('https://jumplink.eu/steuererklaerung/de/support/');
            expect(supportUrl('en')).toBe('https://jumplink.eu/steuererklaerung/en/support/');
        });
    });
};
