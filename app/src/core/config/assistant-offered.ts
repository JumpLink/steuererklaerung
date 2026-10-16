/**
 * Whether this BUILD offers the built-in AI assistant at all — the one question above every
 * per-user preference, asked by the desktop window, the settings, the welcome, the web nav and
 * every job that would reach an LLM.
 *
 * 0.1.0 ships without it. Not "off by default" but not offered: no pane, no toggle, no setting,
 * no welcome page, and no background job that could start a provider. The code stays exactly
 * where it is — bringing the assistant back for 0.2 (lotse, issue #95) is this one constant.
 *
 * Above the person's own switch, never instead of it: an installation whose `settings.json` says
 * `aiAssistant: true` is read as before and left untouched, so it takes effect again the day this
 * flips back.
 */

import { _ } from '../lib/i18n.ts';

/** Flip to `true` to offer the assistant again. */
const ASSISTANT_OFFERED = false;

let override: boolean | null = null;

/** Test seam: pretend the build does (not) offer the assistant (`null` restores the constant). */
export function setAssistantOfferedOverride(value: boolean | null): void {
    override = value;
}

/** @see ASSISTANT_OFFERED */
export function assistantOffered(): boolean {
    return override ?? ASSISTANT_OFFERED;
}

/**
 * What to tell a person who reached an AI path anyway (a CLI command, an MCP tool). Built on
 * call, not at module level, so the frontend's translator is registered by then.
 */
export function assistantNotOfferedMessage(): string {
    return _('This version has no built-in AI assistant.');
}
