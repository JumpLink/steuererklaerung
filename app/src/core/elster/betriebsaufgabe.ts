/**
 * Betriebsaufgabe — Aufgabegewinn/-verlust (§16/§34 EStG).
 *
 * On giving up the business, the remaining Betriebsvermögen is transferred to the
 * partners' private assets at the *gemeiner Wert* (fair value). The Aufgabegewinn is
 * Σ(gemeiner Wert − Restbuchwert) over the assets, less Aufgabekosten. It is a SEPARATE
 * component of the Einkünfte aus Gewerbebetrieb from the laufender Gewinn (and, for
 * natural-person partners, NOT subject to Gewerbesteuer — §7 Satz 2 GewStG).
 *
 * The gemeine Werte are a tax judgement (what each asset would realistically fetch /
 * whether non-removable Einbauten are simply given up → gemeiner Wert 0 = Aufgabeverlust),
 * so they are supplied per asset from config; an asset without an explicit value defaults
 * to its Restbuchwert (a neutral 0-gain ansatz).
 */

import { round2 } from '../lib/money.ts';

/** An asset's contribution to the Aufgabegewinn (gemeiner Wert vs. Restbuchwert at Aufgabe). */
export interface AufgabeAsset {
    id: string;
    bezeichnung: string;
    /** Restbuchwert at the Aufgabe date (carried from the AfA computation). */
    restbuchwert: number;
    /** Gemeiner Wert at withdrawal (config; defaults to restbuchwert ⇒ 0 gain). */
    gemeinerWert: number;
    /** gemeinerWert − restbuchwert (negative = Aufgabeverlust on this asset). */
    gewinn: number;
}

export interface AufgabegewinnResult {
    /** Aufgabe date (YYYY-MM-DD). */
    datum: string;
    assets: AufgabeAsset[];
    /** Σ of the per-asset gains (the Entnahmegewinn of the Anlagevermögen). */
    entnahmegewinn: number;
    aufgabekosten: number;
    /** entnahmegewinn − aufgabekosten (negative = Aufgabeverlust). */
    aufgabegewinn: number;
}

export interface AfaAssetBookValue {
    id: string;
    bezeichnung: string;
    restbuchwertEnde: number;
}

/**
 * Compute the Aufgabegewinn from the assets' Restbuchwerte at Aufgabe and their gemeine
 * Werte. `gemeineWerte` maps an asset id to its gemeiner Wert; a missing id defaults to
 * the Restbuchwert (no gain/loss on that asset).
 */
export function computeAufgabegewinn(
    afaAssets: AfaAssetBookValue[],
    gemeineWerte: Record<string, number>,
    aufgabekosten = 0,
    datum = '',
): AufgabegewinnResult {
    const assets: AufgabeAsset[] = afaAssets.map((a) => {
        const restbuchwert = round2(a.restbuchwertEnde);
        const gemeinerWert = round2(gemeineWerte[a.id] ?? restbuchwert);
        return {
            id: a.id,
            bezeichnung: a.bezeichnung,
            restbuchwert,
            gemeinerWert,
            gewinn: round2(gemeinerWert - restbuchwert),
        };
    });
    const entnahmegewinn = round2(assets.reduce((s, a) => s + a.gewinn, 0));
    const kosten = round2(aufgabekosten);
    return { datum, assets, entnahmegewinn, aufgabekosten: kosten, aufgabegewinn: round2(entnahmegewinn - kosten) };
}
