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
            'Der Datensatz nennt keine Leitfaden-ID — er gilt nicht als E-Rechnung nach EN 16931.',
        );
    }
    if (urn.startsWith('urn:ferd:')) {
        return sonstige(
            'zugferd-1',
            null,
            'ZUGFeRD 1.x erfüllt die Anforderungen an eine E-Rechnung nicht (erst ab 2.0.1) — sonstige Rechnung.',
        );
    }
    if (urn.includes('xrechnung')) {
        return eRechnung(
            'xrechnung',
            'XRECHNUNG',
            hybrid
                ? 'XRechnung-Datensatz im PDF — gilt als E-Rechnung.'
                : 'XRechnung-Datensatz nach EN 16931 — gilt als E-Rechnung.',
        );
    }
    const zugferd =
        /^(?:urn:cen\.eu:en16931:2017#(?:compliant|conformant)#)?urn:(zugferd\.de:2p\d|factur-x\.eu:1p0):(\w+)$/.exec(
            urn,
        );
    const family = zugferd?.[1];
    const profileName = zugferd?.[2];
    const note20 =
        family === 'zugferd.de:2p0' ? ' Die Version 2.0.1 oder höher steht nicht im XML — bitte prüfen.' : '';
    if (profileName === 'minimum') {
        return sonstige(
            'zugferd',
            'MINIMUM',
            'ZUGFeRD/Factur-X-Profil MINIMUM ist keine E-Rechnung im Sinne des UStG — sonstige Rechnung.',
        );
    }
    if (profileName === 'basicwl') {
        return sonstige(
            'zugferd',
            'BASIC-WL',
            'ZUGFeRD/Factur-X-Profil BASIC-WL ist keine E-Rechnung im Sinne des UStG — sonstige Rechnung.',
        );
    }
    if (profileName === 'basic' || profileName === 'extended') {
        const p = profileName.toUpperCase();
        return eRechnung('zugferd', p, `ZUGFeRD/Factur-X-Profil ${p} — gilt als E-Rechnung.${note20}`);
    }
    if (urn === 'urn:cen.eu:en16931:2017') {
        return eRechnung(
            hybrid ? 'zugferd' : 'en16931',
            'EN 16931',
            hybrid
                ? `ZUGFeRD/Factur-X-Profil EN 16931 — gilt als E-Rechnung.${note20}`
                : 'Datensatz nach EN 16931 — gilt als E-Rechnung.',
        );
    }
    if (urn.startsWith('urn:cen.eu:en16931:2017')) {
        return eRechnung('en16931', 'EN 16931', 'Datensatz nach EN 16931 (CIUS) — gilt als E-Rechnung.');
    }
    return sonstige(
        'unbekannt',
        null,
        `Die Leitfaden-ID „${guidelineId}“ ist unbekannt — nicht als E-Rechnung erkannt, bitte von Hand prüfen.`,
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
            ? 'PDF ohne eingebetteten Datensatz — keine E-Rechnung, sondern sonstige Rechnung.'
            : 'Bild oder Scan ohne Datensatz — keine E-Rechnung, sondern sonstige Rechnung.',
    );
}

/** A data set was present but unreadable (§14: Formatfehler → sonstige Rechnung). */
export function classifyBroken(message: string): EInvoiceClassification {
    return sonstige('fehler', null, `Datensatz nicht lesbar — sonstige Rechnung. ${message}`);
}

export const INVOICE_KIND_LABEL: Record<EInvoiceClassification['kind'], string> = {
    'e-rechnung': 'E-Rechnung',
    'sonstige-rechnung': 'sonstige Rechnung',
};
