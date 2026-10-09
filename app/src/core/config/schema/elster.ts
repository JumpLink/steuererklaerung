/**
 * Manifest section schema: an entity's inline `elster` block (the former standalone elster-config.json).
 *
 * This module OWNS the ELSTER config schema, its inferred types, and the two pure helpers
 * ({@link normalizeElsterConfig}, {@link getPeriodDateRange}) — the standalone `elster-config.ts` loader
 * is gone; the payload now lives inline under a manifest entity's `elster` key and is resolved to a
 * normalised {@link ElsterConfig} via {@link normalizeElsterConfig}.
 */

import { join } from 'node:path';
import { z } from 'zod';
import { ConfigError } from '../../lib/errors.ts';

const ElsterPeriodSchema = z
    .object({
        year: z.number().int().min(2000).max(2100),
        quarter: z.number().int().min(1).max(4).optional(),
        month: z.number().int().min(1).max(12).optional(),
    })
    .refine((p) => p.quarter != null || p.month != null, { message: 'period must have either quarter or month' });

/** A GbR partner (Gesellschafter). PRIVATE data — lives only in the gitignored config. */
const GesellschafterSchema = z.object({
    id: z.string(),
    name: z.string(),
    /** 11-digit personal Steuer-IdNr (NOT the GbR Steuernummer). */
    steuer_id: z.string().regex(/^\d{11}$/, 'must be an 11-digit Steuer-IdNr'),
    /** Beteiligungsquote as a fraction; quotes across all partners sum to 1. */
    quote: z.number().min(0).max(1),
    finanzamt: z.string().optional(),
    // ── extra fields for the full Feststellung (Anlage FB), all optional ──
    /** Anrede for the Feststellung Anlage FB (e.g. "Herr"/"Frau"). */
    anrede: z.string().optional(),
    /** Vorname(n); derived from `name` (all but the last word) if omitted. */
    vorname: z.string().optional(),
    /** Nachname; derived from `name` (the last word) if omitted. */
    nachname: z.string().optional(),
    /** Geburtsdatum (YYYY-MM-DD). */
    geburtsdatum: z.string().optional(),
    /** Private address; defaults to the GbR betrieb address if omitted. */
    strasse: z.string().optional(),
    plz: z.string().optional(),
    ort: z.string().optional(),
});

/** §8 Hinzurechnungen — each optional, defaults to 0; see gewst.ts for the §-references. */
const GewstHinzurechnungenSchema = z
    .object({
        finanzierungsanteile: z.number().nonnegative().default(0),
        streubesitzdividenden: z.number().nonnegative().default(0),
        verlustanteile_pers_ges: z.number().nonnegative().default(0),
        sonstige: z.number().nonnegative().default(0),
    })
    .partial();

/** §9 Kürzungen — each optional, defaults to 0. */
const GewstKuerzungenSchema = z
    .object({
        grundbesitz: z.number().nonnegative().default(0),
        gewinnanteile_pers_ges: z.number().nonnegative().default(0),
        spenden: z.number().nonnegative().default(0),
        sonstige: z.number().nonnegative().default(0),
    })
    .partial();

/** Gewerbesteuer parameters (for the GewSt 1 A). */
const GewerbeSchema = z.object({
    gemeinde: z.string(),
    ags: z.string().optional(),
    hebesatz: z.number().positive(),
    hinzurechnungen: GewstHinzurechnungenSchema.optional(),
    kuerzungen: GewstKuerzungenSchema.optional(),
});

const UsteSchema = z.object({
    /** Σ of the year's already-filed USt-VA Zahllasten (for the closing reconciliation). */
    prepaid_vat: z.number().default(0),
});

/**
 * A depreciable fixed asset (Anlageverzeichnis / Anlage AVEÜR) → linear AfA.
 * `restbuchwert_anfang` is the Buchwert at the START of the filing year (01.01.),
 * carried from the prior year's Anlageverzeichnis.
 */
const AnlagegutSchema = z.object({
    id: z.string(),
    bezeichnung: z.string(),
    /** Anschaffungs-/Herstellungsdatum (YYYY-MM-DD). */
    anschaffung: z.string(),
    /** Anschaffungs-/Herstellungskosten (AHK). */
    ahk: z.number().nonnegative(),
    /** Betriebsgewöhnliche Nutzungsdauer in years (linear AfA = AHK / ND). */
    nutzungsdauer_jahre: z.number().positive(),
    /** Restbuchwert at the start of the filing year (Buchwert 01.01.). */
    restbuchwert_anfang: z.number().nonnegative(),
    /** Floor the book value never drops below (1 € Erinnerungswert for kept assets). */
    erinnerungswert: z.number().nonnegative().default(0),
    /** AVEÜR asset class: 'beweglich' (default) or 'gebaeude' (Gebäude/Einbauten). */
    art: z.enum(['beweglich', 'gebaeude']).default('beweglich'),
    /**
     * Did the asset entitle to (full or partial) Vorsteuerabzug when acquired? Absent ⇒ yes (the
     * normal business purchase with a Rechnung). This is the ONLY condition under which its
     * Entnahme at Betriebsaufgabe becomes a taxable unentgeltliche Wertabgabe (§3 Abs. 1b Nr. 1
     * UStG) — set it to `false` for assets bought without Vorsteuer (privately, from a
     * Kleinunternehmer, differenzbesteuert …), which keeps their Entnahme out of the UStE.
     */
    vorsteuerabzug: z.boolean().optional(),
    /**
     * The bookings that paid for the asset (store transaction ids) — set when it is captured from an
     * „Anlagegut?" hint, so that check knows the expense is in the Anlageverzeichnis.
     */
    buchung_ids: z.array(z.string()).optional(),
});

/** Deemed income / unentgeltliche Wertabgabe, e.g. private telephone use (Privatanteil). */
const PrivatanteilSchema = z.object({
    bezeichnung: z.string(),
    /** Net deemed income added as a Betriebseinnahme. */
    netto: z.number(),
    /** USt rate on the deemed supply (default 19 %). */
    ust_satz: z.number().min(0).max(1).default(0.19),
});

/** A per-partner Sonderbetriebsausgabe (e.g. häusliches Arbeitszimmer). */
const SonderbetriebsausgabeSchema = z.object({
    /** Matches a Gesellschafter `id`. */
    gesellschafter_id: z.string(),
    bezeichnung: z.string(),
    betrag: z.number().nonnegative(),
});

/**
 * A nachträgliche Betriebseinnahme/-ausgabe (§24 Nr. 2 EStG): a GbR-related cash flow
 * that arrives AFTER the Betriebsaufgabe (e.g. a late customer payment, a refund of an
 * accidentally double-paid supplier invoice) — typically through the successor entity's
 * account, but still belonging to the former GbR. Booked into the GbR EÜR of
 * the year the money flows (by `datum`), on a cash basis.
 */
const NachtraeglicherPostenSchema = z.object({
    /** When the money actually flowed (YYYY-MM-DD) — scopes it to the filing year. */
    datum: z.string(),
    bezeichnung: z.string(),
    /** Net amount (always positive). */
    netto: z.number().nonnegative(),
    /** 'einnahme' (late revenue / refund received) or 'ausgabe' (late expense paid). */
    art: z.enum(['einnahme', 'ausgabe']),
    /** USt rate (default 19 %); 0 for USt-neutral items. */
    ust_satz: z.number().min(0).max(1).default(0.19),
    /** Optional: the successor-account transaction id this relates to (audit trail / de-dup). */
    quell_transaktion_id: z.string().optional(),
});

/** Per-asset gemeiner Wert at the Betriebsaufgabe (else defaults to the Restbuchwert). */
const GemeinerWertSchema = z.object({
    /** Matches an Anlagegut `id`. */
    anlagegut_id: z.string(),
    gemeiner_wert: z.number().nonnegative(),
});

/**
 * Betriebsaufgabe: the remaining Anlagevermögen is withdrawn to private at gemeiner
 * Wert → Aufgabegewinn/-verlust (§16/§34 EStG), separate from the laufender Gewinn.
 */
const BetriebsaufgabeSchema = z.object({
    /** Aufgabe date (YYYY-MM-DD); defaults to business_end_date if omitted. */
    datum: z.string().optional(),
    gemeine_werte: z.array(GemeinerWertSchema).default([]),
    aufgabekosten: z.number().nonnegative().default(0),
});

/**
 * Year-end adjustments that are NOT derivable from cash transactions: non-cash AfA
 * (Anlageverzeichnis), deemed income (Privatanteile), and partner-level
 * Sonderbetriebsausgaben. Folded into the EÜR / Feststellung at report time.
 */
const AdjustmentsSchema = z.object({
    /** Depreciable assets → AfA. If `afa_override` is set, it wins over the computed AfA. */
    anlageverzeichnis: z.array(AnlagegutSchema).default([]),
    afa_override: z.number().nonnegative().optional(),
    privatanteile: z.array(PrivatanteilSchema).default([]),
    sonderbetriebsausgaben: z.array(SonderbetriebsausgabeSchema).default([]),
    /** Betriebsaufgabe (Aufgabegewinn/-verlust from the remaining Anlagevermögen). */
    betriebsaufgabe: BetriebsaufgabeSchema.optional(),
    /** Nachträgliche Betriebseinnahmen/-ausgaben (§24 Nr. 2 EStG) after the Aufgabe. */
    nachtraegliche_posten: z.array(NachtraeglicherPostenSchema).default([]),
    /**
     * After the Aufgabe, post-cutoff INCOME on the old account stays the GbR's §24 (late
     * payments on GbR invoices), but post-cutoff EXPENSES belong to the successor
     * (Einzelunternehmen) UNLESS their counterparty/purpose matches one of these substrings
     * (the genuine GbR wind-down, e.g. the tax advisor, the studio rent). Case-insensitive.
     */
    nachtraeglich_gbr_ausgaben_gegenseiten: z.array(z.string()).default([]),
    /**
     * Confirmed double payments (a customer paid the same invoice twice): the duplicate
     * receipt is a refund liability, not revenue → neutralised (out of income + USt). The
     * refund may run through a private account. Keyed by the store transaction id.
     */
    doppelzahlungen: z
        .array(
            z.object({
                transaktion_id: z.string(),
                bezeichnung: z.string().default(''),
                /** The invoice that was paid twice / overpaid (id of the invoicing back-end). */
                rechnung_id: z.string().optional(),
                /** The debit that refunded the customer; also neutralised (durchlaufend). Absent = refund still open. */
                rueckzahlung_transaktion_id: z.string().optional(),
                /** ISO date the customer was refunded OUTSIDE the entity's accounts (e.g. privately). */
                rueckzahlung_am: z.string().optional(),
            }),
        )
        .default([]),
    /**
     * Credits the owner has looked at and decided are NOT a double payment, so the detector stops
     * flagging them: `in_ordnung` (legitimate) or `andere_rechnung` (pays another invoice).
     */
    zahlungen_geprueft: z
        .array(
            z.object({
                transaktion_id: z.string(),
                entscheidung: z.enum(['in_ordnung', 'andere_rechnung']),
                rechnung_id: z.string().optional(),
            }),
        )
        .default([]),
});

/**
 * One supplier→category rule: a case-insensitive substring of the booking text and the SKR03
 * category it books to. Checked BEFORE the built-in keyword table, so a user rule wins over a
 * generic keyword that would otherwise catch the same text.
 */
const KlassifizierungRegelSchema = z.object({
    /** Case-insensitive substring of counterparty/purpose/reference/type. */
    muster: z.string().min(1),
    /** Target SKR03 category, exactly as the EÜR spells it (e.g. `4950 Rechts-/Beratungskosten`). */
    kategorie: z.string().min(1),
    /**
     * Transaction ids the rule must leave alone — the bookings deselected in the preview of „Regel aus
     * Auswahl". Optional, so every rule written before keeps its exact shape.
     */
    ausnahmen: z.array(z.string()).optional(),
});

/**
 * One Dokumentregel (Idee 11) for the built-in DMS: a receipt that mentions `muster` gets the sender,
 * document type, category and direction the person decided once. Lives beside the booking rules
 * because it is the same kind of knowledge (WHO a counterparty is, WHAT their paper means) in the
 * same per-entity block — but it is applied ONCE, when a receipt arrives, and the values are then
 * stored on the receipt. Removing a rule therefore never re-classifies anything already filed.
 */
const KlassifizierungBelegRegelSchema = z.object({
    /** Case-insensitive substring of sender + title + file name + the text of the PDF. */
    muster: z.string().min(1),
    /** The sender as it should be written on the receipt (set only when the receipt has none yet). */
    korrespondent: z.string().min(1).optional(),
    /** Document type, free text (e.g. `Eingangsrechnung`). */
    dokumenttyp: z.string().min(1).optional(),
    /** Booking category exactly as the EÜR spells it (e.g. `4920 Telefon`). */
    kategorie: z.string().min(1).optional(),
    /** `incoming` = Ausgabe (Eingangsrechnung), `outgoing` = Einnahme (Ausgangsrechnung). */
    richtung: z.enum(['incoming', 'outgoing']).optional(),
    /** Document ids the rule must leave alone — a receipt where someone took the rule's values back. */
    ausnahmen: z.array(z.string()).optional(),
});

/**
 * One Projektregel (Idee 14): an expense whose text contains `muster` belongs to the project `projekt`.
 * Same shape and matching as the booking rules above — a case-insensitive substring of counterparty +
 * purpose + reference + type, `ausnahmen` the bookings it must leave alone — but it changes no category
 * and no EÜR figure: it only says which project a cost belongs to. A decision of the person on the
 * booking wins over it. Lives here, beside the other rules, because it is the same kind of knowledge.
 */
const KlassifizierungProjektRegelSchema = z.object({
    /** Case-insensitive substring of counterparty/purpose/reference/type. */
    muster: z.string().min(1),
    /** Id of a project of the same entity (`projects[].id`). */
    projekt: z.string().min(1),
    /** Transaction ids the rule must leave alone — the bookings deselected or taken out afterwards. */
    ausnahmen: z.array(z.string()).optional(),
});

/**
 * Classification needles for the transaction-driven EÜR: WHO this user is, who their
 * customers are, and which counterparties they have decided are private.
 *
 * The rule chain in `elster/euer-classify.ts` ships only signals that mean the same thing for
 * everybody — generic banking vocabulary (`Privatentnahme`, `Umbuchung`), the securities terms,
 * and merchant keywords that map to a category for any business (`hosting`, `versicherung`).
 * Everything that encodes a JUDGEMENT about a concrete counterparty belongs here, because it is
 * one user's knowledge and would silently misclassify another user's bookings.
 *
 * All lists are empty by default: an unconfigured user gets the generic chain, which classifies
 * less but never classifies somebody else's counterparties. Every entry is matched
 * case-insensitively as a SUBSTRING of `counterparty + purpose + reference + type`.
 *
 * **Filed years depend on this block.** Removing a needle re-classifies the bookings it used to
 * catch, and thus the EÜR of a year that has already been submitted — treat it like the
 * `adjustments` block: append, do not prune.
 */
const KlassifizierungSchema = z.object({
    /**
     * Own accounts and former firm names. A booking naming one of them is an internal transfer
     * between the user's own accounts (`1360`), not a payment to a third party. Needed because
     * the counterparty a bank prints is often a name the manifest no longer carries (a renamed
     * firm, a sub-account label from another bank).
     */
    eigene_konten: z.array(z.string()).default([]),
    /**
     * Merchants and references confirmed as PRIVATE consumption → Privatentnahme/-einlage
     * (GuV-neutral). This is a judgement, not a fact: the same merchant is a business expense
     * for somebody else (a games studio buys games), which is exactly why it cannot be compiled in.
     */
    privat_gegenseiten: z.array(z.string()).default([]),
    /**
     * Counterparty names of the owner(s)/Gesellschafter — usually the `gesellschafter[].name`
     * values, plus any spelling a bank prints. Their transfers WITHOUT an invoice number are
     * capital movements (Entnahme/Einlage), not revenue or expense.
     */
    gesellschafter_gegenseiten: z.array(z.string()).default([]),
    /**
     * Extra identifiers of a partner's Künstlersozialkasse membership — e.g. the membership
     * number a bank prints instead of the KSK's name. A membership number identifies a natural
     * person and must never be compiled in.
     */
    ksk_kennungen: z.array(z.string()).default([]),
    /**
     * Customer names that mark an incoming payment as revenue (`8400`) even when it carries
     * neither a `Verkaufserlöse` tag nor an invoice number.
     */
    erloes_gegenseiten: z.array(z.string()).default([]),
    /**
     * Supplier→category rules that do NOT generalise: a supplier's personal name, or the customer
     * number a telco prints instead of its own name. Checked before the built-in keyword table.
     */
    aufwand_regeln: z.array(KlassifizierungRegelSchema).default([]),
    /** Dokumentregeln for the built-in DMS (sender → document type, category, direction). */
    beleg_regeln: z.array(KlassifizierungBelegRegelSchema).default([]),
    /** Projektregeln (Idee 14): which expenses belong to which project. Changes no EÜR figure. */
    projekt_regeln: z.array(KlassifizierungProjektRegelSchema).default([]),
});

/** Business identification for the Anlage-EÜR / declaration header. */
const BetriebSchema = z.object({
    name: z.string(),
    strasse: z.string(),
    plz: z.string().regex(/^\d{5}$/, 'must be a 5-digit PLZ'),
    ort: z.string(),
    /** Art des Betriebs/der Tätigkeit (Schwerpunkt). */
    art: z.string(),
    /** Hausnummer (forms that split it from the street, e.g. UStE); else derived from strasse. */
    hausnummer: z.string().optional(),
    /**
     * **Wirtschafts-Identifikationsnummer** (W-IdNr) as the ELSTER forms want it: `DE` + 9 digits,
     * exactly 11 characters. Emitted as E3000401 (UStE) / E4000502 (GewSt); both fields are typed
     * `String_MinL11_MaxL11` with pattern `DE[0-9]{9}`. The UStE asks for it from 2025 on — a
     * missing W-IdNr is an advisory Hinweis (30008), not an error.
     *
     * The *full* W-IdNr additionally carries a 5-digit Unterscheidungsmerkmal per wirtschaftliche
     * Tätigkeit (`DE123456789-00001`) — but that suffix does **not** go in these fields; ELSTER
     * takes the 11-character core only.
     *
     * Looks identical to the {@link ust_idnr} and usually IS: whoever held a USt-IdNr on
     * 30.11.2024 had it declared their W-IdNr by public announcement in the Bundessteuerblatt
     * (effective 03.12.2024, no individual notice). A Kleinunternehmer without a USt-IdNr gets a
     * fresh W-IdNr from the BZSt instead — then the two genuinely differ.
     */
    widnr: z
        .string()
        .regex(
            /^DE\d{9}$/,
            'must be DE + 9 digits (11 chars) — the W-IdNr as ELSTER wants it, WITHOUT the -00001 Unterscheidungsmerkmal',
        )
        .optional(),
    /** Umsatzsteuer-Identifikationsnummer (`DE` + 9 digits) — §14a invoices, reverse charge. */
    ust_idnr: z
        .string()
        .regex(/^DE\d{9}$/, 'must be a USt-IdNr: DE + 9 digits')
        .optional(),
    /** Rechtsform code (E6000602); default 270 = GbR. */
    rechtsform: z.string().optional(),
    /** Einkunftsart code (E6000603); default 2 = Gewerbebetrieb. */
    einkunftsart: z.string().optional(),
});

export const ElsterConfigRawSchema = z.object({
    tax_number: z.string().default(''),
    schema_version: z.number().int().optional(),
    period: ElsterPeriodSchema,
    output_directory: z.string().default(''),
    xsd_path: z.string().optional(),
    business_start_date: z.string().optional(),
    /** Last day of the Unternehmereigenschaft if the business ceased mid-year (YYYY-MM-DD). */
    business_end_date: z.string().optional(),
    deadline_extension_months: z.number().int().nonnegative().optional(),
    /**
     * USt-VA Dauerfristverlängerung (§§ 46–48 UStDV): if granted, every USt-Voranmeldung
     * deadline shifts by exactly one month (a quarterly filer's Q2 then falls on 10 Aug
     * instead of 10 Jul). SEPARATE from `deadline_extension_months` (which is the annual
     * declaration's Fristverlängerung). Defaults to false → the proactive Steuertermine layer
     * shows the earlier base deadline, so it never lulls the user past a real due date.
     */
    ust_dauerfristverlaengerung: z.boolean().default(false),
    /**
     * Versteuerungsart: 'ist' (Ist-Versteuerung — USt arises when payment is received) or
     * 'soll' (Soll-Versteuerung — USt arises on the invoice date). The USt-VA pipeline
     * currently aggregates by payment date and therefore implements 'ist' only.
     */
    taxation_basis: z.enum(['ist', 'soll']).default('ist'),
    eric_home: z.string().optional(),
    /**
     * Absolute path to the ELSTER PKCS#12 certificate (`.pfx`/`.p12`) — the "Zertifikatsdatei" the
     * user signs Mein-ELSTER logins with — used to authenticate a live submission. NOT secret (a file
     * location); the matching PIN is NEVER stored here (it lives in the OS keyring or is prompted).
     */
    keystore_path: z.string().optional(),
    /**
     * The 5-digit ELSTER **Hersteller-ID** (Softwarehersteller-Kennung), required to TRANSMIT via
     * ERiC — even for test cases. Must be requested (free) in the developer area of elster.de; the
     * placeholder `00000` and ELSTER's demo IDs are rejected by the server (a missing/blocked ID
     * surfaces as a `<DatenTeil>`-read error on send). Not needed for local validation.
     */
    hersteller_id: z.string().optional(),
    /** ELSTER `<DatenLieferant>` for the TransferHeader (who transmits) — required alongside hersteller_id for a send. */
    datenlieferant: z.string().optional(),
    test_mode: z.boolean().default(true),
    /** Paperless tag IDs to exclude from USt-VA (e.g. another entity's invoices). */
    exclude_tags: z.array(z.number().int()).default([]),
    /** If set, ONLY include documents that have at least one of these tags. */
    include_tags: z.array(z.number().int()).default([]),
    /** Ledger entity this config files for (ties config → period lock). */
    entity_id: z.string().default('artcode'),
    /** GbR partners + their Beteiligungsquoten (for the Feststellung). */
    gesellschafter: z
        .array(GesellschafterSchema)
        .default([])
        .refine((g) => g.length === 0 || Math.abs(g.reduce((s, p) => s + p.quote, 0) - 1) < 1e-6, {
            message: 'Gesellschafter quotes must sum to 1',
        }),
    /** Gewerbesteuer parameters (Gemeinde, Hebesatz, §8/§9). */
    gewerbe: GewerbeSchema.optional(),
    /** USt-Jahreserklärung parameters. */
    uste: UsteSchema.optional(),
    /** Business identification for the Anlage-EÜR / declaration header. */
    betrieb: BetriebSchema.optional(),
    /** Non-cash year-end adjustments (AfA, Privatanteile, Sonderbetriebsausgaben). */
    adjustments: AdjustmentsSchema.optional(),
    /** Counterparty needles for the transaction-driven EÜR rule chain (own/private/customer). */
    klassifizierung: KlassifizierungSchema.optional(),
    /** Display-only: friendly labels per store accountKey (`camt:DE…`, `qonto:…`) for the web view. */
    account_labels: z.record(z.string(), z.string()).default({}),
});

export type ElsterGesellschafter = z.infer<typeof GesellschafterSchema>;
export type ElsterGewerbe = z.infer<typeof GewerbeSchema>;
export type ElsterUste = z.infer<typeof UsteSchema>;
export type ElsterBetrieb = z.infer<typeof BetriebSchema>;
export type ElsterAnlagegut = z.infer<typeof AnlagegutSchema>;
export type ElsterPrivatanteil = z.infer<typeof PrivatanteilSchema>;
export type ElsterSonderbetriebsausgabe = z.infer<typeof SonderbetriebsausgabeSchema>;
export type ElsterBetriebsaufgabe = z.infer<typeof BetriebsaufgabeSchema>;
export type ElsterNachtraeglicherPosten = z.infer<typeof NachtraeglicherPostenSchema>;
export type ElsterAdjustments = z.infer<typeof AdjustmentsSchema>;
export type ElsterKlassifizierungRegel = z.infer<typeof KlassifizierungRegelSchema>;
export type ElsterKlassifizierungProjektRegel = z.infer<typeof KlassifizierungProjektRegelSchema>;
export type ElsterKlassifizierungBelegRegel = z.infer<typeof KlassifizierungBelegRegelSchema>;
export type ElsterKlassifizierung = z.infer<typeof KlassifizierungSchema>;

export type ElsterPeriod = z.infer<typeof ElsterPeriodSchema>;

export interface ElsterConfig {
    tax_number: string;
    schema_version: number;
    period: ElsterPeriod;
    output_directory: string;
    xsd_path?: string;
    business_start_date?: string;
    /** Last day of the Unternehmereigenschaft if the business ceased mid-year. */
    business_end_date?: string;
    deadline_extension_months?: number;
    /** USt-VA Dauerfristverlängerung granted (§§ 46–48 UStDV) → each Voranmeldung deadline +1 month. */
    ust_dauerfristverlaengerung: boolean;
    /** Versteuerungsart: 'ist' (cash basis, USt on receipt) or 'soll' (accrual, USt on invoice date). Pipeline implements Ist. */
    taxation_basis: 'ist' | 'soll';
    eric_home?: string;
    /** Path to the ELSTER PKCS#12 certificate (.pfx/.p12) for live submission; PIN is never stored here. */
    keystore_path?: string;
    /** 5-digit ELSTER Hersteller-ID (from elster.de developer area) — required to transmit via ERiC. */
    hersteller_id?: string;
    /** ELSTER TransferHeader `<DatenLieferant>` (who transmits) — required alongside hersteller_id for a send. */
    datenlieferant?: string;
    /** Use test server (Testmerker). Default true for safety. */
    test_mode: boolean;
    /** Paperless tag IDs to exclude from USt-VA aggregation. */
    exclude_tags: number[];
    /** If set, ONLY include documents with at least one of these tags. */
    include_tags: number[];
    /** Ledger entity this config files for (ties config → period lock). */
    entity_id: string;
    /** GbR partners + their Beteiligungsquoten (for the Feststellung). */
    gesellschafter: ElsterGesellschafter[];
    /** Gewerbesteuer parameters (Gemeinde, Hebesatz, §8/§9), if configured. */
    gewerbe?: ElsterGewerbe;
    /** USt-Jahreserklärung parameters, if configured. */
    uste?: ElsterUste;
    /** Business identification for the Anlage-EÜR / declaration header. */
    betrieb?: ElsterBetrieb;
    /** Non-cash year-end adjustments (AfA, Privatanteile, Sonderbetriebsausgaben). */
    adjustments?: ElsterAdjustments;
    /** Counterparty needles for the transaction-driven EÜR rule chain (own/private/customer). */
    klassifizierung?: ElsterKlassifizierung;
    /** Display-only: friendly labels per store accountKey for the web Transaktionen view. */
    account_labels: Record<string, string>;
}

/** The inline manifest section is byte-for-byte the same payload as the former elster-config.json. */
export const ElsterSectionSchema = ElsterConfigRawSchema;
export type ElsterSection = z.infer<typeof ElsterSectionSchema>;

/**
 * Apply the env-override + derived-field normalisation to an already schema-parsed ELSTER payload
 * (I/O-free): the ELSTER_TAX_NUMBER env override, the `schema_version ?? period.year` fallback, the
 * `output_directory || <cwd>/elster` default, and trimming the optional path/id strings to undefined.
 *
 * A manifest's inline `elster` section resolves to a byte-for-byte identical {@link ElsterConfig}.
 */
export function normalizeElsterConfig(parsed: z.infer<typeof ElsterConfigRawSchema>): ElsterConfig {
    const taxNumber = process.env.ELSTER_TAX_NUMBER ?? parsed.tax_number;
    const schemaVersion = parsed.schema_version ?? parsed.period.year;
    const outputDir = parsed.output_directory || join(process.cwd(), 'elster');

    return {
        tax_number: taxNumber,
        schema_version: schemaVersion,
        period: parsed.period,
        output_directory: outputDir,
        xsd_path: parsed.xsd_path?.trim() || undefined,
        business_start_date: parsed.business_start_date?.trim() || undefined,
        business_end_date: parsed.business_end_date?.trim() || undefined,
        deadline_extension_months: parsed.deadline_extension_months,
        ust_dauerfristverlaengerung: parsed.ust_dauerfristverlaengerung,
        taxation_basis: parsed.taxation_basis,
        eric_home: parsed.eric_home?.trim() || undefined,
        keystore_path: parsed.keystore_path?.trim() || undefined,
        hersteller_id: parsed.hersteller_id?.trim() || undefined,
        datenlieferant: parsed.datenlieferant?.trim() || undefined,
        test_mode: parsed.test_mode,
        exclude_tags: parsed.exclude_tags,
        include_tags: parsed.include_tags,
        entity_id: parsed.entity_id,
        gesellschafter: parsed.gesellschafter,
        gewerbe: parsed.gewerbe,
        uste: parsed.uste,
        betrieb: parsed.betrieb,
        adjustments: parsed.adjustments,
        klassifizierung: parsed.klassifizierung,
        account_labels: parsed.account_labels,
    };
}

/**
 * Compute date range (YYYY-MM-DD) for the configured period.
 */
export function getPeriodDateRange(period: ElsterPeriod): { dateFrom: string; dateTo: string } {
    const { year, quarter, month } = period;
    if (quarter != null) {
        const startMonth = (quarter - 1) * 3 + 1;
        const endMonth = quarter * 3;
        const dateFrom = `${year}-${String(startMonth).padStart(2, '0')}-01`;
        const lastDay = new Date(year, endMonth, 0).getDate();
        const dateTo = `${year}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        return { dateFrom, dateTo };
    }
    if (month != null) {
        const dateFrom = `${year}-${String(month).padStart(2, '0')}-01`;
        const lastDay = new Date(year, month, 0).getDate();
        const dateTo = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        return { dateFrom, dateTo };
    }
    throw new ConfigError('period must have quarter or month');
}
