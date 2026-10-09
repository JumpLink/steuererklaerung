/**
 * USt-Jahreserklärung (UStE, schema USt_50_2025) — annual VAT aggregation.
 *
 * Derived from the SAME transaction-driven EÜR aggregate that produces the Gewinn, so
 * the annual VAT figures reconcile to the EÜR by construction (same `camt:*` ground
 * truth, already fully classified). The taxable revenue is split by rate via the
 * shared {@link impliedRate}; input/output VAT and the Zahllast come straight from the
 * EÜR totals.
 *
 * (A document-driven `--by documents` path over Jan–Dec — for the JumpLink reuse where
 * Paperless invoices are authoritative — is a later addition.)
 */

import { round2 } from '../lib/money.ts';
import { impliedRate, PRIVATANTEIL_CATEGORY, type EuerTxAggregate } from './euer-transactions.ts';
import { hasReverseCharge, type ReverseChargeTotals } from './reverse-charge.ts';

/** One asset withdrawn at Betriebsaufgabe that is a §3 Abs. 1b supply (see {@link UsteEntnahme}). */
export interface UsteEntnahmeAsset {
    bezeichnung: string;
    /** Wiederbeschaffungswert at withdrawal = the Aufgabegewinn's gemeiner Wert (§10 Abs. 4 Nr. 1). */
    gemeinerWert: number;
}

/** The Betriebsaufgabe input for the UStE: the assets deemed supplied under §3 Abs. 1b at 19 %. */
export interface UsteEntnahme {
    assets: UsteEntnahmeAsset[];
}

export interface UsteAggregate {
    year: number;
    /**
     * Steuerpflichtige Umsätze zu 19 % (net) — Kz 81, i.e. the USt-VA view: the TOTAL incl. both
     * kinds of unentgeltliche Wertabgabe. The annual UStE splits this over three Vordruckzeilen —
     * see {@link lieferungenSonstLeistungen_19} / {@link wertabgabeLieferung_19} /
     * {@link wertabgabeSonstige_19}, which always sum back to this.
     */
    net_19: number;
    /** Zeile 22 (E3003303): Lieferungen und sonstige Leistungen zu 19 % — without the Wertabgaben. */
    lieferungenSonstLeistungen_19: number;
    /**
     * Zeile 23 (E3003405): unentgeltliche Wertabgabe — **Lieferungen nach §3 Abs. 1b UStG** at 19 %.
     * Fed by the Betriebsaufgabe: taking an asset that entitled to Vorsteuerabzug into private
     * ownership is deemed a supply for consideration. Bemessungsgrundlage is the Wiederbeschaffungs-
     * wert at withdrawal (§10 Abs. 4 Nr. 1) — which is exactly the *gemeiner Wert* the
     * Aufgabegewinn already uses — NOT the Restbuchwert.
     */
    wertabgabeLieferung_19: number;
    /**
     * Zeile 24 (E3003505): unentgeltliche Wertabgabe — **sonstige Leistungen nach §3 Abs. 9a UStG**
     * at 19 % (the config `privatanteile`, e.g. private telephone use).
     */
    wertabgabeSonstige_19: number;
    /** The assets behind {@link wertabgabeLieferung_19} — for the Prüfblatt and a human check. */
    entnahmeAssets?: Array<{ bezeichnung: string; gemeinerWert: number }>;
    /** Steuerpflichtige Umsätze zu 7 % (net) — Kz 86. */
    net_7: number;
    /** Übrige (steuerfrei / 0 %) Umsätze (net), informational. */
    net_0: number;
    /** Vereinnahmte Umsatzsteuer (output VAT). */
    vat_out: number;
    /** Abziehbare Vorsteuerbeträge (input VAT) — Kz 66. */
    vat_in: number;
    /** Annual USt-Zahllast (vat_out − vat_in). */
    vatPayable: number;
    /**
     * Σ of the already-filed USt-VA Zahllasten for the year (config: uste.prepaid_vat).
     * The Abschlusszahlung/Erstattung is vatPayable − prepaid.
     */
    prepaidVat: number;
    /** vatPayable − prepaidVat: positive ⇒ Abschlusszahlung, negative ⇒ Erstattung. */
    closingBalance: number;
    /**
     * Where `prepaidVat` came from: 'register' (summed from filed USt-VA in the filings register),
     * 'config' (the manual `uste.prepaid_vat`), or undefined when the caller did not resolve a
     * source (e.g. {@link aggregateUsteFromEuerTx} called directly). Display-only.
     */
    prepaidVatSource?: 'register' | 'config';
    /**
     * §13b Steuerschuldnerschaft des Leistungsempfängers (Kz 46/47/84/85/67 → E50 E3102205/E3102503/
     * E3006502/E3009502). Zahllastneutral (owed = deductible), but declared. Empty when no §13b.
     */
    reverseCharge?: ReverseChargeTotals;
    /** Foreign expenses that look like §13b but couldn't be booked cleanly (for a human check). */
    reverseChargeReview?: Array<{ id: string; label: string | null; reason: string }>;
}

/**
 * Build the annual UStE figures from the transaction-driven EÜR aggregate. `prepaidVat`
 * is the sum of the year's filed Voranmeldung-Zahllasten (0 if unknown).
 *
 * `entnahme` carries the Betriebsaufgabe assets whose withdrawal into private ownership is a
 * deemed supply (§3 Abs. 1b Nr. 1 UStG). This does NOT come from the EÜR aggregate: the
 * Aufgabegewinn is a §16-EStG figure that never touches the cash-basis Betriebseinnahmen, so
 * without this the UStE would silently omit the tax on the withdrawal.
 */
export function aggregateUsteFromEuerTx(agg: EuerTxAggregate, prepaidVat = 0, entnahme?: UsteEntnahme): UsteAggregate {
    let net19 = 0;
    let net7 = 0;
    let net0 = 0;
    // The Privatanteile ride in agg.income as a synthetic category, but the annual Vordruck wants
    // them on their own line (§3 Abs. 9a) — so pull them out of the plain-revenue bucket.
    let wertabgabeSonstige19 = 0;
    for (const c of agg.income) {
        const rate = impliedRate(c.category, c.kind);
        const is19 = Math.abs(rate - 0.19) < 0.01;
        if (is19 && c.category === PRIVATANTEIL_CATEGORY) wertabgabeSonstige19 += c.net;
        else if (is19) net19 += c.net;
        else if (Math.abs(rate - 0.07) < 0.01) net7 += c.net;
        else net0 += c.net;
    }

    const entnahmeAssets = (entnahme?.assets ?? []).filter((a) => a.gemeinerWert > 0);
    const wertabgabeLieferung19 = round2(entnahmeAssets.reduce((s, a) => s + a.gemeinerWert, 0));

    // The Entnahme is additional taxable revenue that the EÜR totals never saw → its USt has to be
    // added to the output VAT (and thus the Zahllast) explicitly.
    const entnahmeVat = round2(wertabgabeLieferung19 * 0.19);
    const vatOut = round2(agg.totals.outputVat + entnahmeVat);
    const vatPayable = round2(agg.totals.vatPayable + entnahmeVat);
    const prepaid = round2(prepaidVat);
    return {
        year: agg.year,
        net_19: round2(net19 + wertabgabeSonstige19 + wertabgabeLieferung19),
        lieferungenSonstLeistungen_19: round2(net19),
        wertabgabeLieferung_19: wertabgabeLieferung19,
        wertabgabeSonstige_19: round2(wertabgabeSonstige19),
        ...(entnahmeAssets.length ? { entnahmeAssets } : {}),
        net_7: round2(net7),
        net_0: round2(net0),
        vat_out: vatOut,
        vat_in: round2(agg.totals.inputVat),
        vatPayable,
        prepaidVat: prepaid,
        closingBalance: round2(vatPayable - prepaid),
        reverseCharge: agg.reverseCharge,
        reverseChargeReview: agg.reverseChargeReview,
    };
}

/**
 * One VAT line as the ANNUAL FORM states it: the Bemessungsgrundlage rounded DOWN to full euro plus
 * the tax DERIVED from that whole-euro base (not the summed per-receipt VAT).
 */
export interface UsteFormLine {
    /** Bemessungsgrundlage, rounded DOWN to full euro (as the form + Übertragungsprotokoll show it). */
    bmg: number;
    /** Steuer = bmg × rate — derived from the whole-euro BMG, exactly like the form. */
    tax: number;
    /** The applied VAT rate (0.19 / 0.07). */
    rate: number;
}

/**
 * The USt-Jahreserklärung figures the way the ANNUAL FORM computes them: every line's tax is derived
 * from the Bemessungsgrundlage ROUNDED DOWN to full euro, NOT from the summed per-receipt VAT. ELSTER
 * auto-computes Zeile 22/23/24/37 from the entered bases, but the §13b lines 65/67 are NOT auto-computed
 * — their tax must be entered by hand — so those are surfaced explicitly here. This is what the Prüfblatt
 * must show so it reconciles to the Übertragungsprotokoll to the cent.
 */
export interface UsteFormFigures {
    /** Zeile 22 — Lieferungen/sonstige Leistungen zu 19 % (without the Wertabgaben). */
    lieferungen19: UsteFormLine;
    /** Zeile 23 — unentgeltliche Wertabgabe §3 Abs. 1b (Betriebsaufgabe-Entnahme); only when > 0. */
    wertabgabeLieferung19?: UsteFormLine;
    /** Zeile 24 — unentgeltliche Wertabgabe §3 Abs. 9a (Privatanteil); only when > 0. */
    wertabgabeSonstige19?: UsteFormLine;
    /** Umsätze zum ermäßigten Steuersatz 7 %; only when > 0. */
    ermaessigt7?: UsteFormLine;
    /** Zeile 37 — Summe der Steuer auf steuerpflichtige Umsätze (19/7 %), from the rounded-down BMG. */
    steuerUmsaetze: number;
    /** Zeile 65 — §13b Abs. 1 (EU-Leistungen): rounded-down BMG + the tax derived from it; only when > 0. */
    reverseChargeAbs1?: UsteFormLine;
    /** Zeile 67 — §13b Abs. 2 (Drittland): rounded-down BMG + the tax derived from it; only when > 0. */
    reverseChargeAbs2?: UsteFormLine;
    /** Zeile 68 — Summe der vom Leistungsempfänger nach §13b geschuldeten Steuer (0 when no §13b). */
    steuer13b: number;
    /** Zeile 79 — abziehbare Vorsteuer from invoices (to the cent, NOT rounded down). */
    vorsteuer: number;
    /** Zeile 83 — Vorsteuer from §13b-Leistungen (= steuer13b, zahllastneutral). */
    vorsteuer13b: number;
    /** Zeile 87 — Summe der Vorsteuerbeträge. */
    vorsteuerSumme: number;
    /** Zeile 118 — verbleibende USt = the annual Zahllast as the form states it. */
    verbleibend: number;
    /** Zeile 119 — Vorauszahlungssoll (from the filings register, NOT the Finanzamt's amtliches Soll). */
    vorauszahlungssoll: number;
    /** Zeile 120 — Abschlusszahlung (positive) / Erstattung (negative). */
    abschluss: number;
    /** Where the Vorauszahlungssoll came from ('register' | 'config'), for the label. */
    prepaidVatSource?: 'register' | 'config';
}

/** Round a net base DOWN to full euro (round2 first to swallow sub-cent float noise). */
function floorEuroBmg(net: number): number {
    return Math.trunc(round2(net));
}

/** Snap an implied rate (tax/base) to the nearest German standard VAT rate (0.19 default, 0.07). */
function snapStandardRate(base: number, tax: number): number {
    if (base <= 0) return 0.19;
    return Math.abs(tax / base - 0.07) < 0.02 ? 0.07 : 0.19;
}

/** Build a {@link UsteFormLine} from a net base at a rate: BMG rounded down, tax derived from it. */
function formLine(net: number, rate: number): UsteFormLine {
    const bmg = floorEuroBmg(net);
    return { bmg, tax: round2(bmg * rate), rate };
}

/**
 * Recompute the UStE figures the way the ANNUAL FORM does — tax derived from the whole-euro (rounded
 * DOWN) Bemessungsgrundlage per rate, including the §13b lines whose tax ELSTER does not auto-compute.
 * Pure function of a {@link UsteAggregate}; used by the Prüfblatt (CLI report + PDF) so it reconciles to
 * the Übertragungsprotokoll. Does NOT touch the emitted XML (that has its own builder).
 */
export function computeUsteFormFigures(agg: UsteAggregate): UsteFormFigures {
    const lieferungen19 = formLine(agg.lieferungenSonstLeistungen_19, 0.19);
    const wertabgabeLieferung19 = agg.wertabgabeLieferung_19 ? formLine(agg.wertabgabeLieferung_19, 0.19) : undefined;
    const wertabgabeSonstige19 = agg.wertabgabeSonstige_19 ? formLine(agg.wertabgabeSonstige_19, 0.19) : undefined;
    const ermaessigt7 = agg.net_7 ? formLine(agg.net_7, 0.07) : undefined;
    const steuerUmsaetze = round2(
        lieferungen19.tax +
            (wertabgabeLieferung19?.tax ?? 0) +
            (wertabgabeSonstige19?.tax ?? 0) +
            (ermaessigt7?.tax ?? 0),
    );

    const rc = agg.reverseCharge;
    const showRc = rc != null && hasReverseCharge(rc);
    const reverseChargeAbs1 =
        showRc && rc.abs1Base ? formLine(rc.abs1Base, snapStandardRate(rc.abs1Base, rc.abs1Tax)) : undefined;
    const reverseChargeAbs2 =
        showRc && rc.abs2Base ? formLine(rc.abs2Base, snapStandardRate(rc.abs2Base, rc.abs2Tax)) : undefined;
    const steuer13b = round2((reverseChargeAbs1?.tax ?? 0) + (reverseChargeAbs2?.tax ?? 0));

    const vorsteuer = round2(agg.vat_in);
    // §13b is fully deductible for a business with full Vorsteuerabzug → the deductible equals the owed
    // tax (both derived from the same rounded BMG), keeping §13b a zahllastneutraler Nullsummenposten.
    const vorsteuer13b = steuer13b;
    const vorsteuerSumme = round2(vorsteuer + vorsteuer13b);

    const verbleibend = round2(steuerUmsaetze + steuer13b - vorsteuerSumme);
    const vorauszahlungssoll = round2(agg.prepaidVat);
    const abschluss = round2(verbleibend - vorauszahlungssoll);

    return {
        lieferungen19,
        ...(wertabgabeLieferung19 ? { wertabgabeLieferung19 } : {}),
        ...(wertabgabeSonstige19 ? { wertabgabeSonstige19 } : {}),
        ...(ermaessigt7 ? { ermaessigt7 } : {}),
        steuerUmsaetze,
        ...(reverseChargeAbs1 ? { reverseChargeAbs1 } : {}),
        ...(reverseChargeAbs2 ? { reverseChargeAbs2 } : {}),
        steuer13b,
        vorsteuer,
        vorsteuer13b,
        vorsteuerSumme,
        verbleibend,
        vorauszahlungssoll,
        abschluss,
        prepaidVatSource: agg.prepaidVatSource,
    };
}
