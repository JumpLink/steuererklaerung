/**
 * §32a EStG Einkommensteuertarif (Grundtabelle) + the private-ESt constants, keyed per
 * assessment year (Veranlagungszeitraum).
 *
 * EVERY number here is tax law that changes yearly — each is sourced in
 * `docs/references/tax-sources.md` (Prüf-Reihenfolge: gesetze-im-internet → amtliches
 * BMF-Handbuch → seriöser Spiegel). Do NOT edit a value without updating that registry
 * (Quelle + Abrufdatum + VZ). The app's output is a *Schätzung*; the binding assessment is the
 * Steuerbescheid, validated via ELSTER/ERiC.
 *
 * See: docs/references/tax-sources.md § "§32a EStG — Einkommensteuertarif" and
 *      § "Private ESt — Pauschbeträge, §35a, Vorsorge, Annexsteuern (VZ 2025)".
 */

export type Veranlagung = 'einzel' | 'splitting';

/** §32a zone coefficients for one assessment year. `zone4Upper` (277.825) is the same for
 *  2025 and 2026 but kept per-year so a future change can't silently mis-apply. */
interface TarifYear {
    grundfreibetrag: number; // Zone 1 upper — ESt = 0 up to and including this zvE
    zone2Upper: number;
    zone2A: number; // Zone 2: (zone2A·y + zone2B)·y, y = (zvE − grundfreibetrag)/10000
    zone2B: number;
    zone3Upper: number;
    zone3C: number; // Zone 3: (zone3C·z + zone3D)·z + zone3E, z = (zvE − zone2Upper)/10000
    zone3D: number;
    zone3E: number;
    zone4Upper: number;
    zone4Sub: number; // Zone 4: 0,42·zvE − zone4Sub
    zone5Sub: number; // Zone 5: 0,45·zvE − zone5Sub
}

/** §32a per VZ — verbatim from docs/references/tax-sources.md § "§32a EStG". */
const TARIF: Record<number, TarifYear> = {
    2025: {
        grundfreibetrag: 12096,
        zone2Upper: 17443,
        zone2A: 932.3,
        zone2B: 1400,
        zone3Upper: 68480,
        zone3C: 176.64,
        zone3D: 2397,
        zone3E: 1015.13,
        zone4Upper: 277825,
        zone4Sub: 10911.92,
        zone5Sub: 19246.67,
    },
    2026: {
        grundfreibetrag: 12348,
        zone2Upper: 17799,
        zone2A: 914.51,
        zone2B: 1400,
        zone3Upper: 69878,
        zone3C: 173.1,
        zone3D: 2397,
        zone3E: 1034.87,
        zone4Upper: 277825,
        zone4Sub: 11135.63,
        zone5Sub: 19470.38,
    },
};

function tarifYear(year: number): TarifYear {
    const t = TARIF[year];
    if (!t) {
        throw new Error(
            `Kein Einkommensteuertarif für VZ ${year} hinterlegt — in docs/references/tax-sources.md ergänzen.`,
        );
    }
    return t;
}

/** Raw §32a on an ALREADY-floored zvE. Returns the un-rounded tarif; callers round. */
function tarifRaw(zvE: number, t: TarifYear): number {
    if (zvE <= t.grundfreibetrag) return 0;
    if (zvE <= t.zone2Upper) {
        const y = (zvE - t.grundfreibetrag) / 10000;
        return (t.zone2A * y + t.zone2B) * y;
    }
    if (zvE <= t.zone3Upper) {
        const z = (zvE - t.zone2Upper) / 10000;
        return (t.zone3C * z + t.zone3D) * z + t.zone3E;
    }
    if (zvE <= t.zone4Upper) return 0.42 * zvE - t.zone4Sub;
    return 0.45 * zvE - t.zone5Sub;
}

/** §32a Grundtarif (Einzelveranlagung): tarifliche ESt, rounded down to whole €. */
export function estTarif(zvE: number, year: number): number {
    const t = tarifYear(year);
    return Math.floor(tarifRaw(Math.floor(zvE), t));
}

/**
 * §32a Splittingtarif (Zusammenveranlagung): 2 × Tarif(zvE/2). zvE is rounded down to whole €
 * ONCE, then halved (the half may carry ,50 €), the formula is applied, doubled, and rounded
 * down ONLY THEN.
 */
export function estTarifSplitting(zvE: number, year: number): number {
    const t = tarifYear(year);
    const half = Math.floor(zvE) / 2;
    return Math.floor(2 * tarifRaw(half, t));
}

/** Grundtarif or Splittingtarif, per Veranlagungsart. */
export function estTarifBy(zvE: number, year: number, veranlagung: Veranlagung): number {
    return veranlagung === 'splitting' ? estTarifSplitting(zvE, year) : estTarif(zvE, year);
}

/**
 * §32b Progressionsvorbehalt — besonderer Steuersatz. The Leistungen subject to the
 * Progressionsvorbehalt (Einkommensersatzleistungen minus repaid amounts = `progressionseinkuenfte`,
 * MAY BE NEGATIVE) are added to the zvE only to determine the RATE; the average rate found that way
 * is applied to the unchanged zvE. A negative amount (e.g. an Elterngeld repayment) lowers the rate
 * → less tax (negativer Progressionsvorbehalt).
 * The rate is rounded to 4 decimal places of the percentage (as in the official Ablaufplan; cf. the
 * Steuersatz shown on the Bescheid). Only the Steuerbescheid is binding.
 */
export function estTarifProgression(
    zvE: number,
    progressionseinkuenfte: number,
    veranlagung: Veranlagung,
    year: number,
): number {
    if (progressionseinkuenfte === 0) return estTarifBy(zvE, year, veranlagung);
    const satzBasis = Math.floor(zvE) + progressionseinkuenfte;
    if (satzBasis <= 0) return 0;
    const satz = Math.round((estTarifBy(satzBasis, year, veranlagung) / satzBasis) * 1e6) / 1e6;
    return Math.floor(Math.floor(zvE) * satz);
}

/** The per-VZ private-ESt constants (Pauschbeträge, §35a-Deckel, Vorsorge-Höchstbeträge, Soli). */
export interface EstConstants {
    /** Arbeitnehmer-Pauschbetrag (§9a S. 1 Nr. 1a). */
    arbeitnehmerPauschbetrag: number;
    /** Homeoffice-Tagespauschale (§4 Abs. 5 S. 1 Nr. 6c). */
    homeoffice: { proTag: number; maxTage: number; max: number };
    /** Entfernungspauschale (§9 Abs. 1 S. 3 Nr. 4), one-way distance. */
    entfernung: { satzBis20: number; satzAb21: number };
    /** Sonderausgaben-Pauschbetrag for non-Vorsorge items (§10c). */
    sonderausgabenPauschbetrag: number;
    /** Sparer-Pauschbetrag (§20 Abs. 9) — in Phase 1 a note only. */
    sparerPauschbetrag: number;
    /** Spenden-Höchstbetrag as a share of the Gesamtbetrag der Einkünfte (§10b Abs. 1). */
    spendenAnteilGdE: number;
    /** §35a — Satz + Höchstbeträge per category (Ermäßigung on the tarifliche ESt). */
    par35a: { satz: number; maxHandwerker: number; maxHaushaltsnah: number; maxMinijob: number };
    /** Schulgeld (§10 Abs. 1 Nr. 9): share deductible, capped per child. */
    schulgeld: { satz: number; maxProKind: number };
    /** Kinderbetreuungskosten (§10 Abs. 1 Nr. 5): share deductible, capped per child. */
    kinderbetreuung: { satz: number; maxProKind: number };
    /** Parteizuwendungen (§34g): Ermäßigung = `satz` of the Zuwendungen up to `maxBeguenstigt` per person. */
    par34g: { satz: number; maxBeguenstigt: number };
    /** Entlastungsbetrag für Alleinerziehende (§24b): Grundbetrag (first child) + increase per
     *  further child; pro rata 1/12 for each calendar month in which the conditions were met. */
    entlastungAlleinerziehende: { grundbetrag: number; jeWeiteremKind: number };
    /**
     * Vorsorge-Höchstbeträge (§10 Abs. 3/4), Einzelveranlagung, plus the Krankengeld-Abschlag.
     * `kvKrankengeldAbschlag` = §10 Abs. 1 Nr. 3 Satz 4 EStG: 4 % cut of the statutory
     * Basis-KV-Beiträge when there is an Anspruch auf Krankengeld (the contribution share
     * attributable to the Krankengeld is not privileged as Basisvorsorge). Statutory, not year-dependent.
     */
    vorsorge: {
        altersvorsorgeHoechstbetrag: number;
        sonstigeMitZuschuss: number;
        sonstigeOhneZuschuss: number;
        kvKrankengeldAbschlag: number;
    };
    /** Solidaritätszuschlag (§3/§4 SolZG). */
    soli: { freigrenzeEinzel: number; freigrenzeSplitting: number; milderungssatz: number; satz: number };
    /**
     * Zumutbare Belastung (§33 Abs. 3) — stufenweise (BFH VI R 75/14). `grenze1`/`grenze2` bound
     * the three GdE bands; each `[band1, band2, band3]` triple is the per-band percentage for one
     * Personenkreis, applied only to the GdE slice inside its band.
     */
    zumutbareBelastung: {
        grenze1: number;
        grenze2: number;
        ohneKinderGrundtarif: [number, number, number];
        ohneKinderSplitting: [number, number, number];
        einBisZweiKinder: [number, number, number];
        dreiPlusKinder: [number, number, number];
    };
}

/** Private-ESt constants per VZ — verbatim from docs/references/tax-sources.md § "Private ESt …". */
const CONSTANTS: Record<number, EstConstants> = {
    2025: {
        arbeitnehmerPauschbetrag: 1230,
        homeoffice: { proTag: 6, maxTage: 210, max: 1260 },
        entfernung: { satzBis20: 0.3, satzAb21: 0.38 },
        sonderausgabenPauschbetrag: 36,
        sparerPauschbetrag: 1000,
        spendenAnteilGdE: 0.2,
        par35a: { satz: 0.2, maxHandwerker: 1200, maxHaushaltsnah: 4000, maxMinijob: 510 },
        schulgeld: { satz: 0.3, maxProKind: 5000 },
        // From VZ 2025: 80 % instead of 2/3, Höchstbetrag 4.800 € instead of 4.000 € per child (§10 Abs. 1
        // Nr. 5 EStG as amended by the JStG 2024 — gesetze-im-internet.de, retrieved 2026-07-15).
        kinderbetreuung: { satz: 0.8, maxProKind: 4800 },
        par34g: { satz: 0.5, maxBeguenstigt: 1650 },
        // §24b as amended since VZ 2023: Grundbetrag 4.260 € (first child) + 240 € per further child.
        entlastungAlleinerziehende: { grundbetrag: 4260, jeWeiteremKind: 240 },
        vorsorge: {
            altersvorsorgeHoechstbetrag: 29344,
            sonstigeMitZuschuss: 1900,
            sonstigeOhneZuschuss: 2800,
            kvKrankengeldAbschlag: 0.04,
        },
        soli: { freigrenzeEinzel: 19950, freigrenzeSplitting: 39900, milderungssatz: 0.119, satz: 0.055 },
        // §33 Abs. 3 Staffel — verbatim from docs/references/tax-sources.md § "Zumutbare Belastung".
        zumutbareBelastung: {
            grenze1: 15340,
            grenze2: 51130,
            ohneKinderGrundtarif: [0.05, 0.06, 0.07],
            ohneKinderSplitting: [0.04, 0.05, 0.06],
            einBisZweiKinder: [0.02, 0.03, 0.04],
            dreiPlusKinder: [0.01, 0.01, 0.02],
        },
    },
    2026: {
        // Unchanged from VZ 2025 (statutory, stable since 2023) — §9a S. 1 Nr. 1a.
        arbeitnehmerPauschbetrag: 1230,
        // Unchanged from VZ 2025 (statutory) — §4 Abs. 5 S. 1 Nr. 6c: 6 €/day, max. 210 days.
        homeoffice: { proTag: 6, maxTage: 210, max: 1260 },
        // CHANGED as of VZ 2026: a flat 0,38 €/km FROM THE 1st km (the 0,30 € band for the
        // first 20 km is gone) — Steueränderungsgesetz 2025 (Bundesrat 19.12.2025, BGBl.),
        // §9 Abs. 1 S. 3 Nr. 4 EStG. Both rates set to 0,38 → the band formula yields 0,38 · km.
        entfernung: { satzBis20: 0.38, satzAb21: 0.38 },
        // Unchanged from VZ 2025 (statutory) — §10c.
        sonderausgabenPauschbetrag: 36,
        // Unchanged from VZ 2025 (statutory, stable since 2023) — §20 Abs. 9.
        sparerPauschbetrag: 1000,
        // Unchanged from VZ 2025 (statutory) — §10b Abs. 1.
        spendenAnteilGdE: 0.2,
        // Unchanged from VZ 2025 (statutory) — §35a Abs. 1/2/3.
        par35a: { satz: 0.2, maxHandwerker: 1200, maxHaushaltsnah: 4000, maxMinijob: 510 },
        // Unchanged from VZ 2025 (statutory) — §10 Abs. 1 Nr. 9.
        schulgeld: { satz: 0.3, maxProKind: 5000 },
        // Unchanged from VZ 2025 (statutory, 80 % / 4.800 € since VZ 2025) — §10 Abs. 1 Nr. 5.
        kinderbetreuung: { satz: 0.8, maxProKind: 4800 },
        // Unchanged from VZ 2025 (statutory) — §34g.
        par34g: { satz: 0.5, maxBeguenstigt: 1650 },
        // Unchanged from VZ 2025 (statutory, since VZ 2023) — §24b: 4.260 € + 240 €/further child.
        entlastungAlleinerziehende: { grundbetrag: 4260, jeWeiteremKind: 240 },
        vorsorge: {
            // CHANGED as of VZ 2026: highest contribution to the knappschaftliche RV, rounded up — BBG
            // knappschaftlich 2026 = 124.800 €/year (SVBezGrV 2026) × 24,7 % = 30.825,60 € → 30.826 €.
            altersvorsorgeHoechstbetrag: 30826,
            // Unchanged from VZ 2025 (statutory) — §10 Abs. 4.
            sonstigeMitZuschuss: 1900,
            sonstigeOhneZuschuss: 2800,
            // Statutory, not year-dependent — §10 Abs. 1 Nr. 3 S. 4.
            kvKrankengeldAbschlag: 0.04,
        },
        // CHANGED as of VZ 2026: Soli-Freigrenze 20.350 € (Einzel) / 40.700 € (Splitting) — §3 Abs. 3
        // SolZG (current version). Milderungssatz 11,9 % / Satz 5,5 % unchanged (statutory).
        soli: { freigrenzeEinzel: 20350, freigrenzeSplitting: 40700, milderungssatz: 0.119, satz: 0.055 },
        // §33 Abs. 3 Staffel — statutory, unchanged from VZ 2025 (BFH VI R 75/14).
        zumutbareBelastung: {
            grenze1: 15340,
            grenze2: 51130,
            ohneKinderGrundtarif: [0.05, 0.06, 0.07],
            ohneKinderSplitting: [0.04, 0.05, 0.06],
            einBisZweiKinder: [0.02, 0.03, 0.04],
            dreiPlusKinder: [0.01, 0.01, 0.02],
        },
    },
};

/** Whether both the §32a tariff and the private-ESt constants are sourced for a year (else the
 *  estimate can't run — the plan shows a blocked step rather than throwing). */
export function estYearAvailable(year: number): boolean {
    return TARIF[year] != null && CONSTANTS[year] != null;
}

export function estConstants(year: number): EstConstants {
    const c = CONSTANTS[year];
    if (!c) {
        throw new Error(
            `Keine privaten ESt-Konstanten für VZ ${year} hinterlegt — in docs/references/tax-sources.md ergänzen.`,
        );
    }
    return c;
}

/**
 * Solidaritätszuschlag on the festzusetzende ESt: 0 below the Freigrenze, capped in the
 * Milderungszone at `milderungssatz` × (ESt − Freigrenze), above that `satz` × ESt.
 */
export function soliOnEst(festzusetzendeEst: number, veranlagung: Veranlagung, year: number): number {
    const c = estConstants(year);
    const freigrenze = veranlagung === 'splitting' ? c.soli.freigrenzeSplitting : c.soli.freigrenzeEinzel;
    if (festzusetzendeEst <= freigrenze) return 0;
    const voll = festzusetzendeEst * c.soli.satz;
    const milderung = (festzusetzendeEst - freigrenze) * c.soli.milderungssatz;
    return Math.round(Math.min(voll, milderung) * 100) / 100;
}

/**
 * Zumutbare Belastung (§33 Abs. 3) on the Gesamtbetrag der Einkünfte, determined **stufenweise**
 * (BFH VI R 75/14): each band percentage applies only to the GdE share falling into that band.
 * `kinder` = number of children with Kinderfreibetrag/Kindergeld; `veranlagung` picks the childless
 * Grund-/Splitting column as soon as `kinder === 0`.
 */
export function zumutbareBelastung(gde: number, veranlagung: Veranlagung, kinder: number, year: number): number {
    const z = estConstants(year).zumutbareBelastung;
    const rates =
        kinder >= 3
            ? z.dreiPlusKinder
            : kinder >= 1
              ? z.einBisZweiKinder
              : veranlagung === 'splitting'
                ? z.ohneKinderSplitting
                : z.ohneKinderGrundtarif;
    const band1 = Math.min(gde, z.grenze1) * rates[0];
    const band2 = Math.max(0, Math.min(gde, z.grenze2) - z.grenze1) * rates[1];
    const band3 = Math.max(0, gde - z.grenze2) * rates[2];
    return Math.round((band1 + band2 + band3) * 100) / 100;
}
