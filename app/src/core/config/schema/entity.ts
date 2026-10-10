/**
 * Manifest entity schema — one legal entity (a GbR, an Einzelunternehmen, the private household, …)
 * with its display name, kind, the account-key globs that route transactions to it, its
 * document-management + invoicing back-ends, and the inline `elster` / `est` / `finanzierung` /
 * `recurring` sections that used to live in satellite files.
 *
 * This module OWNS the entity schema (the former workspace `EntitySchema`, minus the two dead path
 * fields `elster_config`/`est_config` which are now inline sections) plus the DMS / invoicing / issuer
 * schemas. The standalone `workspace.ts` loader is gone.
 */

import { z } from 'zod';
import { ElsterSectionSchema } from './elster.ts';
import { EstSectionSchema } from './est.ts';
import { FinanzierungSectionSchema } from './finanzierung.ts';
import { MailAccountSchema, MailTemplateSchema } from './mail.ts';
import { MailEingangSchema } from './mail-eingang.ts';
import { ProjectSectionSchema } from './project.ts';
import { RecurringSectionSchema } from './recurring.ts';

/** Tax modules an entity can switch on; 'none' = bookkeeping only. Austria ('at') is planned. */
export const TAX_MODULES = ['de', 'none'] as const;
export type TaxModuleId = (typeof TAX_MODULES)[number];

const isCountryCode = (s: string): boolean => /^[A-Z]{2}$/.test(s);

/**
 * Per-entity document-management config. `builtin` (the default) uses the dependency-free
 * local DMS; `paperless` points at a Paperless-ngx instance. The token is a secret — it
 * lives in the gitignored manifest and is never echoed back to the client (see loadEntityDms).
 * Omitting `paperless.url`/`token` falls back to the global PAPERLESS_* env vars.
 */
const DmsConfigSchema = z.object({
    type: z.enum(['builtin', 'paperless']).default('builtin'),
    paperless: z
        .object({
            url: z.string().optional(),
            token: z.string().optional(),
        })
        .optional(),
    /** Mail folder the built-in DMS fetches receipts from (Idee 15); Paperless has its own mail rules. */
    mailEingang: MailEingangSchema.optional(),
});
export type EntityDmsConfig = z.infer<typeof DmsConfigSchema>;

/**
 * Aussteller (issuer) identity printed on a self-generated invoice + carried into the XRechnung.
 * §14 UStG requires the issuer's name + address and EITHER taxNumber OR vatId (checked at
 * finalize). Fields left blank fall back to the entity's ELSTER config (betrieb + tax_number);
 * kleinunternehmer, bank details, contact lines and the logo only live here.
 */
const IssuerConfigSchema = z.object({
    name: z.string().optional(),
    /** Sign-off line for cover emails and letters (`{aussteller}`); falls back to `name`. */
    signature: z.string().optional(),
    /** Street + house number, one line. */
    address: z.string().optional(),
    zip: z.string().optional(),
    city: z.string().optional(),
    countryCode: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    website: z.string().optional(),
    /** Steuernummer (display format). One of taxNumber/vatId is required at finalize. */
    taxNumber: z.string().optional(),
    /** USt-IdNr. */
    vatId: z.string().optional(),
    /** §19 UStG small-business: no VAT is shown and the §19 note is required. */
    kleinunternehmer: z.boolean().optional(),
    bank: z
        .object({
            iban: z.string().optional(),
            bic: z.string().optional(),
            bankName: z.string().optional(),
            accountHolder: z.string().optional(),
        })
        .optional(),
    /** PNG letterhead logo path (relative to cwd) for the PDF. */
    logoPath: z.string().optional(),
});
export type IssuerConfig = z.infer<typeof IssuerConfigSchema>;

/**
 * Per-entity invoicing back-end for OUTGOING (customer) invoices, e.g. the recurring
 * hosting invoices. `qonto` drafts the invoice via the Qonto client-invoices API for human
 * review/send; `self` generates the invoice locally (own number range + PDF). When omitted the
 * type follows the entity's accounts (see `resolveInvoicingType`): `qonto` with a `qonto:`
 * account, else `self` — the Qonto credentials are global, so an entity without its own Qonto
 * account must never inherit another entity's invoices.
 * The `iban` is the OWN account the customer pays to; when omitted it falls back to the
 * QONTO_IBAN / BILLING_IBAN env var.
 */
const InvoicingConfigSchema = z.object({
    type: z.enum(['qonto', 'self']).optional(),
    /** Own IBAN the customer pays to. Falls back to QONTO_IBAN / BILLING_IBAN env when absent. */
    iban: z.string().optional(),
    /** Default payment term in days for schedules that don't set their own. */
    paymentTermsDays: z.number().int().positive().optional(),
    /** Default cover-letter template (with `{placeholders}`) for schedules without their own `header`; the du variant. */
    defaultHeader: z.string().optional(),
    /** Default sign-off for `{gruss}` when a du customer sets no `closing`. */
    defaultClosing: z.string().optional(),
    /** Like `defaultHeader`, for customers with `formality: 'sie'`. */
    defaultHeaderSie: z.string().optional(),
    /** Like `defaultClosing`, for customers with `formality: 'sie'`. */
    defaultClosingSie: z.string().optional(),
    /** SMTP account for sending invoices by mail. The password is NOT stored here (OS keyring). */
    mail: MailAccountSchema.optional(),
    /** Named invoice-mail templates. Without any, the built-in text is used. */
    mailTemplates: z.array(MailTemplateSchema).optional(),
    /** Id of the template used when neither the contract nor its project names one. */
    defaultMailTemplate: z.string().optional(),
    /** Self-provider settings: own PDF + number range + issuer identity. */
    self: z
        .object({
            /** Prefix for the local invoice number range, e.g. "RE-". */
            numberPrefix: z.string().optional(),
            /** Aussteller identity for §14 / XRechnung (falls back to the ELSTER betrieb). */
            issuer: IssuerConfigSchema.optional(),
        })
        .optional(),
});
export type EntityInvoicingConfig = z.infer<typeof InvoicingConfigSchema>;

/**
 * A Hinweis the owner marked „in Ordnung" — keyed by hint key and year, and bound to the finding's
 * fingerprint (its affected ids): when the finding changes, the hint is back. A decision about a
 * hint, not about the books, so it lives on the entity rather than in `elster.adjustments` (a
 * `privat` entity has hints too, and no ELSTER section).
 */
const HinweisGeprueftSchema = z.object({
    hinweis: z.string().min(1),
    jahr: z.number().int(),
    fingerprint: z.string().min(1),
    /** ISO date of the decision. */
    geprueft_am: z.string().optional(),
});
export type HinweisGeprueft = z.infer<typeof HinweisGeprueftSchema>;

/**
 * The owner's decision on one series of laufende Kosten (Idee 8, `elster/laufende-kosten.ts`), keyed by
 * the series key (normalised recipient + interval). Like {@link HinweisGeprueftSchema} a decision about
 * money flows, not about the books: it changes no figure of the EÜR, a `privat` entity has rent and
 * insurance too, so it lives on the entity and not in `elster.adjustments`.
 */
const LaufendeKostenEntscheidungSchema = z.object({
    key: z.string().min(1),
    /** bestaetigt = counts as laufende Kosten · abgelehnt = „keine laufenden Kosten" · beendet = stopped. */
    status: z.enum(['bestaetigt', 'abgelehnt', 'beendet']),
    /** Corrected interval (only with bestaetigt). */
    abstand: z.enum(['monatlich', 'vierteljaehrlich', 'halbjaehrlich', 'jaehrlich']).optional(),
    /** Corrected amount in EUR, positive (only with bestaetigt). */
    betrag: z.number().positive().optional(),
    /** ISO date of the decision. */
    entschieden_am: z.string().optional(),
});
export type LaufendeKostenEntscheidung = z.infer<typeof LaufendeKostenEntscheidungSchema>;

/** One legal entity: a firm, an Einzelunternehmen, or the private household. */
export const ManifestEntitySchema = z.object({
    /** Stable id used in the API (`?entity=`) and localStorage. */
    id: z.string().min(1),
    /** Display name shown in the switcher + header. */
    name: z.string().min(1),
    /** Free-form kind for display/grouping (gbr · einzelunternehmen · privat · …). */
    kind: z.string().default('einzelunternehmen'),
    /**
     * Account-key globs that belong to this entity. A trailing `*` is a prefix match
     * (`camt:*`, `qonto:01234567*`), otherwise an exact store account key.
     */
    accounts: z.array(z.string()).default([]),
    /** Which document-management back-end this entity uses (default: built-in). */
    dms: DmsConfigSchema.optional(),
    /** Which back-end issues this entity's outgoing/recurring invoices (default: Qonto). */
    invoicing: InvoicingConfigSchema.optional(),
    /**
     * Marks this entity as DEMO data (fictional — the design's "Fischer & Weber GbR").
     * Its accounts live under the `demo:` namespace so they never collide with real store
     * data; both UIs show a persistent "Demodaten" banner and it is kept out of real ELSTER
     * filings. Ships under app/demo/ and is seeded via `steuer demo seed`.
     */
    demo: z.boolean().optional(),
    /**
     * Where this entity is taxed (ISO 3166-1 alpha-2). Missing = 'DE', which every manifest
     * written before the field existed means. Not the issuer's postal `countryCode`. Kept
     * optional (no `.default()`) so a re-serialised manifest stays byte-identical; read it
     * through `countryOf()`. See docs/adr/0001-country-modules-and-per-entity-tax-switch.md.
     */
    country: z.string().refine(isCountryCode, 'ISO 3166-1 alpha-2, e.g. DE').optional(),
    /**
     * Which country module's tax features are on. 'none' = bookkeeping only. Missing = the
     * country's own module ('de' for DE). Read it through `taxModuleOf()`.
     */
    taxModule: z.enum(TAX_MODULES).optional(),
    /** Inline ELSTER config (was the file `elster_config` pointed at); omitted ⇒ no tax reports. */
    elster: ElsterSectionSchema.optional(),
    /** Inline private-ESt config (was the file `est_config` pointed at); omitted ⇒ no ESt estimate. */
    est: EstSectionSchema.optional(),
    /** Inline Immobilien-/Sanierungsfinanzierung; omitted ⇒ no financing plan for this entity. */
    finanzierung: FinanzierungSectionSchema.optional(),
    /** Recurring outgoing invoices issued by this entity (grouped from recurring-invoices.json). */
    recurring: RecurringSectionSchema.optional(),
    /** Customer projects: what time is tracked on and which recurring invoices belong together. */
    projects: ProjectSectionSchema.optional(),
    /** Hinweise marked „in Ordnung" (see HinweisGeprueftSchema). */
    hinweise_geprueft: z.array(HinweisGeprueftSchema).optional(),
    /** Decisions on detected laufende Kosten (see LaufendeKostenEntscheidungSchema). */
    laufende_kosten: z.array(LaufendeKostenEntscheidungSchema).optional(),
});
export type ManifestEntity = z.infer<typeof ManifestEntitySchema>;
