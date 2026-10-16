/**
 * The text of the mail that carries an invoice, rendered from a template with `{placeholders}`.
 *
 * Pure: no config reads, no clock. Subject and body are only a PROPOSAL; the dialog shows both and
 * the person edits them before anything leaves the machine, so this module never has to guess well,
 * only to start from something usable.
 *
 * An unknown placeholder is NOT replaced and NOT an error here: {@link unknownMailPlaceholders} names
 * it and the send preview warns before anything leaves, so a `{betrg}` typo cannot reach a customer
 * unnoticed, yet an old template does not stop the dialog from opening.
 */

import { eur, deDate } from '../lib/format.ts';
import { _ } from '../lib/i18n.ts';
import type { MailTemplate } from '../config/schema/mail.ts';
import { defaultClosingFor, type Formality } from '../invoices/header-template.ts';

/** Every placeholder name. Single source for the renderer, the editor list and the manual. */
export const MAIL_PLACEHOLDERS = [
    'anrede',
    'kunde',
    'rechnungsnummer',
    'betrag',
    'netto',
    'datum',
    'faelligkeit',
    'leistungszeitraum',
    'positionen',
    'domain',
    'projekt',
    'zahlungslink',
    'gruss',
    'aussteller',
] as const;
export type MailPlaceholder = (typeof MAIL_PLACEHOLDERS)[number];

/**
 * One line per placeholder for the template editors. A function, not a constant: a module-level
 * literal would be translated at import, before the locale is known. The placeholder NAMES stay
 * German — they are what a saved template writes, and renaming them would break every template.
 */
export function mailPlaceholderHelp(): Record<MailPlaceholder, string> {
    return {
        anrede: _('the full salutation line for du/Sie, with the name from the salutation field if there is one'),
        kunde: _('customer name'),
        rechnungsnummer: _('invoice number'),
        betrag: _('gross amount, e.g. 119,00 €'),
        netto: _('net amount, e.g. 100,00 €'),
        datum: _('invoice date, e.g. 01.03.2026'),
        faelligkeit: _('due date, e.g. 15.03.2026'),
        leistungszeitraum: _('service period, e.g. 01.01.2026 – 31.12.2026'),
        positionen: _('titles of the line items, joined with „und"'),
        domain: _('domains of the contract, joined with „und"; without domains the description'),
        projekt: _('name of the project'),
        zahlungslink: _('public link to view and pay (Qonto)'),
        gruss: _('closing line for du/Sie'),
        aussteller: _('name of the issuer'),
    };
}

/**
 * Placeholders whose line may vanish when there is no value (a `Projekt: {projekt}` line without a
 * project). Everything else is a REQUIRED value: a missing one stays an empty spot in its sentence
 * and is reported by {@link missingMailValues}, so the core sentence never disappears silently.
 * `faelligkeit` is special-cased in the renderer (its clause goes, not the line).
 */
export const OPTIONAL_PLACEHOLDERS: readonly MailPlaceholder[] = [
    'zahlungslink',
    'leistungszeitraum',
    'projekt',
    'positionen',
    'domain',
    'datum',
    'netto',
];
export const REQUIRED_PLACEHOLDERS: readonly MailPlaceholder[] = [
    'anrede',
    'kunde',
    'rechnungsnummer',
    'betrag',
    'gruss',
    'aussteller',
];

/** Older names that still work, so a template written before the rename keeps rendering. */
const ALIASES: Record<string, MailPlaceholder> = { nummer: 'rechnungsnummer', periode: 'leistungszeitraum' };

const canonical = (name: string): MailPlaceholder | undefined => {
    const key = name.trim().toLowerCase();
    if ((MAIL_PLACEHOLDERS as readonly string[]).includes(key)) return key as MailPlaceholder;
    return ALIASES[key];
};

export const DEFAULT_SUBJECT = 'Rechnung {rechnungsnummer}';

export const DEFAULT_BODY_DU = `{anrede}

anbei die Rechnung {rechnungsnummer} über {betrag}, fällig am {faelligkeit}.

Online ansehen und bezahlen: {zahlungslink}

{gruss}
{aussteller}`;

export const DEFAULT_BODY_SIE = `{anrede}

anbei erhalten Sie die Rechnung {rechnungsnummer} über {betrag}, fällig am {faelligkeit}.

Online ansehen und bezahlen: {zahlungslink}

{gruss}
{aussteller}`;

export interface InvoiceMailContext {
    number: string;
    /** Gross total; null renders as an empty amount. */
    total: number | null;
    /** Net total; null renders empty (and drops its line). */
    net?: number | null;
    /** YYYY-MM-DD; null when the invoice has no due date. */
    dueDate: string | null;
    /** Invoice date, YYYY-MM-DD. */
    issueDate?: string | null;
    /** Service period, YYYY-MM-DD both. */
    period?: { start: string; end: string } | null;
    customerName?: string;
    /** Titles of the line items. */
    itemTitles?: readonly string[];
    domains?: readonly string[];
    /** Contract description; the fallback of `{domain}`. */
    description?: string;
    projectName?: string;
    /** Free-form salutation name ("Silke", "Frau Muster"); blank gives the bare salutation. */
    greeting?: string;
    /** `du` (default) or `sie`. */
    formality?: Formality;
    closing?: string;
    issuerName?: string;
    /** Public view-and-pay link of the invoice (Qonto `invoice_url`); absent for the own back-end. */
    paymentUrl?: string | null;
}

const clean = (s: string | undefined): string => (s ?? '').trim();

const joinGerman = (parts: readonly string[] | undefined): string => {
    const list = (parts ?? []).map(clean).filter(Boolean);
    if (list.length <= 1) return list[0] ?? '';
    return `${list.slice(0, -1).join(', ')} und ${list[list.length - 1]}`;
};

/** `Hallo Silke,` / `Guten Tag Frau Muster,`; without a name `Hallo,` / `Guten Tag,` (like the cover letter). */
export function salutation(formality: Formality | undefined, greeting: string | undefined): string {
    const name = clean(greeting);
    if (formality === 'sie') return name ? `Guten Tag ${name},` : 'Guten Tag,';
    return name ? `Hallo ${name},` : 'Hallo,';
}

/** The value of each placeholder for one invoice; a value that does not exist is the empty string. */
export function mailValues(ctx: InvoiceMailContext): Record<MailPlaceholder, string> {
    return {
        anrede: salutation(ctx.formality, ctx.greeting),
        kunde: clean(ctx.customerName),
        rechnungsnummer: clean(ctx.number),
        betrag: ctx.total == null ? '' : eur(ctx.total),
        netto: ctx.net == null ? '' : eur(ctx.net),
        datum: ctx.issueDate ? deDate(ctx.issueDate) : '',
        faelligkeit: ctx.dueDate ? deDate(ctx.dueDate) : '',
        leistungszeitraum: ctx.period ? `${deDate(ctx.period.start)} – ${deDate(ctx.period.end)}` : '',
        positionen: joinGerman(ctx.itemTitles),
        domain: joinGerman(ctx.domains) || clean(ctx.description),
        projekt: clean(ctx.projectName),
        zahlungslink: clean(ctx.paymentUrl ?? undefined),
        gruss: clean(ctx.closing) || defaultClosingFor(ctx.formality),
        aussteller: clean(ctx.issuerName),
    };
}

/** Placeholder names a text uses that {@link MAIL_PLACEHOLDERS} (and its old aliases) do not know (deduplicated). */
export function unknownMailPlaceholders(template: string): string[] {
    const bad = new Set<string>();
    for (const m of template.matchAll(/\{([^{}]*)\}/g)) {
        if (!canonical(m[1])) bad.add(m[1]);
    }
    return [...bad];
}

/**
 * Fill a template. A sentence that cannot be filled (`, fällig am {faelligkeit}` without a due date)
 * is dropped as a whole rather than left dangling; any other line holding a placeholder without a
 * value goes with it (a `Projekt: {projekt}` line without a project), and runs of blank lines are
 * collapsed. A single-line text (the subject) keeps its line and only loses the empty spot.
 * Unknown placeholders stay as typed; see {@link unknownMailPlaceholders}.
 */
export function renderMailTemplate(template: string, ctx: InvoiceMailContext): string {
    const values = mailValues(ctx);
    const multiline = template.includes('\n');
    const withoutDue = values.faelligkeit ? template : template.replace(/,?\s*fällig am\s*\{\s*faelligkeit\s*\}/gi, '');
    const lineEmpty = (line: string): boolean =>
        [...line.matchAll(/\{([^{}]*)\}/g)].some((m) => {
            const key = canonical(m[1]);
            return key !== undefined && OPTIONAL_PLACEHOLDERS.includes(key) && values[key] === '';
        });
    const kept = multiline
        ? withoutDue
              .split('\n')
              .filter((line) => !lineEmpty(line))
              .join('\n')
        : withoutDue;
    const filled = kept
        .replace(/\{([^{}]*)\}/g, (whole, name: string) => {
            const key = canonical(name);
            return key ? values[key] : whole;
        })
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return multiline ? filled : filled.replace(/[ \t]{2,}/g, ' ');
}

/** Required placeholders a text uses whose value is empty for this invoice (deduplicated). */
export function missingMailValues(template: string, ctx: InvoiceMailContext): MailPlaceholder[] {
    const values = mailValues(ctx);
    const missing = new Set<MailPlaceholder>();
    for (const m of template.matchAll(/\{([^{}]*)\}/g)) {
        const key = canonical(m[1]);
        if (key && REQUIRED_PLACEHOLDERS.includes(key) && values[key] === '') missing.add(key);
    }
    return [...missing];
}

export interface InvoiceMailDraft {
    subject: string;
    text: string;
    /** Unknown placeholders in subject or text; non-empty means the person must look before sending. */
    unknown: string[];
    /** Required values that are empty for this invoice; they stay empty in the text. */
    missing: MailPlaceholder[];
}

/** The built-in template, used when an entity has none. */
export const BUILTIN_TEMPLATE_ID = 'standard';
export const BUILTIN_TEMPLATE_NAME = 'Standard';

/** Subject and body of a template for one form of address; Sie falls back to the du text when unset. */
export function templateTexts(
    template: MailTemplate | undefined,
    formality: Formality | undefined,
): { subject: string; body: string } {
    if (!template) {
        return { subject: DEFAULT_SUBJECT, body: formality === 'sie' ? DEFAULT_BODY_SIE : DEFAULT_BODY_DU };
    }
    if (formality === 'sie') {
        return {
            subject: template.subjectSie?.trim() || template.subject,
            body: template.bodySie?.trim() || template.body,
        };
    }
    return { subject: template.subject, body: template.body };
}

/** The proposed subject and body for an invoice; the caller may change both before sending. */
export function buildInvoiceMail(ctx: InvoiceMailContext, template?: MailTemplate): InvoiceMailDraft {
    const texts = templateTexts(template, ctx.formality);
    return {
        subject: renderMailTemplate(texts.subject, ctx),
        text: renderMailTemplate(texts.body, ctx),
        unknown: unknownMailPlaceholders(`${texts.subject}\n${texts.body}`),
        missing: missingMailValues(`${texts.subject}\n${texts.body}`, ctx),
    };
}
