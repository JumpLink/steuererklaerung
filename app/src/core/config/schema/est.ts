/**
 * Manifest section schema: an entity's inline `est` block (the former standalone est-config.json).
 *
 * This module OWNS the private-Einkommensteuer (ESt) config schema, its inferred types, and the two
 * lookup helpers ({@link estJahr}, {@link estKindJahr}) — the standalone `est-config.ts` loader is
 * gone; the payload now lives inline under a `privat` manifest entity's `est` key.
 *
 * The transaction-derived parts (Handwerker/Spenden/Gesundheit/Arbeitsmittel) come from
 * {@link file://../../elster/est-aggregate.ts est-aggregate}; this config is merged on top (config
 * wins) in the est action. See docs/references/tax-sources.md for every constant the calc applies.
 */

import { z } from 'zod';

/**
 * One year's child facts for the Anlage Kind (E10 `Kind`): Kindergeld-Anspruch plus the
 * per-child Schulgeld/Kinderbetreuung. The XML declares PAID amounts ("berücksichtigungs-
 * fähige Gesamtaufwendungen") — the Finanzamt computes the deductible share (30 % Schulgeld,
 * 80 % Kinderbetreuung from VZ 2025) and the caps.
 */
const EstKindJahrSchema = z.object({
    jahr: z.number().int().min(2000).max(2100),
    /** Yearly Kindergeld-Anspruch in whole € (E10 `E0500702`). For parents not assessed jointly
     *  and holding a half Kinderfreibetrag, the HALF yearly claim (the convention of the
     *  officially filed prior-year return); the full claim only with a full Kinderfreibetrag
     *  (e.g. the other parent cannot be identified, `wohnsitz_unbekannt`). */
    kindergeld_anspruch: z.number().nonnegative(),
    /** Schulgeld §10 Abs. 1 Nr. 9 — ONLY the pure Schulgeld share per the school's
     *  Bescheinigung (without lodging/care/meals). */
    schulgeld: z
        .object({
            /** Name of the school or of its operating body (`E0505606`). */
            schule: z.string(),
            /** Total Schulgeld paid by the parents (`E0504405`/`E0505607`). */
            gezahlt: z.number().nonnegative(),
            /** Share borne by the taxpayer (`E0504505`); default = `gezahlt`. */
            von_mir: z.number().nonnegative().optional(),
        })
        .optional(),
    /** Household details (`KBK/Ang_HH`) — MANDATORY as soon as Kinderbetreuungskosten are
     *  declared (ERiC rule 10514160, empirically verified): either the parents' joint
     *  household (`gemeinsam_*`) or the separate households (`getrennt_*`); the two may be
     *  combined (Trennungsjahr). Periods in the format `TT.MM-TT.MM`. */
    haushalt: z
        .object({
            /** The parents kept a joint household during the period (`E0504807`). */
            gemeinsam_zeitraum: z
                .string()
                .regex(/^\d{2}\.\d{2}-\d{2}\.\d{2}$/, 'TT.MM-TT.MM')
                .optional(),
            /** The child belonged to our household during the period (`E0504808`). */
            gemeinsam_kind_zeitraum: z
                .string()
                .regex(/^\d{2}\.\d{2}-\d{2}\.\d{2}$/, 'TT.MM-TT.MM')
                .optional(),
            /** The parents kept NO joint household during the period (`E0505201`). */
            getrennt_zeitraum: z
                .string()
                .regex(/^\d{2}\.\d{2}-\d{2}\.\d{2}$/, 'TT.MM-TT.MM')
                .optional(),
            /** The child belonged to MY household during the period (`E0505202`). */
            kind_bei_mir_zeitraum: z
                .string()
                .regex(/^\d{2}\.\d{2}-\d{2}\.\d{2}$/, 'TT.MM-TT.MM')
                .optional(),
            /** The child belonged to the OTHER parent's household during the period (`E0508901`). */
            kind_beim_anderen_zeitraum: z
                .string()
                .regex(/^\d{2}\.\d{2}-\d{2}\.\d{2}$/, 'TT.MM-TT.MM')
                .optional(),
        })
        .optional(),
    /** Kinderbetreuungskosten §10 Abs. 1 Nr. 5 (`KBK`) — one row per service provider;
     *  requires an invoice + a non-cash payment. */
    kinderbetreuung: z
        .array(
            z.object({
                /** Type of service, name and address of the service provider (`E0506101`). */
                bezeichnung: z.string(),
                /** Period within the year, format TT.MM (E10 `DatumBereichTTpMMbTTpMM`). */
                zeitraum_von: z
                    .string()
                    .regex(/^\d{2}\.\d{2}$/, 'TT.MM')
                    .default('01.01'),
                zeitraum_bis: z
                    .string()
                    .regex(/^\d{2}\.\d{2}$/, 'TT.MM')
                    .default('31.12'),
                /** Amount paid (`E0506104`). */
                betrag: z.number().nonnegative(),
                /** Tax-free reimbursements, e.g. an employer subsidy (`E0506505`). */
                erstattet: z.number().nonnegative().default(0),
                /** Share borne by the taxpayer (`E0506605`); default = betrag − erstattet. */
                von_mir: z.number().nonnegative().optional(),
            }),
        )
        .default([]),
});

/**
 * One child for the Anlage Kind — identity + Kindschaftsverhältnis. PRIVATE data (IdNr,
 * Geburtsdatum), only in the gitignored config. A child with no `jahre` entry for the
 * declared year still gets an Anlage Kind (it counts towards the Kinderfreibetrag).
 */
const EstKindSchema = z.object({
    vorname: z.string(),
    /** Family name where it differs from the taxpayer's (`E0500108`). */
    nachname: z.string().optional(),
    /** The child's 11-digit Steuer-IdNr (`E0500406`) — mandatory for the E10 XML. */
    idnr: z
        .string()
        .regex(/^\d{11}$/, 'must be an 11-digit IdNr')
        .optional(),
    geburtsdatum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)'),
    /** Familienkasse responsible for assessing the Kindergeld (`E0500706`). */
    familienkasse: z.string().optional(),
    /** Type of Kindschaftsverhältnis to the taxpayer (`E0500807`):
     *  '1' biological/adopted child · '2' foster child · '3' grandchild/stepchild. */
    kindschaftsverhaeltnis: z.enum(['1', '2', '3']).default('1'),
    /** Kindschaftsverhältnis to another person (the other parent, `K_Verh_and_P`). */
    anderer_elternteil: z
        .object({
            /** Surname, given name (`E0501103`). */
            name: z.string(),
            geburtsdatum: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)')
                .optional(),
            /** Last known address (`E0501105`). */
            adresse: z.string().optional(),
            /** '1' biological/adopted child · '2' foster child (`E0501106`). */
            kindschaftsverhaeltnis: z.enum(['1', '2']).default('1'),
            /** Residence/habitual abode cannot be determined, or the father is not officially
             *  identifiable (`E0501513`) — yields the FULL Kinderfreibetrag. */
            wohnsitz_unbekannt: z.boolean().default(false),
        })
        .optional(),
    jahre: z.array(EstKindJahrSchema).default([]),
});

/** One year's Lohnsteuerbescheinigung + year-specific work facts. */
const EstJahrSchema = z.object({
    jahr: z.number().int().min(2000).max(2100),
    /** Bruttoarbeitslohn (Bescheinigung line 3). */
    bruttoarbeitslohn: z.number().nonnegative(),
    /** Steuerklasse per the Lohnsteuerbescheinigung (E10 Anlage N `E0200002` — mandatory with wages). */
    steuerklasse: z.number().int().min(1).max(6).optional(),
    /** Lohnsteuer / Soli / Kirchensteuer withheld (prepayments). */
    lohnsteuer: z.number().nonnegative().default(0),
    soli: z.number().nonnegative().default(0),
    kirchensteuer: z.number().nonnegative().default(0),
    /** ESt-Vorauszahlung amounts already paid (Gewerbetreibende). */
    est_vorauszahlung: z.number().nonnegative().default(0),
    /** Optional Einkünfte aus Gewerbebetrieb (EÜR-Gewinn) — folds into the GdE. */
    einkuenfte_gewerbe: z.number().default(0),
    /**
     * Which workspace entity's Anlage-EÜR profit {@link einkuenfte_gewerbe} is a copy of
     * (e.g. 'jumplink'). Declaring it turns a hand-maintained number into a CHECKABLE one: the
     * cross-checks then compare the copy against that entity's computed EÜR profit and report
     * the drift.
     *
     * It exists because the copy silently went stale. The 2025 ESt was filed with 811,53 € while
     * the Anlage EÜR for the same year computes 837,56 € — two filings to the same Finanzamt
     * disagreeing by 26,03 €, and nothing in the tooling said so. Without this link the check
     * cannot know which of several Betriebe the number belongs to, so it stays optional and the
     * check reports 'nicht deklariert' rather than guessing.
     */
    einkuenfte_gewerbe_quelle: z.string().optional(),
    /** Exact description of the trade (Anlage G `E0800301`) — mandatory for the E10 XML as soon
     *  as `einkuenfte_gewerbe` is set. */
    gewerbe_bezeichnung: z.string().optional(),
    /** Shares from separately assessed Beteiligungen (Anlage G `Ges_Fest`, e.g. a
     *  GbR share): the assessed amount per the Feststellungserklärung/-bescheid. */
    gewerbe_beteiligungen: z
        .array(
            z.object({
                bezeichnung: z.string(),
                /** Finanzamt of the Feststellung (name or 4-digit BuFa-Nr., `E0800704`). */
                finanzamt: z.string(),
                /** Steuernummer of the Feststellung (regional FF/BBB/UUUUP or 13 digits, `E0800804`).
                 *  ERiC (Hinweis 100800068) demands it on top of the Finanzamt — without it the
                 *  Anlage-G Ges_Fest entry stays incomplete. */
                steuernummer: z.string().optional(),
                betrag: z.number(),
            }),
        )
        .default([]),
    /** Kirchensteuer paid as a Sonderausgabe (§10 Abs. 1 Nr. 4); default = the KiSt withheld. */
    gezahlte_kirchensteuer: z.number().nonnegative().optional(),
    /** Additional manual donations (not already detected from transactions). */
    spenden: z.number().nonnegative().default(0),
    /** Additional manual medical costs (agB), not already from transactions. */
    krankheitskosten: z.number().nonnegative().default(0),
    /** Schulgeld for a private school (§10 Abs. 1 Nr. 9) — 30 % deductible, max 5.000 €/child. Only
     *  the pure Schulgeld share (without meals/care/transport). */
    schulgeld: z.number().nonnegative().default(0),
    /** Kinderbetreuungskosten (§10 Abs. 1 Nr. 5) — 2/3 deductible, max 4.000 €/child (child < 14 y.). */
    kinderbetreuung: z.number().nonnegative().default(0),
    /** Contributions (dues/donations) to political parties (§34g) — 50 % tax reduction. */
    parteibeitrag: z.number().nonnegative().default(0),
    /** Wage-replacement benefits subject to the Progressionsvorbehalt (§32b) — e.g. Eltern-,
     *  Arbeitslosen-, Kranken-, Mutterschaftsgeld (E10 `E0104801`). `erhalten` = received in the year,
     *  `zurueckgezahlt` = amounts repaid to the paying agency in the year (Abflussprinzip §11).
     *  The net (erhalten − zurückgezahlt) only changes the tax rate; if the repayment dominates, the
     *  negative Progressionsvorbehalt lowers the tax. */
    lohnersatz: z
        .object({
            erhalten: z.number().nonnegative().default(0),
            zurueckgezahlt: z.number().nonnegative().default(0),
        })
        .optional(),
    /** §24b Entlastungsbetrag für Alleinerziehende. `monate` = calendar months in which the
     *  conditions are met (single, no other adult in the household, at least one child with a
     *  Kindergeld claim in the household); `weitere_kinder` = children in the household BEYOND the
     *  first (each an Erhöhungsbetrag); `kind_idnr` = IdNr of the child the claim is filed for
     *  (Anlage Kind `E0505002`; without it no XML flag). */
    entlastung_alleinerziehende: z
        .object({
            monate: z.number().int().min(0).max(12).default(0),
            weitere_kinder: z.number().int().min(0).default(0),
            kind_idnr: z.string().optional(),
        })
        .optional(),
    // Nested blocks are `.optional()` (not `.default({})`): in Zod 4 a `.default({})` would emit a
    // bare `{}` at runtime instead of applying the inner field defaults. When the block is present
    // its own field defaults apply; when absent, the est action falls back to 0/undefined.
    vorsorge: z
        .object({
            rv_arbeitnehmer: z.number().nonnegative().default(0),
            rv_arbeitgeber_steuerfrei: z.number().nonnegative().default(0),
            kv_basis: z.number().nonnegative().default(0),
            pv_basis: z.number().nonnegative().default(0),
            /** Employee contributions to the Arbeitslosenversicherung (Bescheinigung no. 27) — its own
             *  line `E2004403` in the E10; for the calculation part of the capped sonstige Vorsorge. */
            av_arbeitnehmer: z.number().nonnegative().default(0),
            sonstige: z.number().nonnegative().default(0),
            ag_zuschuss: z.boolean().default(true),
        })
        .optional(),
    werbungskosten: z
        .object({
            homeoffice_tage: z.number().int().nonnegative().default(0),
            /** E10 line choice for the Homeoffice-Tagespauschale: `true` → another workplace
             *  is available (`E0204507`); `false` → permanently NO other workplace
             *  (`E0206206`). Legally distinct lines — mandatory for the XML as soon as
             *  `homeoffice_tage` > 0. */
            homeoffice_anderer_arbeitsplatz: z.boolean().optional(),
            pendel: z
                .object({
                    arbeitstage: z.number().int().nonnegative(),
                    km_einfach: z.number().nonnegative(),
                    /** Erste Tätigkeitsstätte as „PLZ Ort, Straße" (Anlage N `E0203501`) — ERiC
                     *  requires it with every Entfernungspauschale. */
                    ziel: z.string().optional(),
                })
                .optional(),
            posten: z.array(z.object({ bezeichnung: z.string(), betrag: z.number() })).default([]),
        })
        .optional(),
    /** §35a amounts with no transaction of their own (e.g. haushaltsnah Nebenkostenabrechnung shares). */
    par35a_manuell: z
        .object({
            handwerker: z.number().nonnegative().default(0),
            haushaltsnah: z.number().nonnegative().default(0),
            minijob: z.number().nonnegative().default(0),
        })
        .optional(),
});

export const EstConfigRawSchema = z.object({
    entity_id: z.string().default('privat'),
    veranlagung: z.enum(['einzel', 'splitting']).default('einzel'),
    /**
     * Diese Person gibt ihre Einkommensteuererklärung selbst ab — nicht über
     * dieses Werkzeug.
     *
     * Dann wird KEIN ESt-Termin abgeleitet. Die Rechnung selbst bleibt nutzbar
     * (Schätzung, Beteiligungen), nur die Frist gehört jemand anderem, und eine
     * Erinnerung an eine fremde Pflicht ist eine Erinnerung, die man abstellt —
     * und mit ihr die eigenen.
     */
    abgabe_extern: z.boolean().default(false),
    person: z.object({
        name: z.string(),
        /** Explicit name parts for the E10 (otherwise `name` is split at the last space). */
        vorname: z.string().optional(),
        nachname: z.string().optional(),
        /** 11-digit personal Steuer-IdNr — PRIVATE data, only in the gitignored config. */
        steuer_id: z
            .string()
            .regex(/^\d{11}$/, 'must be an 11-digit Steuer-IdNr')
            .optional(),
        /** Personal Steuernummer (regional `FF/BBB/UUUUP` or 13 digits) — Vorsatz `StNr`. */
        steuernummer: z.string().optional(),
        finanzamt: z.string().optional(),
        bundesland: z.string().optional(),
        /** Registration data for the E10 Hauptvordruck (ESt1A `Allg/A`) — mandatory for the XML. */
        geburtsdatum: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)')
            .optional(),
        beruf: z.string().optional(),
        strasse: z.string().optional(),
        hausnummer: z.string().optional(),
        plz: z.string().optional(),
        ort: z.string().optional(),
        /** Official Religionsschlüssel (`E0100402`, e.g. '02' ev, '03' rk). With a
         *  `kirchensteuersatz` of 0, '11' (not liable for Kirchensteuer) is derived. */
        religion: z.string().optional(),
        /** IBAN for the Erstattung (ESt1A `BV/E0102102`, a domestic institution). Optional. */
        iban: z.string().optional(),
        /** Phone number for queries (`E0100008`). Optional. */
        telefon: z.string().optional(),
        /** 0 (not liable for Kirchensteuer) · 0,08 (BY/BW) · 0,09 (all other Länder). */
        kirchensteuersatz: z.number().min(0).max(1).default(0),
        /** Children with Kinderfreibetrag/Kindergeld — column of the Zumutbare Belastung. Must match
         *  the length of the top-level `kinder` list once that is maintained (E10 plausibility check). */
        kinder: z.number().int().nonnegative().default(0),
    }),
    /** Children for the Anlage Kind (one E10 `Kind` block per child) — identity + yearly data. */
    kinder: z.array(EstKindSchema).default([]),
    /** ELSTER transmission frame for the E10 XML (counterpart to the elster-config). */
    output_directory: z.string().default('./elster'),
    test_mode: z.boolean().default(true),
    hersteller_id: z.string().optional(),
    datenlieferant: z.string().optional(),
    jahre: z.array(EstJahrSchema).default([]),
    /** Per-transaction §35a Arbeitskosten (the favoured labour share, without material). */
    par35a_arbeitskosten: z
        .array(
            z.object({
                transaktion_id: z.string(),
                bezeichnung: z.string().default(''),
                arbeitskosten: z.number().nonnegative(),
            }),
        )
        .default([]),
    /** Reclassifications of misclassified transactions (tx id → target bucket). */
    reklassifizierungen: z
        .array(
            z.object({
                transaktion_id: z.string(),
                ziel: z.enum([
                    'arbeit',
                    'handwerker',
                    'haushaltsnah',
                    'vorsorge',
                    'gesundheit',
                    'spenden',
                    'kapital',
                    'gehalt',
                    'neutral',
                ]),
            }),
        )
        .default([]),
});

export type EstJahr = z.infer<typeof EstJahrSchema>;
export type EstKind = z.infer<typeof EstKindSchema>;
export type EstKindJahr = z.infer<typeof EstKindJahrSchema>;
export type EstConfig = z.infer<typeof EstConfigRawSchema>;

/** The inline manifest section is shape-identical with the former est-config.json. */
export const EstSectionSchema = EstConfigRawSchema;
export type EstSection = z.infer<typeof EstSectionSchema>;

/** The Lohnsteuerbescheinigung row for a year, or undefined when none is configured. */
export function estJahr(config: EstConfig, year: number): EstJahr | undefined {
    return config.jahre.find((j) => j.jahr === year);
}

/** A child's year entry (Kindergeld-Anspruch, Schulgeld, Betreuung), or undefined. */
export function estKindJahr(kind: EstKind, year: number): EstKindJahr | undefined {
    return kind.jahre.find((j) => j.jahr === year);
}
