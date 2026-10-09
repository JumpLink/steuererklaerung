/**
 * Private Einkommensteuer (ESt) — the calculation kernel.
 *
 * One pure function {@link computeEst} implements the full VZ-2025 assessment waterfall for an
 * Arbeitnehmer:in (Einkünfte §19), Einzel- or Zusammenveranlagung, with a complete audit trace so
 * every front-end can render each intermediate. Optional Einkünfte aus Gewerbebetrieb
 * (Einzelunternehmen) fold into the Summe der Einkünfte for the studio's real case.
 *
 * The order of operations is legally load-bearing (see docs/references/tax-sources.md and the
 * Fable-5-reviewed plan): deductions reduce the **zvE** (worth the marginal rate); §35a reduces the
 * **tarifliche ESt** directly (worth 100 % up to its cap, non-refundable, no carry-forward — the
 * forfeited part is reported); Lohnsteuer/Soli/KiSt withheld are **prepayments**, settled per tax
 * type at the end. The Vorsorgepauschale (§39b, LSt-Abzug only) is deliberately NOT used.
 *
 * EVERYTHING here is a *Schätzung* — the binding figure is the Steuerbescheid. Constants live in
 * {@link estConstants} (est-tarif.ts), each sourced in docs/references/tax-sources.md.
 *
 * {@link estThemeImpacts} derives the Finanzguru-style "what each deduction is worth" by
 * counterfactual: re-run the whole calc with one theme removed and diff the refund — exact, no
 * marginal-rate approximation.
 */

import { round2 } from '../lib/money.ts';
import {
    type EstConstants,
    type Veranlagung,
    estConstants,
    estTarifBy,
    estTarifProgression,
    soliOnEst,
    zumutbareBelastung,
} from './est-tarif.ts';

/** One Werbungskosten line item (Arbeitsmittel, Fortbildung, Fachliteratur …). */
export interface EstWerbungskostenPosten {
    bezeichnung: string;
    betrag: number;
    /** Where it came from — a classified bank transaction or a manual config entry. */
    quelle: 'transaktion' | 'manuell';
}

/** All facts needed to estimate one person's ESt for one year. Amounts in EUR. */
export interface EstInputs {
    year: number;
    veranlagung: Veranlagung;
    /** Children with Kinderfreibetrag/Kindergeld — drives the zumutbare-Belastung column. Default 0. */
    kinder?: number;
    /** Kirchensteuersatz: 0 (not kirchensteuerpflichtig) · 0,08 (BY/BW) · 0,09 (all others). Default 0. */
    kirchensteuersatz?: number;

    /** Bruttoarbeitslohn (Lohnsteuerbescheinigung line 3). */
    bruttoarbeitslohn: number;
    /** Optional Einkünfte aus Gewerbebetrieb (Einzelunternehmen, EÜR-Gewinn) — folded into GdE. */
    einkuenfteGewerbe?: number;
    /** Shares from gesondert festgestellte Beteiligungen (e.g. a GbR share per Feststellungs-
     *  bescheid), sum of the festgestellte Beträge — folded into the GdE with `einkuenfteGewerbe`, but
     *  kept SEPARATE: the E10 (Anlage G) reports the Einzelunternehmen profit (E0800302) and the
     *  Ges_Fest-Beteiligungen (E0800504) on separate lines, the XML must not add them together. */
    einkuenfteGewerbeBeteiligungen?: number;
    /** Benefits subject to the Progressionsvorbehalt (§32b): Einkommensersatzleistungen
     *  (Arbeitslosen-/Eltern-/Kranken-/Mutterschaftsgeld …) MINUS amounts repaid. Net, and MAY BE
     *  NEGATIVE (the repayment outweighs) → lowers the tax rate. Does NOT change the zvE, only the
     *  average tax rate applied to the zvE. */
    progressionseinkuenfte?: number;
    /** §24b Entlastungsbetrag für Alleinerziehende: `monate` = calendar months in which the
     *  conditions were met (1/12 each), `weitereKinder` = children in the household BEYOND the first
     *  (each an Erhöhungsbetrag). Reduces the Summe der Einkünfte to the GdE. Absent = 0. */
    entlastungAlleinerziehende?: { monate: number; weitereKinder: number };

    /** Vorauszahlungen withheld/paid (Lohnsteuerbescheinigung + ESt-Vorauszahlungen). */
    einbehalten: {
        lohnsteuer: number;
        soli: number;
        kirchensteuer: number;
        /** ESt-Vorauszahlungen actually paid (Gewerbetreibende); default 0. */
        estVorauszahlung?: number;
    };

    /** Werbungskosten (Anlage N) — the Arbeitnehmer-Pauschbetrag applies if higher. */
    werbungskosten: {
        homeofficeTage: number;
        /** Commuting days + one-way distance (km) for the Entfernungspauschale. */
        pendel?: { tage: number; kmEinfach: number };
        posten: EstWerbungskostenPosten[];
    };

    /** Vorsorgeaufwendungen (Anlage Vorsorgeaufwand). */
    vorsorge: {
        /** Employee share of the gesetzliche RV / Basisrente. */
        rvArbeitnehmer: number;
        /** Tax-free employer share of the RV — subtracted from the deductible amount. */
        rvArbeitgeberSteuerfrei: number;
        /** Basis-Krankenversicherung (§10 Abs. 1 Nr. 3a) — deductible without limit. */
        kvBasis: number;
        /** Pflegeversicherung — deductible without limit. */
        pvBasis: number;
        /** Further sonstige Vorsorge (Haftpflicht, Unfall, Zusatz-KV …) — capped. */
        sonstige: number;
        /** Employee with a tax-free AG-Zuschuss → Höchstbetrag 1.900 € instead of 2.800 €. */
        hatAgZuschuss: boolean;
    };

    /** Sonderausgaben other than Vorsorge. */
    sonderausgaben: {
        spenden: number;
        /** Kirchensteuer paid during the year (§10 Abs. 1 Nr. 4) — a Sonderausgabe. */
        gezahlteKirchensteuer: number;
        /** Schulgeld paid (§10 Abs. 1 Nr. 9) — 30 % deductible, max 5.000 €/Kind. Default 0. */
        schulgeld?: number;
        /** Kinderbetreuungskosten (§10 Abs. 1 Nr. 5) — from VZ 2025 80 % deductible, max 4.800 €/Kind. Default 0. */
        kinderbetreuung?: number;
        /** Schulgeld per child (from the Anlage-Kind config) — when set, the Höchstbetrag applies
         *  PER CHILD instead of flat `maxProKind × kinder`; the sum must match `schulgeld`. */
        schulgeldJeKind?: number[];
        /** Kinderbetreuungskosten per child — the same per-child capping. */
        kinderbetreuungJeKind?: number[];
    };

    /** Außergewöhnliche Belastungen (general, §33). */
    agb: { krankheitskosten: number };

    /** §35a — only the begünstigte amounts (labour costs, no material costs), paid non-cash. */
    par35a: { handwerkerArbeitskosten: number; haushaltsnah: number; minijob: number };

    /** §34g — contributions to political parties (Beiträge + Spenden). 50 % Steuerermäßigung. Default 0. */
    par34g?: { parteibeitrag: number };
}

/** Werbungskosten breakdown + which figure was applied. */
export interface EstWerbungskosten {
    entfernungspauschale: number;
    homeofficePauschale: number;
    postenSumme: number;
    tatsaechlich: number;
    pauschbetrag: number;
    /** max(tatsaechlich, pauschbetrag). */
    angesetzt: number;
    /** true when the Arbeitnehmer-Pauschbetrag won (no individual proof needed). */
    pauschbetragGewonnen: boolean;
}

/** Vorsorgeaufwendungen breakdown after the §10 Abs. 3/4 Höchstbetrags-Kappungen. */
export interface EstVorsorge {
    altersvorsorgeBeitraege: number;
    altersvorsorgeHoechstbetrag: number;
    altersvorsorgeAbziehbar: number;
    basisKvPv: number;
    sonstigeCap: number;
    sonstigeAbziehbar: number;
    abziehbar: number;
}

/** §35a Ermäßigung: computed vs. actually credited (capped at tarifliche ESt) vs. forfeited. */
export interface EstErmaessigung35a {
    berechnet: number;
    angesetzt: number;
    verfallen: number;
}

/** §34g Ermäßigung for Parteizuwendungen: begünstigt (up to the Höchstbetrag), berechnet, angesetzt. */
export interface EstErmaessigung34g {
    /** Zuwendungen up to the §34g-Höchstbetrag (the remainder may be a §10b-Spende). */
    beguenstigt: number;
    berechnet: number;
    angesetzt: number;
}

/** Settlement per tax type (positive = Erstattung, negative = Nachzahlung). */
export interface EstAbrechnungPosten {
    soll: number;
    einbehalten: number;
    erstattung: number;
}

/** The full assessment result — every intermediate, plus the signed refund and hints. */
export interface EstResult {
    year: number;
    veranlagung: Veranlagung;
    bruttoarbeitslohn: number;
    einkuenfteGewerbe: number;
    werbungskosten: EstWerbungskosten;
    einkuenfte19: number;
    /** §24b Entlastungsbetrag für Alleinerziehende — reduces the Summe der Einkünfte to the GdE. 0 = no claim. */
    entlastungAlleinerziehende: number;
    /** Gesamtbetrag der Einkünfte = Summe der Einkünfte (§19 + Gewerbe) − §24b-Entlastungsbetrag. */
    gesamtbetragEinkuenfte: number;
    vorsorge: EstVorsorge;
    sonderausgaben: {
        vorsorgeAbziehbar: number;
        kirchensteuer: number;
        spenden: number;
        spendenHoechstbetrag: number;
        /** Deductible share of the Schulgeld (§10 Nr. 9): 30 %, max 5.000 €/Kind. */
        schulgeld: number;
        /** Deductible Kinderbetreuungskosten (§10 Nr. 5): 2/3, max 4.000 €/Kind. */
        kinderbetreuung: number;
        nichtVorsorgeAngesetzt: number;
        nichtVorsorgePauschbetrag: number;
        gesamt: number;
    };
    agb: { krankheitskosten: number; zumutbareBelastung: number; abziehbar: number; geschluckt: number };
    zvE: number;
    /** §32b: the benefits subject to the Progressionsvorbehalt (net, signed) that changed the rate
     *  of the tarifliche ESt. 0 = no Progressionsvorbehalt. */
    progressionseinkuenfte: number;
    tariflicheESt: number;
    ermaessigung35a: EstErmaessigung35a;
    /** §34g-Ermäßigung for Parteizuwendungen (reduces the tarifliche ESt before §35a). */
    ermaessigung34g: EstErmaessigung34g;
    festzusetzendeESt: number;
    abrechnung: { est: EstAbrechnungPosten; soli: EstAbrechnungPosten; kirchensteuer: EstAbrechnungPosten };
    /** Signed total: positive = Erstattung, negative = Nachzahlung. */
    erstattung: number;
    hinweise: string[];
}

/** Entfernungspauschale (one-way distance): 0,30 €/km up to 20 km, 0,38 €/km from the 21st km on. */
function entfernungspauschale(tage: number, kmEinfach: number, c: EstConstants): number {
    const km = Math.max(0, kmEinfach);
    const proTag = Math.min(km, 20) * c.entfernung.satzBis20 + Math.max(0, km - 20) * c.entfernung.satzAb21;
    return round2(Math.max(0, tage) * proTag);
}

/**
 * Estimate one person's ESt for one year. Pure — no I/O — so it is fully unit-testable and each
 * front-end renders the same numbers. See the file header for the order-of-operations rationale.
 */
export function computeEst(inputs: EstInputs): EstResult {
    const c = estConstants(inputs.year);
    const { veranlagung } = inputs;
    const splitFactor = veranlagung === 'splitting' ? 2 : 1;
    const kinder = inputs.kinder ?? 0;
    const kirchensteuersatz = inputs.kirchensteuersatz ?? 0;
    const hinweise: string[] = [];

    // ── (1) Einkünfte §19: Bruttoarbeitslohn − Werbungskosten (max of itemised proof / Pauschbetrag) ──
    const entfernung = inputs.werbungskosten.pendel
        ? entfernungspauschale(inputs.werbungskosten.pendel.tage, inputs.werbungskosten.pendel.kmEinfach, c)
        : 0;
    const homeoffice = Math.min(inputs.werbungskosten.homeofficeTage * c.homeoffice.proTag, c.homeoffice.max);
    const postenSumme = round2(inputs.werbungskosten.posten.reduce((s, p) => s + p.betrag, 0));
    const tatsaechlich = round2(entfernung + homeoffice + postenSumme);
    const angesetzt = Math.max(tatsaechlich, c.arbeitnehmerPauschbetrag);
    const werbungskosten: EstWerbungskosten = {
        entfernungspauschale: entfernung,
        homeofficePauschale: homeoffice,
        postenSumme,
        tatsaechlich,
        pauschbetrag: c.arbeitnehmerPauschbetrag,
        angesetzt,
        pauschbetragGewonnen: tatsaechlich <= c.arbeitnehmerPauschbetrag,
    };
    const einkuenfte19 = round2(Math.max(0, inputs.bruttoarbeitslohn - angesetzt));

    // A Homeoffice day and a commuting day exclude each other on the same day (§4 Abs. 5 S. 1 Nr. 6c).
    const pendelTage = inputs.werbungskosten.pendel?.tage ?? 0;
    if (inputs.werbungskosten.homeofficeTage + pendelTage > 230) {
        hinweise.push(
            `Homeoffice- (${inputs.werbungskosten.homeofficeTage}) + Pendeltage (${pendelTage}) über 230 — pro Tag nur eines ansetzbar, prüfen.`,
        );
    }
    if (entfernung > 4500) {
        hinweise.push('Entfernungspauschale über 4.500 € — Höchstbetrag gilt außer bei eigenem PKW (prüfen).');
    }

    // ── (2) Summe der Einkünfte → Gesamtbetrag der Einkünfte (§19 + Gewerbe − §24b) ──
    // Gewerbe = Einzelunternehmen profit + festgestellte Beteiligungsanteile (both belong in the GdE).
    const einkuenfteGewerbe = round2((inputs.einkuenfteGewerbe ?? 0) + (inputs.einkuenfteGewerbeBeteiligungen ?? 0));
    const summeDerEinkuenfte = round2(einkuenfte19 + einkuenfteGewerbe);
    // §24b Entlastungsbetrag für Alleinerziehende: (Grundbetrag + per-further-child × further) × months/12;
    // reduces the Summe der Einkünfte to the GdE (§2 Abs. 3).
    const efa = inputs.entlastungAlleinerziehende;
    const entlastungAlleinerziehende =
        efa && efa.monate > 0
            ? round2(
                  ((c.entlastungAlleinerziehende.grundbetrag +
                      c.entlastungAlleinerziehende.jeWeiteremKind * Math.max(0, efa.weitereKinder)) *
                      Math.min(12, efa.monate)) /
                      12,
              )
            : 0;
    const gesamtbetragEinkuenfte = round2(summeDerEinkuenfte - entlastungAlleinerziehende);

    // ── (3) Sonderausgaben ──
    // Altersvorsorge (§10 Abs. 3): 100 % since 2023, capped at the Höchstbetrag, then the tax-free
    // AG-Anteil subtracted.
    const altersvorsorgeBeitraege = round2(inputs.vorsorge.rvArbeitnehmer + inputs.vorsorge.rvArbeitgeberSteuerfrei);
    const altersvorsorgeHoechstbetrag = c.vorsorge.altersvorsorgeHoechstbetrag * splitFactor;
    const altersvorsorgeAbziehbar = round2(
        Math.max(
            0,
            Math.min(altersvorsorgeBeitraege, altersvorsorgeHoechstbetrag) - inputs.vorsorge.rvArbeitgeberSteuerfrei,
        ),
    );
    // Sonstige Vorsorge (§10 Abs. 4): Basis-KV/PV without limit; the rest capped, and once Basis
    // alone is ≥ the Höchstbetrag, the rest drops out.
    // §10 Abs. 1 Nr. 3 Satz 4 EStG: where there is an entitlement to Krankengeld (employees in the
    // gesetzliche Krankenversicherung), the statutory Basis-KV contributions must first be cut by 4 %
    // — the share attributable to the Krankengeld does NOT count as a Basisvorsorge-Sonderausgabe. The
    // Pflegeversicherung is not cut. Assumption: an employee in the gesetzliche Versicherung with a
    // Krankengeld entitlement — the model has no PKV/Krankengeld flag so far. For privately insured
    // people without a Krankengeld entitlement the 4 % cut is consequently too much of a good thing.
    const kvBasisAbziehbar = round2(inputs.vorsorge.kvBasis * (1 - c.vorsorge.kvKrankengeldAbschlag));
    const basisKvPv = round2(kvBasisAbziehbar + inputs.vorsorge.pvBasis);
    const sonstigeCap =
        (inputs.vorsorge.hatAgZuschuss ? c.vorsorge.sonstigeMitZuschuss : c.vorsorge.sonstigeOhneZuschuss) *
        splitFactor;
    const sonstigeAbziehbar = round2(Math.max(basisKvPv, Math.min(basisKvPv + inputs.vorsorge.sonstige, sonstigeCap)));
    const vorsorgeAbziehbar = round2(altersvorsorgeAbziehbar + sonstigeAbziehbar);
    const vorsorge: EstVorsorge = {
        altersvorsorgeBeitraege,
        altersvorsorgeHoechstbetrag,
        altersvorsorgeAbziehbar,
        basisKvPv,
        sonstigeCap,
        sonstigeAbziehbar,
        abziehbar: vorsorgeAbziehbar,
    };

    // Sonderausgaben other than Vorsorge: KiSt paid (§10 Abs. 1 Nr. 4) + Spenden (§10b, ≤ 20 % GdE),
    // at least the Sonderausgaben-Pauschbetrag.
    const spendenHoechstbetrag = round2(gesamtbetragEinkuenfte * c.spendenAnteilGdE);
    const spendenAbziehbar = round2(Math.min(inputs.sonderausgaben.spenden, Math.max(0, spendenHoechstbetrag)));
    const kirchensteuerSA = round2(inputs.sonderausgaben.gezahlteKirchensteuer);
    // §10 Nr. 9 Schulgeld: 30 % of the Schulgeld paid, capped at 5.000 € per child.
    // §10 Nr. 5 Kinderbetreuung: from VZ 2025 80 % of the costs, capped at 4.800 € per child
    // (JStG 2024). Both Höchstbeträge depend on the children → without `kinder > 0` the
    // deduction does not apply (Hinweis). Where per-child amounts exist (Anlage-Kind config),
    // the cap is PER CHILD instead of flat via `maxProKind × kinder`. Halving the Höchstbetrag
    // between parents who are not zusammenveranlagt is not modelled (a Schätzung; the
    // Finanzamt computes the binding figure).
    const proKind = (jeKind: number[] | undefined, gesamt: number, satz: number, max: number): number =>
        jeKind && jeKind.length > 0
            ? round2(jeKind.reduce((s, betrag) => s + Math.min(round2(betrag * satz), max), 0))
            : round2(Math.min(round2(gesamt * satz), max * kinder));
    const schulgeldGezahlt = round2(inputs.sonderausgaben.schulgeld ?? 0);
    const kinderbetreuungGezahlt = round2(inputs.sonderausgaben.kinderbetreuung ?? 0);
    const schulgeldAbziehbar = proKind(
        inputs.sonderausgaben.schulgeldJeKind,
        schulgeldGezahlt,
        c.schulgeld.satz,
        c.schulgeld.maxProKind,
    );
    const kinderbetreuungAbziehbar = proKind(
        inputs.sonderausgaben.kinderbetreuungJeKind,
        kinderbetreuungGezahlt,
        c.kinderbetreuung.satz,
        c.kinderbetreuung.maxProKind,
    );
    if ((schulgeldGezahlt > 0 || kinderbetreuungGezahlt > 0) && kinder === 0) {
        hinweise.push(
            'Schulgeld/Kinderbetreuung gesetzt, aber kinder = 0 → kein Abzug. Kinderzahl in der Config setzen.',
        );
    }
    const nichtVorsorgeSumme = round2(
        kirchensteuerSA + spendenAbziehbar + schulgeldAbziehbar + kinderbetreuungAbziehbar,
    );
    const nichtVorsorgeAngesetzt = Math.max(nichtVorsorgeSumme, c.sonderausgabenPauschbetrag);
    const sonderausgabenGesamt = round2(vorsorgeAbziehbar + nichtVorsorgeAngesetzt);

    // ── (4) Außergewöhnliche Belastungen: above the zumutbare Belastung (in steps, §33 Abs. 3) ──
    const zumutbar = zumutbareBelastung(gesamtbetragEinkuenfte, veranlagung, kinder, inputs.year);
    const agbAbziehbar = round2(Math.max(0, inputs.agb.krankheitskosten - zumutbar));
    const agbGeschluckt = round2(Math.min(inputs.agb.krankheitskosten, zumutbar));

    // ── (5) zu versteuerndes Einkommen (rounded down to full €) ──
    const einkommen = gesamtbetragEinkuenfte - sonderausgabenGesamt - agbAbziehbar;
    const zvE = Math.max(0, Math.floor(einkommen));

    // ── (6) tarifliche ESt (§32a, with §32b-Progressionsvorbehalt where applicable) ──
    const progressionseinkuenfte = round2(inputs.progressionseinkuenfte ?? 0);
    const tariflicheESt =
        progressionseinkuenfte !== 0
            ? estTarifProgression(zvE, progressionseinkuenfte, veranlagung, inputs.year)
            : estTarifBy(zvE, inputs.year, veranlagung);

    // ── (7a) §34g-Ermäßigung (Parteizuwendungen): 50 % up to the Höchstbetrag, reduces the tarifliche
    // ESt BEFORE §35a (order per §2 Abs. 6). Not refundable. Zuwendungen above the Höchstbetrag would
    // only be deductible as a §10b-Spende (the Spenden part, not the Beitrag part) → Hinweis, not automatic.
    const parteibeitrag = round2(inputs.par34g?.parteibeitrag ?? 0);
    const par34gBeguenstigt = round2(Math.min(parteibeitrag, c.par34g.maxBeguenstigt * splitFactor));
    const ermaessigung34gBerechnet = round2(par34gBeguenstigt * c.par34g.satz);
    const ermaessigung34gAngesetzt = round2(Math.min(ermaessigung34gBerechnet, tariflicheESt));
    const tariflicheNach34g = round2(Math.max(0, tariflicheESt - ermaessigung34gAngesetzt));
    if (parteibeitrag > par34gBeguenstigt) {
        hinweise.push(
            `§34g: Parteizuwendungen über ${(c.par34g.maxBeguenstigt * splitFactor).toFixed(0)} € — der Überhang ist nur als Spende (§10b, kein Mitgliedsbeitrag) abziehbar; ggf. unter Spenden erfassen.`,
        );
    }

    // ── (7b) §35a-Ermäßigung (against the tarifliche ESt remaining after §34g, capped) ──
    const p = inputs.par35a;
    const ermaessigung35aBerechnet = round2(
        Math.min(round2(p.handwerkerArbeitskosten * c.par35a.satz), c.par35a.maxHandwerker) +
            Math.min(round2(p.haushaltsnah * c.par35a.satz), c.par35a.maxHaushaltsnah) +
            Math.min(round2(p.minijob * c.par35a.satz), c.par35a.maxMinijob),
    );
    const ermaessigung35aAngesetzt = round2(Math.min(ermaessigung35aBerechnet, tariflicheNach34g));
    const ermaessigung35aVerfallen = round2(ermaessigung35aBerechnet - ermaessigung35aAngesetzt);
    if (ermaessigung35aVerfallen > 0) {
        hinweise.push(
            `§35a: ${ermaessigung35aVerfallen.toFixed(2)} € Ermäßigung verfallen (tarifliche ESt zu niedrig, kein Vortrag) — Arbeiten ggf. ins Folgejahr verschieben.`,
        );
    }

    // ── (8) festzusetzende ESt ──
    const festzusetzendeESt = round2(Math.max(0, tariflicheESt - ermaessigung34gAngesetzt - ermaessigung35aAngesetzt));

    // ── (9) Annexsteuern: Soli + KiSt (KiSt base in phase 1 = festzusetzende ESt) ──
    const soliSoll = soliOnEst(festzusetzendeESt, veranlagung, inputs.year);
    const kirchensteuerSoll = round2(festzusetzendeESt * kirchensteuersatz);
    if (kirchensteuersatz > 0 && kinder > 0) {
        hinweise.push(
            'Kirchensteuer-Bemessung ohne §51a-Kinderfreibetrags-Korrektur (Schätzung) — Bescheid weicht ggf. ab.',
        );
    }

    // ── (10) Abrechnung per tax type (positive = Erstattung) ──
    const estEinbehalten = round2(inputs.einbehalten.lohnsteuer + (inputs.einbehalten.estVorauszahlung ?? 0));
    const estPosten: EstAbrechnungPosten = {
        soll: festzusetzendeESt,
        einbehalten: estEinbehalten,
        erstattung: round2(estEinbehalten - festzusetzendeESt),
    };
    const soliPosten: EstAbrechnungPosten = {
        soll: soliSoll,
        einbehalten: round2(inputs.einbehalten.soli),
        erstattung: round2(inputs.einbehalten.soli - soliSoll),
    };
    const kistPosten: EstAbrechnungPosten = {
        soll: kirchensteuerSoll,
        einbehalten: round2(inputs.einbehalten.kirchensteuer),
        erstattung: round2(inputs.einbehalten.kirchensteuer - kirchensteuerSoll),
    };
    const erstattung = round2(estPosten.erstattung + soliPosten.erstattung + kistPosten.erstattung);

    // Günstigerprüfungen the Finanzamt runs that this Schätzung does NOT compute — possible in the Bescheid.
    hinweise.push(
        'Günstigerprüfungen macht das Finanzamt (Kindergeld/Kinderfreibetrag §31, Kapitalerträge §32d Abs. 6, Vorsorge-Altregelung §10 Abs. 4a) — hier nicht berechnet.',
    );
    hinweise.push('Schätzung — verbindlich ist allein der Steuerbescheid.');

    return {
        year: inputs.year,
        veranlagung,
        bruttoarbeitslohn: round2(inputs.bruttoarbeitslohn),
        einkuenfteGewerbe: round2(einkuenfteGewerbe),
        werbungskosten,
        einkuenfte19,
        entlastungAlleinerziehende,
        gesamtbetragEinkuenfte,
        vorsorge,
        sonderausgaben: {
            vorsorgeAbziehbar,
            kirchensteuer: kirchensteuerSA,
            spenden: spendenAbziehbar,
            spendenHoechstbetrag,
            schulgeld: schulgeldAbziehbar,
            kinderbetreuung: kinderbetreuungAbziehbar,
            nichtVorsorgeAngesetzt,
            nichtVorsorgePauschbetrag: c.sonderausgabenPauschbetrag,
            gesamt: sonderausgabenGesamt,
        },
        agb: {
            krankheitskosten: round2(inputs.agb.krankheitskosten),
            zumutbareBelastung: zumutbar,
            abziehbar: agbAbziehbar,
            geschluckt: agbGeschluckt,
        },
        zvE,
        progressionseinkuenfte,
        tariflicheESt,
        ermaessigung35a: {
            berechnet: ermaessigung35aBerechnet,
            angesetzt: ermaessigung35aAngesetzt,
            verfallen: ermaessigung35aVerfallen,
        },
        ermaessigung34g: {
            beguenstigt: par34gBeguenstigt,
            berechnet: ermaessigung34gBerechnet,
            angesetzt: ermaessigung34gAngesetzt,
        },
        festzusetzendeESt,
        abrechnung: { est: estPosten, soli: soliPosten, kirchensteuer: kistPosten },
        erstattung,
        hinweise,
    };
}

/** A tax-optimisation theme (Finanzguru-style) and its exact € effect on the refund. */
export type EstThemeKey = 'arbeit' | 'handwerker' | 'vorsorge' | 'gesundheit' | 'spenden' | 'haushaltsnah';

export interface EstThemeImpact {
    key: EstThemeKey;
    /** The theme's base amount (deduction total, or §35a begünstigte Kosten). */
    amount: number;
    /** € added to the refund by this theme — exact counterfactual (refund with − refund without). */
    impact: number;
}

/** Zero out one theme's inputs to measure its counterfactual contribution. */
function withoutTheme(inputs: EstInputs, key: EstThemeKey): EstInputs {
    switch (key) {
        case 'arbeit':
            return { ...inputs, werbungskosten: { homeofficeTage: 0, posten: [] } };
        case 'handwerker':
            return { ...inputs, par35a: { ...inputs.par35a, handwerkerArbeitskosten: 0 } };
        case 'haushaltsnah':
            return { ...inputs, par35a: { ...inputs.par35a, haushaltsnah: 0, minijob: 0 } };
        case 'vorsorge':
            return {
                ...inputs,
                vorsorge: { ...inputs.vorsorge, rvArbeitnehmer: 0, kvBasis: 0, pvBasis: 0, sonstige: 0 },
            };
        case 'gesundheit':
            return { ...inputs, agb: { krankheitskosten: 0 } };
        case 'spenden':
            return { ...inputs, sonderausgaben: { ...inputs.sonderausgaben, spenden: 0 } };
    }
}

/** The base amount shown per theme (matches the "Steuer-Themen" cards). */
function themeAmount(inputs: EstInputs, key: EstThemeKey): number {
    const v = inputs.vorsorge;
    switch (key) {
        case 'arbeit': {
            const c = estConstants(inputs.year);
            const entf = inputs.werbungskosten.pendel
                ? entfernungspauschale(inputs.werbungskosten.pendel.tage, inputs.werbungskosten.pendel.kmEinfach, c)
                : 0;
            const ho = Math.min(inputs.werbungskosten.homeofficeTage * c.homeoffice.proTag, c.homeoffice.max);
            return round2(entf + ho + inputs.werbungskosten.posten.reduce((s, p) => s + p.betrag, 0));
        }
        case 'handwerker':
            return round2(inputs.par35a.handwerkerArbeitskosten);
        case 'haushaltsnah':
            return round2(inputs.par35a.haushaltsnah + inputs.par35a.minijob);
        case 'vorsorge':
            return round2(v.rvArbeitnehmer + v.kvBasis + v.pvBasis + v.sonstige);
        case 'gesundheit':
            return round2(inputs.agb.krankheitskosten);
        case 'spenden':
            return round2(inputs.sonderausgaben.spenden);
    }
}

const ALL_THEMES: EstThemeKey[] = ['arbeit', 'handwerker', 'vorsorge', 'gesundheit', 'spenden', 'haushaltsnah'];

/**
 * The € each theme is worth on the refund, by exact counterfactual: refund(full) − refund(theme
 * removed). Deduction themes are worth the marginal rate; §35a themes are worth 100 % up to the cap
 * (and 0 € once the credit has already been forfeited). Themes with no input yield amount 0.
 */
export function estThemeImpacts(inputs: EstInputs): EstThemeImpact[] {
    const full = computeEst(inputs).erstattung;
    return ALL_THEMES.map((key) => ({
        key,
        amount: themeAmount(inputs, key),
        impact: round2(full - computeEst(withoutTheme(inputs, key)).erstattung),
    }));
}
