/**
 * Is this Steuernummer usable — asked of ERiC when it is installed, and of a format check when it
 * is not, with the answer saying WHICH of the two was asked.
 *
 * A Steuernummer gates every filing this program does, and until now it could only be entered ONCE,
 * in the first-run assistant, with no validation at all. A typo there is discovered by ELSTER
 * rejecting a transmission months later.
 *
 * The distinction matters more than the verdict: ERiC knows the per-Land rules (which
 * Bundesfinanzamt prefixes exist, which check digit follows), a regex knows the shape. Reporting a
 * format pass as "valid" would be a promise the format check cannot keep — so the result says
 * `checked: 'eric' | 'format'` and the surface repeats it.
 */

import { toElsterSteuernummer } from '../elster/steuernummer.ts';

export interface SteuernummerCheck {
    ok: boolean;
    /** Which authority answered — `eric` is conclusive, `format` is a shape check only. */
    checked: 'eric' | 'format';
    /** The 13-digit ELSTER form, when the input could be converted. */
    elster?: string;
    /** German, ready to show. */
    message: string;
}

/** 13 digits is the ELSTER form; the regional forms carry slashes or spaces. */
function looksLikeSteuernummer(input: string): boolean {
    const digits = input.replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 13;
}

/**
 * Check `input`, preferring ERiC.
 *
 * ERiC is loaded lazily and its absence is NOT an error: a fresh installation has no ERiC, and
 * refusing to sanity-check the number at all would be worse than checking its shape.
 */
export async function validateSteuernummer(input: string): Promise<SteuernummerCheck> {
    const raw = input.trim();
    if (!raw) return { ok: false, checked: 'format', message: 'Keine Steuernummer eingetragen.' };
    if (!looksLikeSteuernummer(raw)) {
        return {
            ok: false,
            checked: 'format',
            message: 'Das sieht nicht nach einer Steuernummer aus — erwartet werden 10 bis 13 Ziffern.',
        };
    }

    let elster: string | undefined;
    try {
        elster = toElsterSteuernummer(raw);
    } catch (err) {
        return {
            ok: false,
            checked: 'format',
            message: err instanceof Error ? err.message : String(err),
        };
    }

    try {
        const eric = await import('@steuererklaerung/eric');
        if (eric.isEricAvailable()) {
            const ok = eric.checkSteuernummer(elster);
            return {
                ok,
                checked: 'eric',
                elster,
                message: ok
                    ? `Von ERiC geprüft und akzeptiert (${elster}).`
                    : `ERiC weist diese Steuernummer zurück (${elster}). Bitte gegen den Bescheid prüfen.`,
            };
        }
    } catch {
        // No ERiC, or a binding that will not load. The format answer below is the honest fallback.
    }

    return {
        ok: true,
        checked: 'format',
        elster,
        message: `Form ist plausibel (${elster}). Ohne ERiC ist das keine vollständige Prüfung.`,
    };
}
