/**
 * Whether the built-in AI assistant is on — the ONE answer the desktop panel, the web nav and
 * `/api/chat` all ask.
 *
 * The switch is per user (`settings.json` → `aiAssistant`), not manifest data: it is this person's
 * consent to send questions to an AI provider, the welcome asks it before any manifest exists,
 * and a manifest may be shared by several people. The manifest's `app.assistant.enabled` predates
 * that and is read ONLY while the person has never decided — so an installation that switched the
 * assistant off there keeps it off, and nothing is migrated or written.
 *
 * Independent of the MCP server switch: the built-in assistant gets its tools in-process.
 */

import { loadAppSettings } from './accessors.ts';
import { getManifestPath } from './manifest.ts';
import { loadUserSettings, type UserSettings } from './user-settings.ts';

export function isAssistantEnabled(
    user: UserSettings = loadUserSettings(),
    manifestPath: string = getManifestPath(),
): boolean {
    if (user.aiAssistant !== undefined) return user.aiAssistant;
    try {
        return loadAppSettings(manifestPath).assistant.enabled;
    } catch {
        // No (readable) manifest: the behaviour from before the switch existed — available.
        return true;
    }
}
