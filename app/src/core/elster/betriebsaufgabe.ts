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
 *
 * An asset a partner takes into their own Betriebsvermögen is no Entnahme but a Realteilung
 * (§16 Abs. 3 S. 2 EStG): the Buchwert is mandatory, so it adds nothing to the Aufgabegewinn.
 * Its gemeiner Wert is still kept — it is the Entgelt of the Lieferung for the UStE and the
 * value that applies retroactively if the Sperrfrist (§16 Abs. 3 S. 3) is broken.
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
    /** gemeinerWert − restbuchwert (negative = Aufgabeverlust on this asset); 0 on a Realteilung. */
    gewinn: number;
    /** Partner who took it over (`gesellschafter[].id`), if recorded. */
    uebernehmer?: string;
    /** Carried at Buchwert into the Übernehmer's Betriebsvermögen (§16 Abs. 3 S. 2 EStG). */
    realteilung?: boolean;
}

/** How one asset — or one part of a split asset — leaves the business. */
export interface AufgabeAnsatz {
    gemeinerWert: number;
    /** Share of the Restbuchwert (the parts of one asset sum to 1); defaults to the whole. */
    anteil?: number;
    bezeichnung?: string;
    uebernehmer?: string;
    realteilung?: boolean;
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
 * Werte. `gemeineWerte` maps an asset id to its gemeiner Wert, or to the parts it was split
 * into; a missing id defaults to the Restbuchwert (no gain/loss on that asset).
 */
export function computeAufgabegewinn(
    afaAssets: AfaAssetBookValue[],
    gemeineWerte: Record<string, number | AufgabeAnsatz[]>,
    aufgabekosten = 0,
    datum = '',
): AufgabegewinnResult {
    const assets: AufgabeAsset[] = afaAssets.flatMap((a) => {
        const restbuchwert = round2(a.restbuchwertEnde);
        const wert = gemeineWerte[a.id];
        const teile: AufgabeAnsatz[] =
            wert === undefined
                ? [{ gemeinerWert: restbuchwert }]
                : typeof wert === 'number'
                  ? [{ gemeinerWert: wert }]
                  : wert;
        const anteile = teile.map((t) => t.anteil ?? (teile.length === 1 ? 1 : 0));
        const summe = anteile.reduce((s, x) => s + x, 0);
        if (Math.abs(summe - 1) > 1e-6) {
            throw new Error(`Betriebsaufgabe: die Anteile von ${a.id} ergeben ${summe}, nicht 1`);
        }
        // The last part takes the cent remainder, so the parts' Restbuchwerte sum to the asset's.
        let rest = restbuchwert;
        return teile.map((t, i): AufgabeAsset => {
            const rbw = i === teile.length - 1 ? round2(rest) : round2(restbuchwert * anteile[i]);
            rest -= rbw;
            const gemeinerWert = round2(t.gemeinerWert);
            return {
                id: a.id,
                bezeichnung: t.bezeichnung ?? a.bezeichnung,
                restbuchwert: rbw,
                gemeinerWert,
                gewinn: t.realteilung ? 0 : round2(gemeinerWert - rbw),
                ...(t.uebernehmer ? { uebernehmer: t.uebernehmer } : {}),
                ...(t.realteilung ? { realteilung: true } : {}),
            };
        });
    });
    const entnahmegewinn = round2(assets.reduce((s, a) => s + a.gewinn, 0));
    const kosten = round2(aufgabekosten);
    return { datum, assets, entnahmegewinn, aufgabekosten: kosten, aufgabegewinn: round2(entnahmegewinn - kosten) };
}
