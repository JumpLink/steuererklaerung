/**
 * Manifest section schema: an entity's inline `recurring` block (the former standalone
 * recurring-invoices.json, grouped per entity).
 *
 * This module OWNS the recurring-invoice schema, its inferred types, and the {@link dueDateOf} helper.
 * The standalone `recurring-invoices.ts` loader is gone; each schedule now lives under the entity that
 * issues it. The nested {@link RecurringEntrySchema} drops the (now implicit) `entityId`; the flat
 * {@link RecurringInvoiceSchema} keeps it for the actions that re-attach the owning entity's id.
 *
 * Qonto cannot model recurrence via its public API (only one-off client_invoices), so the recurrence +
 * reminder logic lives here regardless of the configured invoicing back-end.
 */

import { z } from 'zod';

/** A single line item on the recurring invoice (net unit price + VAT rate). */
const RecurringItemSchema = z.object({
    /** Shown in bold on the invoice, max 40 chars (Qonto limit). */
    title: z.string().min(1).max(40),
    description: z.string().optional(),
    /** Decimal quantity; default 1. */
    quantity: z.union([z.string(), z.number()]).default(1),
    /** Unit label, e.g. "Jahr", "Monat", "Stück". */
    unit: z.string().optional(),
    /** Net unit price (e.g. 108 or "108.00"). */
    unitPrice: z.union([z.string(), z.number()]),
    /** VAT rate as percent (19) or decimal (0.19); default 19. */
    vatRate: z.union([z.string(), z.number()]).default(19),
});
export type RecurringItem = z.infer<typeof RecurringItemSchema>;

/** Service period (inclusive) covered by an invoice. */
const PeriodSchema = z.object({
    /** First day of the service period (YYYY-MM-DD). */
    start: z.string(),
    /** Last day of the service period (YYYY-MM-DD). */
    end: z.string(),
});
export type InvoicePeriod = z.infer<typeof PeriodSchema>;

/** The most recently issued invoice for a schedule — used to advance it and for the audit trail. */
const LastInvoiceSchema = z.object({
    /** Human invoice number, e.g. "RE-00042". */
    number: z.string().optional(),
    /** Issue date (YYYY-MM-DD). */
    issueDate: z.string(),
    /** Period this invoice billed. */
    period: PeriodSchema.optional(),
    /** Back-end record id (e.g. the Qonto client_invoice id). */
    providerId: z.string().optional(),
    /** Hosted PDF link (Qonto invoice_url), if any. */
    url: z.string().optional(),
    /** When the invoice was mailed (ISO 8601). Written only after the server accepted it. */
    sentAt: z.string().optional(),
    /** Recipient addresses of that mail. */
    sentTo: z.array(z.string()).optional(),
    /** Message-ID the server assigned; no credentials, no body. */
    messageId: z.string().optional(),
});
export type LastInvoice = z.infer<typeof LastInvoiceSchema>;

/** One recurring billing relationship (flat form — carries the issuing entity id). */
export const RecurringInvoiceSchema = z.object({
    /** Stable slug, e.g. "musterkunde-example-com". */
    id: z.string().min(1),
    /** Which workspace entity issues this invoice (matches steuererklaerung.json entity id). */
    entityId: z.string().min(1).default('jumplink'),
    /** active = remind + create; paused = keep but don't remind; cancelled = archived. */
    status: z.enum(['active', 'paused', 'cancelled']).default('active'),
    customer: z.object({
        /** Display name, e.g. "Musterkunde GmbH & Co. KG". */
        name: z.string().min(1),
        /** Link to the unified contact (preferred). The Qonto client id is resolved via its link. */
        contactId: z.string().optional(),
        /** Legacy/explicit Qonto client id — used directly if set; otherwise resolved from contactId. */
        qontoClientId: z.string().optional(),
        /** Recipient email for the reminder draft / invoice send. */
        email: z.string().optional(),
        /**
         * Free-form salutation name for the cover letter's `{anrede}`, e.g. "Silke" or "Markus, moin
         * Frederik". Free text on purpose: we never guess a gender from a name. The project's contact
         * person wins over it; with neither, `{anrede}` renders empty (the customer name is not a
         * fallback: company names often contain a person's name).
         */
        greeting: z.string().optional(),
        /** How the customer is addressed: `du` or `sie`. The project's contact person wins; unset = `du`. Picks the entity's default text. */
        formality: z.enum(['du', 'sie']).optional(),
        /** Sign-off for `{gruss}`, e.g. "Beste Grüße". Falls back to the entity's default closing of the same form. */
        closing: z.string().optional(),
    }),
    /**
     * The project this contract belongs to (id from the entity's `projects`). Optional: a contract
     * without one behaves as before. The project must be one of the SAME customer.
     */
    projectId: z.string().min(1).optional(),
    /** Mail template (id from the entity's `mailTemplates`) for this contract; wins over the project's and the entity's. */
    mailTemplateId: z.string().min(1).optional(),
    /** Short label, e.g. "Website Hosting example.com". */
    description: z.string().optional(),
    /** Domains this billing covers (documentation + future project matching). */
    domains: z.array(z.string()).default([]),
    /** Billing interval in months (12 = yearly, 3 = quarterly, 1 = monthly). */
    intervalMonths: z.number().int().positive().default(12),
    /** The service period the NEXT invoice will bill. */
    nextPeriod: PeriodSchema,
    /**
     * When the next invoice should be ISSUED (YYYY-MM-DD). Optional — defaults to the start of
     * nextPeriod (hosting is billed yearly in advance, so issue date = period start).
     */
    nextDueDate: z.string().optional(),
    /** Remind this many days before the due date (default 28 = the 4-week cancellation window). */
    reminderLeadDays: z.number().int().nonnegative().default(28),
    /** Payment term in days; falls back to the entity's invoicing default, then 15. */
    paymentTermsDays: z.number().int().positive().optional(),
    currency: z.string().default('EUR'),
    items: z.array(RecurringItemSchema).min(1),
    /**
     * Cover letter (Anschreiben) template printed above the line items, with `{placeholders}` — see
     * `core/invoices/header-template.ts`. Wins over the entity's `invoicing.defaultHeader`.
     */
    header: z.string().optional(),
    /** Most recently issued invoice (advances the schedule on create). */
    lastInvoice: LastInvoiceSchema.optional(),
    notes: z.string().optional(),
});
export type RecurringInvoice = z.infer<typeof RecurringInvoiceSchema>;

/** A single recurring invoice WITHOUT the (now implicit) `entityId` — the inline manifest form. */
export const RecurringEntrySchema = RecurringInvoiceSchema.omit({ entityId: true });
export type RecurringEntry = z.infer<typeof RecurringEntrySchema>;

/** An entity's recurring invoices = a plain array of {@link RecurringEntrySchema}. */
export const RecurringSectionSchema = z.array(RecurringEntrySchema);
export type RecurringSection = z.infer<typeof RecurringSectionSchema>;

/** The issue date for a schedule: explicit nextDueDate, else the start of nextPeriod. */
export function dueDateOf(inv: RecurringInvoice): string {
    return inv.nextDueDate ?? inv.nextPeriod.start;
}
