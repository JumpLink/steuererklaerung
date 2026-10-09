/**
 * The cover letter (Anschreiben / Qonto `header`) of a recurring invoice, rendered from a template.
 *
 * Pure: no config reads, no clock. The caller resolves the entity defaults and the issuer name and
 * hands them in, so the same function backs the invoice draft, the `--dry-run` and the live preview
 * in the desktop dialog — a preview that renders differently from the invoice would be worse than none.
 *
 * Unknown placeholders THROW. A `{domian}` typo left standing would go out to a customer verbatim, and
 * nobody rereads a draft for braces.
 */

import type { Project } from '../config/schema/project.ts';
import type { RecurringInvoice } from '../config/schema/recurring.ts';
import { deDate } from '../lib/format.ts';

/** How a customer is addressed. Unset means `du`. */
export type Formality = 'du' | 'sie';

export const DEFAULT_FORMALITY: Formality = 'du';

/** Sign-off when neither the customer nor the entity sets one (du). */
export const DEFAULT_CLOSING = 'Beste Grüße';

/** Sign-off when neither the customer nor the entity sets one (Sie). */
export const DEFAULT_CLOSING_SIE = 'Mit freundlichen Grüßen';

/** Warning text for a template that uses `{anrede}` while neither project nor contract has a greeting. */
export const GREETING_MISSING = 'greeting fehlt';

/** Placeholder → what it stands for. Single source for the renderer, the docs and the editor hint. */
export const HEADER_PLACEHOLDERS = {
    anrede: 'Anrede-Name: Kontaktperson des Projekts, sonst customer.greeting des Vertrags; leer, wenn keiner eingetragen ist',
    kunde: 'Kundenname',
    domain: 'Domains, mit „und" verbunden; ohne Domains die Bezeichnung, sonst der Kundenname',
    periode: 'Leistungszeitraum, z. B. 01.01.2026 – 31.12.2026',
    vorperiode: 'Zeitraum der letzten Rechnung; leer, solange es keine gibt',
    paket: 'Titel der Positionen, mit „und" verbunden',
    gruss: 'Grußformel (customer.closing, sonst Standard der Entität je Anrede-Form, sonst „Beste Grüße" bzw. „Mit freundlichen Grüßen")',
    aussteller: 'Name des Ausstellers (Signatur); leer, wenn keiner konfiguriert ist',
} as const;
export type HeaderPlaceholder = keyof typeof HEADER_PLACEHOLDERS;

/** The default cover letter — shipped in the example manifest and the docs; every schedule may override it. */
export const DEFAULT_HEADER_TEMPLATE = `Hallo {anrede},

anbei die Rechnung für das Hosting {domain} für die Serviceperiode {periode}. Im Paket enthalten sind {paket}. Die Abrechnung erfolgt jährlich im Voraus, die Kündigungsfrist beträgt vier Wochen vor Ende der Laufzeit.

{gruss}
{aussteller}`;

/** The default cover letter for customers addressed with Sie. */
export const DEFAULT_HEADER_TEMPLATE_SIE = `Guten Tag {anrede},

anbei erhalten Sie die Rechnung für das Hosting {domain} für die Serviceperiode {periode} ({paket}). Das Hosting wird jährlich im Voraus abgerechnet, eine Kündigung ist bis vier Wochen vor Ende der Laufzeit möglich.

{gruss}
{aussteller}`;

export interface HeaderContext {
    customerName: string;
    /**
     * Free-form salutation name. Blank renders `{anrede}` empty — the customer name is NOT a fallback,
     * company names often contain a person's name ("Hallo Firma, Person").
     */
    greeting?: string;
    /** `du` (default) or `sie`; decides the fallback sign-off. */
    formality?: Formality;
    /** Sign-off; blank falls back to the default of the {@link formality}. */
    closing?: string;
    domains?: readonly string[];
    /** Schedule description — the fallback for `{domain}` when a schedule lists no domains. */
    description?: string;
    period: { start: string; end: string };
    previousPeriod?: { start: string; end: string };
    itemTitles: readonly string[];
    issuerName?: string;
}

const clean = (s: string | undefined): string => (s ?? '').trim();

/** Fallback sign-off for a form of address. */
export function defaultClosingFor(formality: Formality = DEFAULT_FORMALITY): string {
    return formality === 'sie' ? DEFAULT_CLOSING_SIE : DEFAULT_CLOSING;
}

/** `a`, `a und b`, `a, b und c`. */
export function joinGerman(parts: readonly string[]): string {
    const list = parts.map(clean).filter(Boolean);
    if (list.length <= 1) return list[0] ?? '';
    return `${list.slice(0, -1).join(', ')} und ${list[list.length - 1]}`;
}

const periodText = (p: { start: string; end: string }): string => `${deDate(p.start)} – ${deDate(p.end)}`;

/** The value of each placeholder for one context, with fallbacks so no sentence is left broken. */
export function headerValues(ctx: HeaderContext): Record<HeaderPlaceholder, string> {
    const kunde = clean(ctx.customerName);
    return {
        anrede: clean(ctx.greeting),
        kunde,
        domain: joinGerman(ctx.domains ?? []) || clean(ctx.description) || kunde,
        periode: periodText(ctx.period),
        vorperiode: ctx.previousPeriod ? periodText(ctx.previousPeriod) : '',
        paket: joinGerman(ctx.itemTitles),
        gruss: clean(ctx.closing) || defaultClosingFor(ctx.formality),
        aussteller: clean(ctx.issuerName),
    };
}

/** Placeholder names a template uses that {@link HEADER_PLACEHOLDERS} does not know (deduplicated). */
export function unknownPlaceholders(template: string): string[] {
    const bad = new Set<string>();
    for (const m of template.matchAll(/\{([^{}]*)\}/g)) {
        const name = m[1].trim().toLowerCase();
        if (!(name in HEADER_PLACEHOLDERS)) bad.add(m[1]);
    }
    return [...bad];
}

/** A rendered cover letter plus hints the caller should show (never thrown: the letter is still usable). */
export interface RenderedHeader {
    text: string;
    warnings: string[];
}

/** Matches `{anrede}` (case/blank-tolerant) with the blanks before it, so removing it leaves no gap. */
const ANREDE_WITH_LEADING_BLANKS = /[ \t]*\{\s*anrede\s*\}/gi;
const USES_ANREDE = /\{\s*anrede\s*\}/i;

/**
 * Render `template`. Throws on an unknown placeholder, naming it and the valid ones.
 *
 * Trailing blanks per line are dropped and runs of blank lines collapse to one, so an empty
 * `{aussteller}` does not leave a dangling signature line. Without a greeting `{anrede}` is removed
 * together with the blanks before it: "Hallo {anrede}," becomes "Hallo," — and `warnings` says so.
 */
export function renderHeaderWithWarnings(template: string, ctx: HeaderContext): RenderedHeader {
    const bad = unknownPlaceholders(template);
    if (bad.length) {
        throw new Error(
            `Unbekannter Platzhalter im Anschreiben: ${bad.map((b) => `{${b}}`).join(', ')}. ` +
                `Erlaubt: ${Object.keys(HEADER_PLACEHOLDERS)
                    .map((k) => `{${k}}`)
                    .join(', ')}.`,
        );
    }
    const values = headerValues(ctx);
    const warnings: string[] = [];
    let source = template;
    if (!values.anrede && USES_ANREDE.test(template)) {
        warnings.push(GREETING_MISSING);
        source = template.replace(ANREDE_WITH_LEADING_BLANKS, '');
    }
    const text = source
        .replace(/\{([^{}]*)\}/g, (_, name: string) => values[name.trim().toLowerCase() as HeaderPlaceholder])
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return { text, warnings };
}

/** {@link renderHeaderWithWarnings}, text only. */
export function renderHeader(template: string, ctx: HeaderContext): string {
    return renderHeaderWithWarnings(template, ctx).text;
}

/** What the entity contributes: its default templates + sign-offs per form of address and the issuer's name. */
export interface HeaderEntityDefaults {
    /** Du template (the original, backwards-compatible field). */
    defaultHeader?: string | null;
    defaultClosing?: string | null;
    /** Sie variants. */
    defaultHeaderSie?: string | null;
    defaultClosingSie?: string | null;
    issuerName?: string;
}

/** Where the greeting of a cover letter came from. */
export type AddressingSource = 'project' | 'contract' | 'none';

/** How a cover letter addresses its reader, after the fallback chain. */
export interface Addressing {
    greeting: string;
    formality: Formality;
    greetingFrom: AddressingSource;
}

/**
 * Greeting and form of address of one schedule. Each is resolved on its own, along the same chain:
 * the project's contact person, then the contract's `customer.*`, then nothing (greeting) or `du`
 * (formality). The customer name is never a fallback.
 *
 * Per field and not per block: a project that only names the contact person's `greeting` still
 * inherits the contract's `sie`, instead of silently switching the letter to `du`.
 */
export function resolveAddressing(
    inv: Pick<RecurringInvoice, 'customer'>,
    project?: Pick<Project, 'contactPerson'>,
): Addressing {
    const person = project?.contactPerson;
    const fromProject = clean(person?.greeting);
    const fromContract = clean(inv.customer.greeting);
    return {
        greeting: fromProject || fromContract,
        formality: person?.formality ?? inv.customer.formality ?? DEFAULT_FORMALITY,
        greetingFrom: fromProject ? 'project' : fromContract ? 'contract' : 'none',
    };
}

/**
 * Schedule.header (both forms) > entity default of the form > none (blank counts as unset).
 * `formality` is the resolved form of address ({@link resolveAddressing}); without it the contract's own is used.
 */
export function pickHeaderTemplate(
    schedule: Pick<RecurringInvoice, 'header'> & { customer?: { formality?: Formality } },
    defaults: HeaderEntityDefaults,
    formality: Formality | undefined = schedule.customer?.formality,
): string | undefined {
    const entityDefault = formality === 'sie' ? defaults.defaultHeaderSie : defaults.defaultHeader;
    return clean(schedule.header) || clean(entityDefault ?? undefined) || undefined;
}

/** The {@link HeaderContext} of one schedule (customer closing wins over the entity's of the same form). */
export function headerContextFor(
    inv: RecurringInvoice,
    defaults: HeaderEntityDefaults,
    project?: Pick<Project, 'contactPerson'>,
): HeaderContext {
    const { greeting, formality } = resolveAddressing(inv, project);
    const entityClosing = formality === 'sie' ? defaults.defaultClosingSie : defaults.defaultClosing;
    return {
        customerName: inv.customer.name,
        greeting,
        formality,
        closing: clean(inv.customer.closing) || clean(entityClosing ?? undefined),
        domains: inv.domains,
        description: inv.description,
        period: inv.nextPeriod,
        previousPeriod: inv.lastInvoice?.period,
        itemTitles: inv.items.map((i) => i.title),
        issuerName: defaults.issuerName,
    };
}

/** Render a schedule's cover letter with its warnings, or `undefined` when no template applies. */
export function buildHeaderWithWarnings(
    inv: RecurringInvoice,
    defaults: HeaderEntityDefaults,
    project?: Pick<Project, 'contactPerson'>,
): RenderedHeader | undefined {
    const template = pickHeaderTemplate(inv, defaults, resolveAddressing(inv, project).formality);
    return template ? renderHeaderWithWarnings(template, headerContextFor(inv, defaults, project)) : undefined;
}

/** Render a schedule's cover letter, or `undefined` when neither it nor the entity has a template. */
export function buildHeader(
    inv: RecurringInvoice,
    defaults: HeaderEntityDefaults,
    project?: Pick<Project, 'contactPerson'>,
): string | undefined {
    return buildHeaderWithWarnings(inv, defaults, project)?.text;
}
