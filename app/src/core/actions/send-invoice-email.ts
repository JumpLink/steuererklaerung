/**
 * Mail an outgoing invoice to the customer — as a preview first, sent only on explicit confirmation.
 *
 * `sendInvoiceEmail(req, { confirm: false })` builds exactly what would go out (recipient, subject,
 * text, attachment name + size) and touches nothing: no connection, no log. Only `confirm: true`
 * sends, once, through the injected {@link MailSender}. There is no code path that sends without
 * that flag, and no caller that sets it on its own: the desktop dialog sets it after the person has
 * looked at the preview and confirmed.
 *
 * Core stays free of `gi://` and of any SMTP library: the sender, the PDF source and the log
 * writer arrive as {@link SendInvoiceEmailDeps}. {@link defaultInvoiceMailDeps} wires the PDF and the
 * manifest; the sender comes from the frontend (see `core/mail/mail-sender.ts` for why).
 */

import {
    loadEntityInvoicing,
    loadProjects,
    loadRecurringInvoices,
    saveRecurringInvoices,
    type MailAccountConfig,
} from '../config/index.ts';
import { resolveAddressing, type Formality } from '../invoices/header-template.ts';
import type { LastInvoice, RecurringInvoice } from '../config/schema/recurring.ts';
import type { OutgoingInvoiceFile } from '../invoices/provider.ts';
import {
    ledgerDbExists,
    ledgerDbPath,
    listEntityInvoiceMails,
    listInvoiceMails,
    migrate,
    openLedger,
    recordInvoiceMail,
    type InvoiceMailInput,
    type InvoiceMailRecord,
    type LedgerDatabase,
} from '@steuererklaerung/store';
import type { MailTemplate } from '../config/schema/mail.ts';
import type { MailSender, OutgoingMessage, SendResult, SmtpAccount } from '../mail/mail-sender.ts';
import {
    BUILTIN_TEMPLATE_ID,
    buildInvoiceMail,
    unknownMailPlaceholders,
    type InvoiceMailDraft,
} from '../mail/invoice-mail.ts';
import { getOutgoingInvoicePdfBytes } from './outgoing-invoices.ts';

export interface InvoiceMailRequest {
    entityId: string;
    /** Back-end record id of the invoice (the key the log is filed under). */
    invoiceId: string;
    /** Human invoice number; also matches the log to a schedule when the back-end id is unknown. */
    invoiceNumber: string | null;
    /** Sender address for the From header. */
    from: string;
    to: string[];
    subject: string;
    text: string;
    account: SmtpAccount;
}

/** What would be sent. Carries no credentials, so a frontend may show or log it freely. */
export interface InvoiceMailPreview {
    from: string;
    to: string[];
    subject: string;
    text: string;
    attachment: { filename: string; size: number };
    /** Placeholders in subject or text that nothing fills; the person must look before sending. */
    unknownPlaceholders: string[];
}

/** What is written to the invoice after a successful send — and nothing else. */
export interface SentLog {
    sentAt: string;
    sentTo: string[];
    messageId: string;
}

export type SendInvoiceEmailResult =
    | { status: 'preview'; preview: InvoiceMailPreview }
    | {
          status: 'sent';
          preview: InvoiceMailPreview;
          log: SentLog;
          /** The server accepted the mail, but the log could not be written; do NOT send again. */
          logError?: string;
          rejected: string[];
      };

export interface SendInvoiceEmailDeps {
    sender: MailSender;
    /** The invoice PDF as bytes; null/URL means there is nothing to attach. */
    loadPdf(): Promise<OutgoingInvoiceFile | null>;
    /** Write the log onto the invoice. Optional so a dry caller can skip persistence. */
    recordSent?(log: SentLog): Promise<void> | void;
    /** Append one attempt (sent or failed) to the invoice's mail history. */
    recordAttempt?(attempt: MailAttempt): Promise<void> | void;
    now?(): Date;
}

/** One send attempt as the history stores it: metadata only, never the text or a credential. */
export type MailAttempt = Omit<InvoiceMailInput, 'entityId' | 'invoiceId' | 'invoiceNumber'>;

const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const LINE_BREAK = /[\r\n]/;

/** Reject what would turn a form field into extra mail headers or a malformed envelope. */
function validate(req: InvoiceMailRequest): void {
    if (!ADDRESS.test(req.from)) throw new Error('Absenderadresse ist ungültig.');
    if (!req.to.length) throw new Error('Kein Empfänger angegeben.');
    for (const a of req.to) if (!ADDRESS.test(a)) throw new Error(`Empfängeradresse ist ungültig: ${a}`);
    if (!req.subject.trim()) throw new Error('Der Betreff ist leer.');
    if (LINE_BREAK.test(req.subject)) throw new Error('Der Betreff darf keinen Zeilenumbruch enthalten.');
}

/** Replace every secret of the account in a message, so an error text can be shown and logged. */
function redact(text: string, account: SmtpAccount): string {
    const secret = account.auth.kind === 'password' ? account.auth.password : account.auth.accessToken;
    return secret ? text.split(secret).join('***') : text;
}

export async function sendInvoiceEmail(
    req: InvoiceMailRequest,
    opts: { confirm: boolean; allowUnknownPlaceholders?: boolean },
    deps: SendInvoiceEmailDeps,
): Promise<SendInvoiceEmailResult> {
    validate(req);
    const pdf = await deps.loadPdf();
    if (!pdf) throw new Error('Zur Rechnung gibt es kein PDF zum Anhängen.');
    if (pdf.kind !== 'bytes') throw new Error('Das PDF liegt nur gehostet vor und lässt sich nicht anhängen.');

    const preview: InvoiceMailPreview = {
        from: req.from,
        to: [...req.to],
        subject: req.subject,
        text: req.text,
        attachment: { filename: pdf.filename, size: pdf.bytes.byteLength },
        unknownPlaceholders: unknownMailPlaceholders(`${req.subject}\n${req.text}`),
    };
    if (opts.confirm !== true) return { status: 'preview', preview };
    if (preview.unknownPlaceholders.length && opts.allowUnknownPlaceholders !== true) {
        throw new Error(
            `Nicht gesendet: unbekannte Platzhalter ${preview.unknownPlaceholders.map((p) => `{${p}}`).join(', ')} in Betreff oder Text. Bitte korrigieren.`,
        );
    }

    const message: OutgoingMessage = {
        from: req.from,
        to: req.to,
        subject: req.subject,
        text: req.text,
        attachments: [{ filename: pdf.filename, content: pdf.bytes, contentType: 'application/pdf' }],
    };
    let sent: SendResult;
    try {
        sent = await deps.sender.send(req.account, message);
    } catch (err) {
        // Only the message survives: the original error may carry the connection or the login.
        const reason = redact(err instanceof Error ? err.message : String(err), req.account);
        try {
            await deps.recordAttempt?.({
                at: (deps.now?.() ?? new Date()).toISOString(),
                from: req.from,
                to: req.to,
                subject: req.subject,
                messageId: null,
                result: 'failed',
                error: reason,
            });
        } catch {
            // The failure itself is what the caller must see.
        }
        throw new Error(`Versand fehlgeschlagen: ${reason}`);
    }

    const log: SentLog = {
        sentAt: (deps.now?.() ?? new Date()).toISOString(),
        sentTo: sent.accepted.length ? sent.accepted : req.to,
        messageId: sent.messageId,
    };
    const errors: string[] = [];
    const attempt = async (fn: (() => Promise<void> | void) | undefined): Promise<void> => {
        try {
            await fn?.();
        } catch (err) {
            errors.push(redact(err instanceof Error ? err.message : String(err), req.account));
        }
    };
    // Independent writes: a failing manifest must not keep the history row from being written.
    await attempt(() => deps.recordSent?.(log));
    await attempt(() =>
        deps.recordAttempt?.({
            at: log.sentAt,
            from: req.from,
            to: log.sentTo,
            subject: req.subject,
            messageId: log.messageId,
            result: 'sent',
            error: null,
        }),
    );
    const logError = errors.length ? errors.join('; ') : undefined;
    return { status: 'sent', preview, log, rejected: sent.rejected, ...(logError ? { logError } : {}) };
}

/** The schedule whose `lastInvoice` is this invoice, by back-end id or, failing that, by number. */
function issuingSchedule(
    schedules: RecurringInvoice[],
    entityId: string,
    ref: { invoiceId: string; invoiceNumber: string | null },
): number {
    return schedules.findIndex((s) => {
        if (s.entityId !== entityId || !s.lastInvoice) return false;
        const last: LastInvoice = s.lastInvoice;
        return last.providerId === ref.invoiceId || (!!ref.invoiceNumber && last.number === ref.invoiceNumber);
    });
}

/**
 * Put the log on the schedule whose `lastInvoice` is this invoice. Pure; null when none matches
 * (a one-off invoice has no schedule, and then the log lives only in the result and the UI).
 */
export function applySentLog(
    schedules: RecurringInvoice[],
    entityId: string,
    ref: { invoiceId: string; invoiceNumber: string | null },
    log: SentLog,
): RecurringInvoice[] | null {
    const index = issuingSchedule(schedules, entityId, ref);
    if (index < 0) return null;
    const next = [...schedules];
    next[index] = { ...next[index], lastInvoice: { ...next[index].lastInvoice!, ...log } };
    return next;
}

/** What the dialog starts from; every value stays editable there. */
export interface InvoiceMailSetup {
    account: MailAccountConfig | null;
    recipient: string;
    greeting: string;
    formality: Formality;
    closing: string;
    issuerName: string;
    /** The last send of this invoice, when it has been mailed before. */
    lastSent: { sentAt: string; sentTo: string[] } | null;
    /** Every send attempt of this invoice from the ledger, newest first (failures included). */
    history: InvoiceMailRecord[];
    /** The entity's named templates; empty means only the built-in text. */
    templates: MailTemplate[];
    /** The template to start from: contract → project → entity default → built-in. */
    templateId: string;
    /** What the contract and project add to the placeholders. */
    facts: ScheduleMailFacts;
}

/** Placeholder values that come from the contract and its project rather than from the invoice. */
export interface ScheduleMailFacts {
    customerName: string;
    domains: string[];
    description: string;
    projectName: string;
    itemTitles: string[];
}

/** Open the ledger for a read or write of the history, closing it again. */
function withLedger<T>(fn: (db: LedgerDatabase) => T): T {
    const db = openLedger(ledgerDbPath());
    try {
        migrate(db);
        return fn(db);
    } finally {
        db.close();
    }
}

/**
 * The template an invoice starts from: the contract's own, else its project's, else the entity
 * default; an id that no longer exists is skipped, so a deleted template falls through to the next.
 */
export function pickTemplateId(
    templates: readonly MailTemplate[],
    ...candidates: (string | null | undefined)[]
): string {
    for (const id of candidates) if (id && templates.some((t) => t.id === id)) return id;
    return BUILTIN_TEMPLATE_ID;
}

/** The mail history of one invoice; empty when the ledger does not exist yet (nothing was ever sent). */
export function loadInvoiceMailHistory(entityId: string, invoiceId: string): InvoiceMailRecord[] {
    if (!ledgerDbExists()) return [];
    return withLedger((db) => listInvoiceMails(db, entityId, invoiceId));
}

/** The latest attempt per invoice id of an entity, for the list badges (one query). */
export function loadEntityMailStatus(entityId: string): Map<string, InvoiceMailRecord> {
    const latest = new Map<string, InvoiceMailRecord>();
    if (!ledgerDbExists()) return latest;
    for (const rec of withLedger((db) => listEntityInvoiceMails(db, entityId)))
        if (!latest.has(rec.invoiceId)) latest.set(rec.invoiceId, rec);
    return latest;
}

/**
 * Invoices mailed before the history table existed leave only `lastInvoice.sentAt/sentTo` on their
 * contract. Add a synthetic "sent" record for each listed invoice such a contract points at (by
 * back-end id, else by number, like `applySentLog`), unless the ledger already knows that invoice.
 * Pure.
 */
export function withLegacySent(
    status: Map<string, InvoiceMailRecord>,
    schedules: readonly RecurringInvoice[],
    entityId: string,
    invoices: readonly { id: string; number: string | null }[],
): Map<string, InvoiceMailRecord> {
    const merged = new Map(status);
    for (const inv of invoices) {
        if (merged.has(inv.id)) continue;
        const idx = issuingSchedule([...schedules], entityId, { invoiceId: inv.id, invoiceNumber: inv.number });
        const last = idx < 0 ? undefined : schedules[idx].lastInvoice;
        if (!last?.sentAt) continue;
        merged.set(inv.id, {
            id: 0,
            entityId,
            invoiceId: inv.id,
            invoiceNumber: inv.number,
            at: last.sentAt,
            from: '',
            to: last.sentTo ?? [],
            subject: '',
            messageId: last.messageId ?? null,
            result: 'sent',
            error: null,
        });
    }
    return merged;
}

/**
 * The defaults for mailing an invoice of `schedule` (or of no schedule at all): the entity's mail
 * account plus the customer's address, salutation and form of address. The one place that resolves
 * the salutation chain (project contact person → contract), so the desktop dialog and the CLI preview
 * cannot disagree.
 */
export function mailSetupFor(
    entityId: string,
    schedule: RecurringInvoice | undefined,
    detailEmail: string | null,
    entityName: string,
    path?: string,
    invoiceId?: string,
): InvoiceMailSetup {
    const invoicing = loadEntityInvoicing(entityId, path);
    const project = schedule?.projectId
        ? loadProjects(entityId, path).find((p) => p.id === schedule.projectId)
        : undefined;
    const addressing = schedule ? resolveAddressing(schedule, project) : null;
    const formality = addressing?.formality ?? 'du';
    const entityClosing = formality === 'sie' ? invoicing.defaultClosingSie : invoicing.defaultClosing;
    const last = schedule?.lastInvoice;
    return {
        account: invoicing.mail,
        recipient: (detailEmail ?? '').trim() || (schedule?.customer.email ?? '').trim(),
        greeting: addressing?.greeting ?? '',
        formality,
        closing: (schedule?.customer.closing ?? '').trim() || (entityClosing ?? '').trim(),
        issuerName: invoicing.selfIssuer?.signature?.trim() || invoicing.selfIssuer?.name?.trim() || entityName,
        lastSent: last?.sentAt ? { sentAt: last.sentAt, sentTo: last.sentTo ?? [] } : null,
        history: invoiceId ? loadInvoiceMailHistory(entityId, invoiceId) : [],
        templates: invoicing.mailTemplates,
        templateId: pickTemplateId(
            invoicing.mailTemplates,
            schedule?.mailTemplateId,
            project?.mailTemplateId,
            invoicing.defaultMailTemplate,
        ),
        facts: {
            customerName: schedule?.customer.name ?? '',
            domains: schedule?.domains ?? [],
            description: schedule?.description ?? '',
            projectName: project?.name ?? '',
            itemTitles: (schedule?.items ?? []).map((i) => i.title),
        },
    };
}

/** Collect the defaults for mailing one invoice, finding its schedule by back-end id or number. */
export function loadInvoiceMailSetup(
    entityId: string,
    ref: { invoiceId: string; invoiceNumber: string | null },
    detailEmail: string | null,
    entityName: string,
    path?: string,
): InvoiceMailSetup {
    const schedules = loadRecurringInvoices(path);
    const schedule = schedules[issuingSchedule(schedules, entityId, ref)];
    return mailSetupFor(entityId, schedule, detailEmail, entityName, path, ref.invoiceId);
}

/** What distinguishes one invoice's mail from another's. */
export interface InvoiceMailFacts {
    number: string;
    total: number | null;
    dueDate: string | null;
    net?: number | null;
    issueDate?: string | null;
    period?: { start: string; end: string } | null;
    /** The invoice's public view-and-pay link; only an https URL is ever offered to a customer. */
    url?: string | null;
}

/** The proposed subject and text for one invoice. Both frontends draft through here. */
export function draftInvoiceMail(
    setup: InvoiceMailSetup,
    invoice: InvoiceMailFacts,
    templateId: string = setup.templateId,
): InvoiceMailDraft {
    return buildInvoiceMail(
        {
            number: invoice.number,
            total: invoice.total,
            net: invoice.net,
            issueDate: invoice.issueDate,
            period: invoice.period,
            dueDate: invoice.dueDate,
            customerName: setup.facts.customerName,
            domains: setup.facts.domains,
            description: setup.facts.description,
            projectName: setup.facts.projectName,
            itemTitles: setup.facts.itemTitles,
            greeting: setup.greeting,
            formality: setup.formality,
            closing: setup.closing,
            issuerName: setup.issuerName,
            paymentUrl: invoice.url && /^https:\/\//i.test(invoice.url) ? invoice.url : null,
        },
        setup.templates.find((t) => t.id === templateId),
    );
}

/** Real PDF source and manifest log; the caller supplies the sender. */
export function defaultInvoiceMailDeps(
    req: Pick<InvoiceMailRequest, 'entityId' | 'invoiceId' | 'invoiceNumber'>,
    sender: MailSender,
    path?: string,
): SendInvoiceEmailDeps {
    return {
        sender,
        loadPdf: () => getOutgoingInvoicePdfBytes(req.entityId, req.invoiceId, path),
        recordSent: (log) => {
            const next = applySentLog(loadRecurringInvoices(path), req.entityId, req, log);
            if (next) saveRecurringInvoices(next, path);
        },
        recordAttempt: (attempt) =>
            withLedger((db) => {
                recordInvoiceMail(db, {
                    ...attempt,
                    entityId: req.entityId,
                    invoiceId: req.invoiceId,
                    invoiceNumber: req.invoiceNumber,
                });
            }),
    };
}
