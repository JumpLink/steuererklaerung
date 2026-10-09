/**
 * Qonto API – Client invoices (outgoing invoices to customers).
 * GET /v2/client_invoices, POST /v2/client_invoices.
 *
 * Invoices can be created as `draft` (editable, not sent) or `unpaid` (finalized).
 * Default here is `draft` so a human reviews and sends from the Qonto UI.
 */

import { get, listAll, patch, post } from './request.ts';
import { shiftDate } from '@steuererklaerung/shared';
import type { ClientInvoice, ClientInvoiceItem, CreateClientInvoiceBody, SendClientInvoiceBody } from './types.ts';

function idempotencyKey(): string {
    return crypto.randomUUID();
}

/**
 * Normalize a VAT rate into the decimal string Qonto expects.
 * Accepts percent ("19", 19) or decimal ("0.19", 0.19); values > 1 are treated as percent.
 * @example normalizeVatRate(19) // "0.19"
 * @example normalizeVatRate("0.07") // "0.07"
 */
export function normalizeVatRate(input: string | number): string {
    const n = typeof input === 'number' ? input : Number.parseFloat(input.trim());
    if (!Number.isFinite(n) || n < 0) {
        throw new Error(`Invalid vat_rate: ${String(input)}`);
    }
    const decimal = n > 1 ? n / 100 : n;
    // Trim trailing zeros but keep a clean decimal string (e.g. 0.19, 0.07, 0).
    return String(Number(decimal.toFixed(4)));
}

/**
 * Format a monetary amount to a 2-decimal string (Qonto unit_price.value).
 * @example normalizeAmount(100) // "100.00"
 */
export function normalizeAmount(input: string | number): string {
    const n = typeof input === 'number' ? input : Number.parseFloat(String(input).replace(',', '.').trim());
    if (!Number.isFinite(n)) {
        throw new Error(`Invalid amount: ${String(input)}`);
    }
    return n.toFixed(2);
}

/** Add days to a YYYY-MM-DD date and return YYYY-MM-DD. Alias of the shared shiftDate. */
export const addDays = shiftDate;

/** Friendly per-item spec (what a draft JSON file / CLI provides before normalization). */
export interface InvoiceItemSpec {
    title: string;
    description?: string;
    quantity: string | number;
    unit?: string;
    /** Net unit price, e.g. "100.00", 100, or "100,00". */
    unit_price: string | number;
    /** Percent ("19", 19) or decimal ("0.19"). */
    vat_rate: string | number;
}

/** Friendly invoice spec consumed by buildClientInvoiceBody(). */
export interface InvoiceSpec {
    issue_date: string;
    /** Explicit due date; if absent, computed as issue_date + payment_terms_days. */
    due_date?: string;
    /** Default 15 (matches existing invoices) when due_date is not given. */
    payment_terms_days?: number;
    /** Default "EUR". */
    currency?: string;
    /** Own IBAN the customer pays to (required by Qonto). */
    iban: string;
    number?: string;
    status?: 'draft' | 'unpaid';
    header?: string;
    footer?: string;
    terms_and_conditions?: string;
    performance_start_date?: string;
    performance_end_date?: string;
    items: InvoiceItemSpec[];
}

/** Convert a friendly item spec into the Qonto API item shape. */
export function buildInvoiceItem(spec: InvoiceItemSpec, currency: string): ClientInvoiceItem {
    if (!spec.title?.trim()) throw new Error('Item title is required');
    if (spec.title.length > 40) {
        throw new Error(`Item title exceeds 40 chars: "${spec.title}"`);
    }
    return {
        title: spec.title,
        ...(spec.description ? { description: spec.description } : {}),
        quantity: String(spec.quantity),
        ...(spec.unit ? { unit: spec.unit } : {}),
        unit_price: { value: normalizeAmount(spec.unit_price), currency },
        vat_rate: normalizeVatRate(spec.vat_rate),
    };
}

/**
 * Build the POST /v2/client_invoices body from a resolved client id and a friendly spec.
 * Pure (no network) so it can be unit-tested and dry-run-printed.
 */
export function buildClientInvoiceBody(clientId: string, spec: InvoiceSpec): CreateClientInvoiceBody {
    if (!clientId) throw new Error('clientId is required');
    if (!spec.iban?.trim()) throw new Error('iban is required (payment_methods.iban)');
    if (!spec.items?.length) throw new Error('At least one invoice item is required');
    const currency = spec.currency ?? 'EUR';
    const dueDate = spec.due_date ?? addDays(spec.issue_date, spec.payment_terms_days ?? 15);
    return {
        client_id: clientId,
        issue_date: spec.issue_date,
        due_date: dueDate,
        currency,
        payment_methods: { iban: spec.iban.replace(/\s+/g, '') },
        status: spec.status ?? 'draft',
        ...(spec.number ? { number: spec.number } : {}),
        ...(spec.header ? { header: spec.header } : {}),
        ...(spec.footer ? { footer: spec.footer } : {}),
        ...(spec.terms_and_conditions ? { terms_and_conditions: spec.terms_and_conditions } : {}),
        ...(spec.performance_start_date ? { performance_start_date: spec.performance_start_date } : {}),
        ...(spec.performance_end_date ? { performance_end_date: spec.performance_end_date } : {}),
        items: spec.items.map((it) => buildInvoiceItem(it, currency)),
    };
}

export interface ListClientInvoicesParams {
    status?: string;
    perPage?: number;
    maxPages?: number;
}

/**
 * List client invoices (all pages by default), optionally filtered by status.
 * The status filter is also applied client-side because the Qonto list endpoint
 * does not reliably honor a `status` query param.
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function listClientInvoices(params: ListClientInvoicesParams = {}): Promise<ClientInvoice[]> {
    const query: Record<string, unknown> = {};
    if (params.status) query.status = params.status;
    const invoices = await listAll<ClientInvoice>('client_invoices', query, {
        perPage: params.perPage,
        maxPages: params.maxPages,
    });
    if (params.status) {
        return invoices.filter((i) => i.status === params.status);
    }
    return invoices;
}

/**
 * Retrieve one client invoice (carries `attachment_id`, which the list endpoint may omit).
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function getClientInvoice(invoiceId: string): Promise<ClientInvoice> {
    const res = await get<{ client_invoice: ClientInvoice }>(`client_invoices/${invoiceId}`);
    return res.client_invoice;
}

/**
 * Create a client invoice. Defaults to draft via buildClientInvoiceBody().
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function createClientInvoice(body: CreateClientInvoiceBody): Promise<ClientInvoice> {
    const res = await post<{ client_invoice: ClientInvoice }>('client_invoices', body, {
        'X-Qonto-Idempotency-Key': idempotencyKey(),
    });
    return res.client_invoice;
}

/**
 * Update an existing DRAFT client invoice. Only draft invoices can be modified;
 * the `items` array is fully replaced. Reuses the same body shape as create.
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function updateClientInvoice(
    invoiceId: string,
    body: Partial<CreateClientInvoiceBody>,
): Promise<ClientInvoice> {
    const res = await patch<{ client_invoice: ClientInvoice }>(`client_invoices/${invoiceId}`, body);
    return res.client_invoice;
}

/** Friendly spec for sending an invoice by email (before normalization). */
export interface SendInvoiceSpec {
    /** Recipient(s): an array, or a comma-separated string. */
    sendTo: string[] | string;
    subject: string;
    body?: string;
    /** Copy the email to yourself (default true). */
    copyToSelf?: boolean;
}

/** Build and validate the POST /send body from a friendly spec. Pure (no network). */
export function buildSendInvoiceBody(spec: SendInvoiceSpec): SendClientInvoiceBody {
    const list = Array.isArray(spec.sendTo) ? spec.sendTo : String(spec.sendTo ?? '').split(',');
    const send_to = list.map((s) => s.trim()).filter(Boolean);
    if (!send_to.length) throw new Error('At least one recipient (--to) is required');
    if (!spec.subject?.trim()) throw new Error('A subject (--subject) is required');
    return {
        send_to,
        email_title: spec.subject,
        ...(spec.body ? { email_body: spec.body } : {}),
        copy_to_self: spec.copyToSelf ?? true,
    };
}

/**
 * Send a finalized client invoice by email. Emails the recipient(s); outward-facing.
 * Requires QONTO_SIGN_IN and QONTO_SECRET_KEY.
 */
export async function sendClientInvoice(invoiceId: string, body: SendClientInvoiceBody): Promise<unknown> {
    return post<unknown>(`client_invoices/${invoiceId}/send`, body, {
        'X-Qonto-Idempotency-Key': idempotencyKey(),
    });
}
