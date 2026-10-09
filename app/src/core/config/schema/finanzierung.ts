/**
 * Manifest section schema: an entity's inline `finanzierung` block — the input for an
 * Immobilien-/Sanierungsfinanzierung (Kapitalbedarf, Haushaltsrechnung, Bankangebote,
 * Unterlagen-Checkliste).
 *
 * Lives inline on a manifest entity, exactly like the `est` block, so the private
 * household's tax facts and its financing facts sit side by side in the one gitignored
 * `steuererklaerung.json` — and never in git. See {@link file://../../actions/finanzierung/index.ts}
 * for what is computed from it; the loan arithmetic itself is `@steuererklaerung/kredit`.
 *
 * Convention: rates are **percent per year** (3.9 = 3.9 %), amounts are **euro**,
 * recurring amounts are **per month** unless the field name says otherwise.
 */

import { z } from 'zod';

/** The property being financed — descriptive only, nothing is computed from it. */
const ObjektSchema = z.object({
    bezeichnung: z.string(),
    adresse: z.string().optional(),
    /** Current owner, when that is not yet the borrower (e.g. a purchase from family). */
    eigentuemer: z.string().optional(),
    wohnflaeche_qm: z.number().positive().optional(),
    baujahr: z.number().int().optional(),
});

/**
 * Kaufnebenkosten as percentages of the Kaufpreis. Defaults are the Niedersachsen
 * rates; Grunderwerbsteuer is state law and changes, so it stays configurable.
 */
const NebenkostenSchema = z.object({
    /** Grunderwerbsteuer — 5 % in Niedersachsen (as of 2026). */
    grunderwerbsteuer_prozent: z.number().nonnegative().default(5),
    /** Notar + Grundbuch — industry rule of thumb ~2 %. */
    notar_grundbuch_prozent: z.number().nonnegative().default(2),
    /** Makler-Käuferanteil; 0 for a purchase without a Makler (e.g. within the family). */
    makler_prozent: z.number().nonnegative().default(0),
    /** Fixed extras in euro (Gutachten, Grundschuldbestellung, …). */
    sonstige: z.number().nonnegative().default(0),
});

/** What the financing has to cover. */
const BedarfSchema = z.object({
    /** Restschuld of the existing loan on the property, which is redeemed. */
    abloesung: z.number().nonnegative().default(0),
    /** Amount that flows to the sellers (in a family purchase: on top of the Ablösung). */
    auszahlung_verkaeufer: z.number().nonnegative().default(0),
    /** Sanierung component — usually the material costs when the work is done in Eigenleistung. */
    sanierung: z.number().nonnegative().default(0),
    /**
     * Bemessungsgrundlage for the percentage Nebenkosten. Without a value,
     * `abloesung + auszahlung_verkaeufer` is taken as the Kaufpreis.
     */
    kaufpreis: z.number().nonnegative().optional(),
    nebenkosten: NebenkostenSchema.prefault({}),
    /** Eigenkapital that lowers the financing requirement. */
    eigenkapital: z.number().nonnegative().default(0),
});

/** One recurring income line. */
const EinnahmeSchema = z.object({
    bezeichnung: z.string(),
    betrag_monat: z.number(),
    /**
     * False for income a bank will discount or ignore entirely (variable bonus,
     * freelance side income without a track record). Both totals are reported.
     */
    sicher: z.boolean().default(true),
    /** Where the figure comes from — a Paperless id, an account key, "Lohnabrechnung 06/2026". */
    quelle: z.string().optional(),
});

/** One recurring expense line. */
const AusgabeSchema = z.object({
    bezeichnung: z.string(),
    betrag_monat: z.number(),
    /** True for costs that disappear once the property is bought — above all the rent. */
    entfaellt_nach_kauf: z.boolean().default(false),
    /**
     * True for costs that only ARRIVE with ownership — Grundsteuer, Gebäudeversicherung,
     * Instandhaltungsrücklage: today the seller carries them, afterwards you do. Counted
     * only in the after-purchase totals, never in today's.
     *
     * Without this the Haushaltsrechnung is systematically too optimistic, because the
     * rent-vs-instalment comparison silently drops the running cost of owning the
     * building. A lender adds its own Bewirtschaftungspauschale for exactly this.
     */
    erst_nach_kauf: z.boolean().default(false),
    /**
     * True for everyday living costs (Lebensmittel, Kleidung, Freizeit) that a bank does
     * not itemise but covers with its {@link LebenshaltungSchema} flat rate. Such items are
     * counted in the Ist-Rechnung and *replaced* by the flat rate in the Bank-Sicht, so the
     * two views stay comparable instead of double-counting.
     */
    in_pauschale: z.boolean().default(false),
    quelle: z.string().optional(),
});

/**
 * Lebenshaltungspauschale a bank substitutes for the real expenses. These are
 * **Richtwerte and bank-dependent** — every institute uses its own table, so the
 * numbers here are a starting point to be replaced with what your bank actually
 * applies, not a fact.
 */
const LebenshaltungSchema = z.object({
    erster_erwachsener: z.number().nonnegative().default(700),
    weiterer_erwachsener: z.number().nonnegative().default(300),
    kind: z.number().nonnegative().default(250),
});

/** Income, expenses and household size — the basis of the Haushaltsrechnung. */
const HaushaltSchema = z.object({
    erwachsene: z.number().int().positive().default(1),
    kinder: z.number().int().nonnegative().default(0),
    einnahmen: z.array(EinnahmeSchema).default([]),
    ausgaben: z.array(AusgabeSchema).default([]),
    lebenshaltung: LebenshaltungSchema.prefault({}),
    /**
     * Sicherheitspuffer in percent of the free income that is NOT offered up as an
     * instalment — repairs, vacancies, the unexpected. Default 10 %.
     */
    puffer_prozent: z.number().nonnegative().default(10),
});

/** One bank quote to compare. */
const AngebotSchema = z.object({
    bank: z.string(),
    /** Nominal rate p.a. in percent. */
    sollzins: z.number().nonnegative(),
    /** Initial Tilgung p.a. in percent. */
    tilgung: z.number().nonnegative().default(2),
    zinsbindung_jahre: z.number().positive().default(10),
    /** Loan amount, when the quote is for less than the full requirement. */
    betrag: z.number().positive().optional(),
    /** Contractually allowed Sondertilgung per year, in euro. */
    sondertilgung_pro_jahr: z.number().nonnegative().default(0),
    disagio_prozent: z.number().nonnegative().default(0),
    gebuehren: z.number().nonnegative().default(0),
    /** Date the quote was given (YYYY-MM-DD) — rates expire. */
    stand: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)')
        .optional(),
    notiz: z.string().optional(),
});

/** Status of one document the bank asked for. */
const UnterlageStatusSchema = z.enum(['offen', 'angefordert', 'vorhanden', 'eingereicht']);

/** One entry of the lender's document checklist. */
const UnterlageSchema = z.object({
    bezeichnung: z.string(),
    status: UnterlageStatusSchema.default('offen'),
    /** Paperless document id, once the paper exists. */
    paperless_id: z.number().int().positive().optional(),
    notiz: z.string().optional(),
});

/** The entity's whole `finanzierung` block. */
export const FinanzierungSectionSchema = z.object({
    objekt: ObjektSchema.optional(),
    bedarf: BedarfSchema.prefault({}),
    haushalt: HaushaltSchema.prefault({}),
    angebote: z.array(AngebotSchema).default([]),
    unterlagen: z.array(UnterlageSchema).default([]),
});

export type FinanzierungConfig = z.infer<typeof FinanzierungSectionSchema>;
export type FinanzierungBedarf = z.infer<typeof BedarfSchema>;
export type FinanzierungHaushalt = z.infer<typeof HaushaltSchema>;
export type FinanzierungAngebot = z.infer<typeof AngebotSchema>;
export type FinanzierungUnterlage = z.infer<typeof UnterlageSchema>;
export type FinanzierungUnterlageStatus = z.infer<typeof UnterlageStatusSchema>;
