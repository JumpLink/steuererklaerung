/**
 * The text of an error, in the language of the window.
 *
 * Core errors carry a German message because the CLI and the MCP tools print it unchanged. An error
 * the window is likely to show also carries a `detail` — a stable `code` plus the values that went
 * into the sentence (see `ErrorDetail` in core/lib/errors.ts) — and this module turns that into the
 * UI language. An error without a `detail`, or with a code this module does not know, falls back to
 * the message itself: still understandable, just not translated, and never swallowed.
 *
 * Adding a case: give the throw site a `detail`, add the code to error-detail-text.ts with a literal `_()` so the
 * extractor sees it, then `dev/i18n.sh extract` and translate it in `po/de.po`.
 */

import type { ErrorDetail } from '../../core/lib/errors.ts';
import { translateDetail } from './error-detail-text.ts';
import { _ } from './i18n.ts';

/** The `detail` of a thrown value, when it has one. */
function detailOf(err: unknown): ErrorDetail | undefined {
    if (typeof err !== 'object' || err === null) return undefined;
    const detail = (err as { detail?: unknown }).detail;
    if (typeof detail !== 'object' || detail === null) return undefined;
    return typeof (detail as { code?: unknown }).code === 'string' ? (detail as ErrorDetail) : undefined;
}

/** What to show for a thrown value: its translated text if it has one, else its message. */
export function errorText(err: unknown): string {
    const detail = detailOf(err);
    const translated = detail ? translateDetail(detail, _) : null;
    if (translated !== null) return translated;
    return err instanceof Error ? err.message : String(err);
}
