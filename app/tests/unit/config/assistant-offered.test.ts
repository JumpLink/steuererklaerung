/**
 * The one switch above every AI path: not offered → the preference answers `false` whatever the
 * settings say, and no provider can be built. Flipped back → the person's own answer counts again.
 */
import { describe, expect, it } from '@gjsify/unit';

import { assistantOffered, setAssistantOfferedOverride } from '../../../src/core/config/assistant-offered.ts';
import { isAssistantEnabled } from '../../../src/core/config/assistant-preference.ts';
import type { UserSettings } from '../../../src/core/config/user-settings.ts';
import { getLLMProvider, setLLMProviderOverride } from '../../../src/core/clients/llm/index.ts';

/** A settings object with nothing in it but the answer under test. */
function settings(aiAssistant?: boolean): UserSettings {
    return { version: 1, welcomeCompleted: true, backup: { keep: 3 }, aiAssistant };
}

/** A path that cannot be read, so only the per-user answer and the build constant are left. */
const NO_MANIFEST = '/nonexistent/steuererklaerung.json';

export default async () => {
    await describe('assistantOffered', async () => {
        await it('is off in this build', async () => {
            expect(assistantOffered()).toBe(false);
        });

        await it('overrides the person’s own yes without touching it', async () => {
            const user = settings(true);
            expect(isAssistantEnabled(user, NO_MANIFEST)).toBe(false);
            // The settings object is the one the caller passed: nothing was written back to it.
            expect(user.aiAssistant).toBe(true);
        });

        await it('answers false where an undecided user would have got true', async () => {
            expect(isAssistantEnabled(settings(), NO_MANIFEST)).toBe(false);
        });

        await it('refuses to build an LLM provider', async () => {
            let message = '';
            setLLMProviderOverride(null); // no leftover seam from another suite
            try {
                getLLMProvider();
            } catch (err) {
                message = err instanceof Error ? err.message : String(err);
            }
            expect(message).toBe('This version has no built-in AI assistant.');
        });

        await it('lets the person decide again once the build offers it', async () => {
            setAssistantOfferedOverride(true);
            try {
                expect(assistantOffered()).toBe(true);
                expect(isAssistantEnabled(settings(true), NO_MANIFEST)).toBe(true);
                expect(isAssistantEnabled(settings(false), NO_MANIFEST)).toBe(false);
            } finally {
                setAssistantOfferedOverride(null);
            }
            expect(assistantOffered()).toBe(false);
        });
    });
};
