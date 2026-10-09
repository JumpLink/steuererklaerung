/**
 * Szenarien — the same financing at different sizes, side by side.
 *
 * The point is not to find "the" number but to see which lever moves the instalment
 * how far: the payout to the sellers and the renovation tranche are the two negotiable
 * positions, so the matrix varies exactly those and reports the instalment, the debt
 * left when the Zinsbindung ends, and whether the household carries it.
 *
 * Every row is compared against today's total monthly outflow, not against the bare
 * rent. Rent-vs-instalment is the comparison everyone reaches for and it is wrong in
 * both directions: utilities you already pay yourself do not become cheaper by owning
 * the house, and the running cost of ownership (Grundsteuer, Gebäudeversicherung,
 * Instandhaltung) is new. Only the netted change is a number worth showing a lender.
 */

import { tilgungsplan } from '@steuererklaerung/kredit';
import type { FinanzierungAngebot, FinanzierungConfig } from '../../config/schema/finanzierung.ts';
import { berechneBedarf, type BedarfErgebnis } from './bedarf.ts';
import { berechneHaushalt, type HaushaltsErgebnis } from './haushalt.ts';

/** One variant of the financing. */
export interface SzenarioVariante {
    label: string;
    /** Payout to the sellers in this variant. */
    auszahlungVerkaeufer: number;
    /** Renovation tranche in this variant. */
    sanierung: number;
    bedarf: BedarfErgebnis;
    /** Monthly instalment. */
    rate: number;
    /** Debt left when the Zinsbindung ends; `null` without a Zinsbindung. */
    restschuldNachBindung: number | null;
    /** Years to full repayment; `null` if not repaid within the simulated horizon. */
    laufzeitJahre: number | null;
    /** Total interest over the full term. */
    summeZins: number;
    /** True when the instalment fits the Ist-Rechnung's carrying capacity. */
    tragbar: boolean;
    /** True when it also fits the more conservative Bank-Sicht. */
    tragbarBankSicht: boolean;
    /**
     * Change in total monthly outflow: instalment PLUS the costs ownership adds, MINUS the
     * housing cost that falls away. Negative means genuinely cheaper than today.
     *
     * Comparing the bare instalment against the rent would flatter the deal — the running
     * cost of owning the building (Grundsteuer, Versicherung, Instandhaltung) does not
     * vanish just because it is not in the instalment.
     */
    differenzZuHeute: number;
}

/** The scenario comparison. */
export interface SzenarioErgebnis {
    /** The quote the variants were priced with. */
    angebot: FinanzierungAngebot;
    haushalt: HaushaltsErgebnis;
    /** Today's housing cost that the purchase makes go away (the rent). */
    wohnkostenHeute: number;
    /** Running cost of ownership that arrives with the purchase. */
    zusatzkostenNachKauf: number;
    varianten: SzenarioVariante[];
}

export interface SzenarioOptions {
    /**
     * Which quote to price with. Defaults to the first configured `angebote` entry;
     * required when none is configured.
     */
    angebot?: FinanzierungAngebot;
    /** Payout amounts to vary over. Defaults to the configured value plus two reductions. */
    auszahlungen?: number[];
    /** Renovation tranches to vary over. Defaults to full / half / none. */
    sanierungen?: number[];
}

function round(value: number): number {
    return Math.round(value * 1e2) / 1e2;
}

function eur(value: number): string {
    return `${Math.round(value / 1000)}k`;
}

/**
 * Build the scenario matrix.
 *
 * @param cfg The entity's whole `finanzierung` block.
 * @param options Which quote and which levers to vary; see {@link SzenarioOptions}.
 * @returns The comparison; see {@link SzenarioErgebnis}.
 * @throws If no quote is configured and none is passed.
 */
export function berechneSzenarien(cfg: FinanzierungConfig, options: SzenarioOptions = {}): SzenarioErgebnis {
    const angebot = options.angebot ?? cfg.angebote[0];
    if (!angebot) {
        throw new Error(
            'Kein Bankangebot konfiguriert (finanzierung.angebote) und keines übergeben — ' +
                'ohne Zins und Tilgung lässt sich keine Rate rechnen.',
        );
    }

    const haushalt = berechneHaushalt(cfg.haushalt);
    // Today's housing cost = exactly what the purchase makes go away.
    const wohnkostenHeute = round(haushalt.entfallend.reduce((sum, p) => sum + p.betragMonat, 0));
    // …against which the costs ownership adds must be netted.
    const zusatzkostenNachKauf = round(haushalt.hinzukommend.reduce((sum, p) => sum + p.betragMonat, 0));

    const auszahlungen = options.auszahlungen ?? defaultAuszahlungen(cfg.bedarf.auszahlung_verkaeufer);
    const sanierungen = options.sanierungen ?? defaultSanierungen(cfg.bedarf.sanierung);

    const varianten: SzenarioVariante[] = [];
    for (const auszahlung of auszahlungen) {
        for (const sanierung of sanierungen) {
            const bedarf = berechneBedarf(cfg.bedarf, {
                auszahlungVerkaeufer: auszahlung,
                sanierung,
            });
            const plan = tilgungsplan({
                betrag: bedarf.darlehensbedarf,
                sollzins: angebot.sollzins,
                tilgung: angebot.tilgung,
                zinsbindungJahre: angebot.zinsbindung_jahre,
                sondertilgungProJahr: angebot.sondertilgung_pro_jahr,
            });

            varianten.push({
                label: `Eltern ${eur(auszahlung)} · Sanierung ${eur(sanierung)}`,
                auszahlungVerkaeufer: auszahlung,
                sanierung,
                bedarf,
                rate: plan.rate,
                restschuldNachBindung: plan.restschuldNachBindung,
                laufzeitJahre: plan.laufzeitMonate === null ? null : round(plan.laufzeitMonate / 12),
                summeZins: plan.summeZins,
                tragbar: plan.rate <= haushalt.tragbareRate,
                tragbarBankSicht: plan.rate <= haushalt.tragbareRateBankSicht,
                differenzZuHeute: round(plan.rate + zusatzkostenNachKauf - wohnkostenHeute),
            });
        }
    }

    return { angebot, haushalt, wohnkostenHeute, zusatzkostenNachKauf, varianten };
}

/** Configured payout plus two reductions — the room a family sale usually has. */
function defaultAuszahlungen(konfiguriert: number): number[] {
    if (konfiguriert <= 0) return [0];
    const stufen = [konfiguriert, round(konfiguriert * 0.7), round(konfiguriert * 0.5)];
    return [...new Set(stufen)].sort((a, b) => b - a);
}

/** Full / half / none — renovation is the position that phases most easily. */
function defaultSanierungen(konfiguriert: number): number[] {
    if (konfiguriert <= 0) return [0];
    return [...new Set([konfiguriert, round(konfiguriert / 2), 0])].sort((a, b) => b - a);
}
