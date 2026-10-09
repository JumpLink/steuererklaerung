/**
 * Web-client formatting. The runtime-agnostic de-DE formatters now live in the shared kernel
 * (`core/lib/format.ts`) so the native app reuses them without importing across the frontend
 * boundary; re-exported here so existing web-client imports keep working. Only `esc` — HTML/
 * attribute escaping, a DOM concern — stays web-local.
 */

export { eur, pct, deDate, MONTHS, initials, avatarColor } from '../../../../core/lib/format.ts';
export { humanizeKey } from '../../../../core/lib/qonto-categories.ts';

/**
 * Escape text for safe innerHTML insertion — including BOTH quote characters, since the
 * components interpolate esc() into single-quoted attributes too (e.g. `model='${esc(json)}'`).
 * Without escaping `'`, a contact name like `O'Brien` (or an imported `x' onfocus='…`) breaks out
 * of the attribute → attribute injection / stored XSS.
 */
export const esc = (s: unknown): string =>
    String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
