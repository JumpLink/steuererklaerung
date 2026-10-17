/**
 * "E-Rechnung" or "sonstige Rechnung" — the §14 UStG distinction, decided from the guideline ID
 * (BT-24 / CustomizationID) of the data set, never by AI.
 *
 * Rules, quoted from docs/references/tax-sources.md, section "§14 UStG — E-Rechnung":
 *   - Begriff:  E-Rechnung = strukturiertes Format nach EN 16931 (§14 Abs. 1 S. 3–6 UStG). Alles andere
 *               (Papier, PDF ohne Datensatz, Bild, Mailtext) ist eine sonstige Rechnung.
 *   - Formate:  XRechnung und ZUGFeRD ab 2.0.1 erfüllen die Anforderungen — außer den ZUGFeRD-Profilen
 *               MINIMUM und BASIC-WL (BMF-FAQ E-Rechnung, Frage 7).
 *   - Fehler:   Formatfehler → keine E-Rechnung, sondern sonstige Rechnung (BMF 15.10.2025).
 * The guideline URNs matched below are listed with their source in the same section, table
 * "Leitfaden-IDs (Guideline-URN)".
 */

import { _, fmt } from '../../lib/i18n.ts';
import type { EInvoice, EInvoiceClassification } from './types.ts';

const eRechnung = (
    format: EInvoiceClassification['format'],
    profile: string | null,
    reason: string,
): EInvoiceClassification => ({ kind: 'e-rechnung', format, profile, reason });

const sonstige = (
    format: EInvoiceClassification['format'],
    profile: string | null,
    reason: string,
): EInvoiceClassification => ({ kind: 'sonstige-rechnung', format, profile, reason });

/**
 * Classify by guideline URN. `hybrid` is true when the data set came out of a PDF (ZUGFeRD /
 * Factur-X) rather than from a bare XML file.
 */
export function classifyGuideline(guidelineId: string | null, hybrid: boolean): EInvoiceClassification {
    const urn = (guidelineId ?? '').trim().toLowerCase();
    if (!urn) {
        return sonstige(
            'unbekannt',
            null,
            _('The data set names no guideline ID — it does not count as an E-Rechnung under EN 16931.'),
        );
    }
    if (urn.startsWith('urn:ferd:')) {
        return sonstige(
            'zugferd-1',
            null,
            _('ZUGFeRD 1.x does not meet the requirements for an E-Rechnung (only from 2.0.1) — other invoice.'),
        );
    }
    if (urn.includes('xrechnung')) {
        return eRechnung(
            'xrechnung',
            'XRECHNUNG',
            hybrid
                ? _('XRechnung data set inside the PDF — counts as an E-Rechnung.')
                : _('XRechnung data set under EN 16931 — counts as an E-Rechnung.'),
        );
    }
    const zugferd =
        /^(?:urn:cen\.eu:en16931:2017#(?:compliant|conformant)#)?urn:(zugferd\.de:2p\d|factur-x\.eu:1p0):(\w+)$/.exec(
            urn,
        );
    const family = zugferd?.[1];
    const profileName = zugferd?.[2];
    const note20 =
        family === 'zugferd.de:2p0' ? ` ${_('Version 2.0.1 or higher is not stated in the XML — please check.')}` : '';
    if (profileName === 'minimum') {
        return sonstige(
            'zugferd',
            'MINIMUM',
            _('The ZUGFeRD/Factur-X profile MINIMUM is not an E-Rechnung under the UStG — other invoice.'),
        );
    }
    if (profileName === 'basicwl') {
        return sonstige(
            'zugferd',
            'BASIC-WL',
            _('The ZUGFeRD/Factur-X profile BASIC-WL is not an E-Rechnung under the UStG — other invoice.'),
        );
    }
    const profilGilt = (p: string) =>
        fmt(_('ZUGFeRD/Factur-X profile {profile} — counts as an E-Rechnung.'), { profile: p });
    if (profileName === 'basic' || profileName === 'extended') {
        const p = profileName.toUpperCase();
        return eRechnung('zugferd', p, `${profilGilt(p)}${note20}`);
    }
    if (urn === 'urn:cen.eu:en16931:2017') {
        return eRechnung(
            hybrid ? 'zugferd' : 'en16931',
            'EN 16931',
            hybrid ? `${profilGilt('EN 16931')}${note20}` : _('Data set under EN 16931 — counts as an E-Rechnung.'),
        );
    }
    if (urn.startsWith('urn:cen.eu:en16931:2017')) {
        return eRechnung('en16931', 'EN 16931', _('Data set under EN 16931 (CIUS) — counts as an E-Rechnung.'));
    }
    return sonstige(
        'unbekannt',
        null,
        fmt(_('The guideline ID “{id}” is unknown — not recognised as an E-Rechnung, please check by hand.'), {
            id: guidelineId ?? '',
        }),
    );
}

/** Classify a parsed invoice by its guideline ID. */
export function classifyInvoice(inv: EInvoice, hybrid: boolean): EInvoiceClassification {
    return classifyGuideline(inv.guidelineId, hybrid);
}

/** A PDF or image without a machine-readable data set. */
export function classifyWithoutDataSet(isPdf: boolean): EInvoiceClassification {
    return sonstige(
        'ohne-datensatz',
        null,
        isPdf
            ? _('PDF without an embedded data set — not an E-Rechnung but an other invoice.')
            : _('Image or scan without a data set — not an E-Rechnung but an other invoice.'),
    );
}

/** A data set was present but unreadable (§14: Formatfehler → sonstige Rechnung). */
export function classifyBroken(message: string): EInvoiceClassification {
    return sonstige('fehler', null, fmt(_('Data set not readable — other invoice. {message}'), { message }));
}

/**
 * The badge labels, matching the glossary titles so label and popover stay one pair. A function,
 * not a constant: the translator is bound at startup, after module evaluation.
 */
export function invoiceKindLabel(kind: EInvoiceClassification['kind']): string {
    return kind === 'e-rechnung' ? _('E-Rechnung (e-invoice)') : _('Other invoice');
}
