/**
 * Qonto API response and filter types.
 * Aligned with Qonto REST API; list responses use endpoint name as key and include meta.
 */

export interface QontoListMeta {
    current_page: number;
    total_pages: number;
    per_page?: number;
    total_count?: number;
}

/**
 * List response shape: { [endpoint]: T[], meta: QontoListMeta }.
 * The index signature is needed because Qonto uses dynamic keys (e.g. "transactions", "bank_accounts").
 */
export interface QontoListResponse<T> {
    meta: QontoListMeta;
    [key: string]: T[] | QontoListMeta | undefined;
}

export interface Organization {
    slug: string;
    legal_name?: string;
    legal_form?: string;
    country?: string;
    bank_accounts?: BankAccount[];
}

export interface BankAccount {
    id: string;
    name: string;
    iban?: string;
    bic?: string;
    balance_cents?: number;
    balance_currency?: string;
    status?: string;
}

export interface Transaction {
    id: string;
    amount_cents: number;
    /** ISO 4217 currency code. */
    currency: string;
    side: 'credit' | 'debit';
    operation_type?: string;
    emitted_at: string;
    settled_at?: string;
    updated_at: string;
    status?: string;
    /** Free-form transaction description/label (e.g. counterparty name or payment reason). */
    label?: string;
    /** User-added note on the transaction. */
    note?: string;
    /** Transaction reference (e.g. SEPA reference, invoice number). */
    reference?: string | null;
    /** Transaction category (e.g. "office_supplies", "subscriptions"). */
    category?: string;
    /** VAT amount in the transaction's currency (null if not set). */
    vat_amount?: number | null;
    /** VAT amount in cents. */
    vat_amount_cents?: number | null;
    /** VAT rate as percentage (e.g. 19.0). */
    vat_rate?: number | null;
    label_ids?: string[];
    attachment_ids?: string[];
    /** Which of the subject objects below describes the operation (`transfer`, `income`, `card`, …). */
    subject_type?: string;
    transfer?: QontoCounterpartyAccount;
    income?: QontoCounterpartyAccount;
    swift_income?: QontoCounterpartyAccount;
    direct_debit?: QontoCounterpartyAccount;
    direct_debit_collection?: QontoCounterpartyAccount;
}

/** The other side's account on a transfer, income or direct debit (docs.qonto.com, List transactions). */
export interface QontoCounterpartyAccount {
    counterparty_account_number?: string;
    /** `IBAN` for SEPA; other formats (e.g. a SWIFT account number) are not an IBAN. */
    counterparty_account_number_format?: string;
    counterparty_bank_identifier?: string;
    counterparty_bank_identifier_format?: string;
}

export interface Attachment {
    id: string;
    file_name?: string;
    file_content_type?: string;
    file_size?: number;
    /** Download URL (Qonto API returns this as "url"; valid 30 minutes). */
    download_url?: string;
    /** Download URL (Qonto API field name; use this or download_url). */
    url?: string;
    expired_at?: string;
}

export interface Statement {
    id: string;
    bank_account_id?: string;
    iban?: string;
    period_from?: string;
    period_to?: string;
}

/** Postal address used for Qonto clients (billing/delivery). */
export interface QontoAddress {
    street_address?: string;
    city?: string;
    zip_code?: string;
    /** Required only for Italian clients. */
    province_code?: string;
    /** ISO 3166-1 alpha-2 (e.g. "DE"). */
    country_code?: string;
}

/**
 * A Qonto client (customer) that invoices can be issued to.
 * To be usable for invoicing, a client needs currency, locale and an address.
 */
export interface Client {
    id: string;
    /** "company" | "individual" | "freelancer". */
    kind?: string;
    name?: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    vat_number?: string;
    tax_identification_number?: string;
    /** ISO 4217 (e.g. "EUR"). */
    currency?: string;
    /** Language code: de | en | fr | it | es. */
    locale?: string;
    billing_address?: QontoAddress;
    created_at?: string;
}

/** Body for POST /v2/clients. Provide name+kind for companies, or first/last name for individuals. */
export interface CreateClientBody {
    kind: 'company' | 'individual' | 'freelancer';
    name?: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    vat_number?: string;
    tax_identification_number?: string;
    /** Required to use the client for invoicing. */
    currency?: string;
    /** Required to use the client for invoicing. */
    locale?: string;
    /** Required to use the client for invoicing. */
    billing_address?: QontoAddress;
    [key: string]: unknown;
}

/** A single line item on a client invoice. Amounts/rates are strings per Qonto API. */
export interface ClientInvoiceItem {
    /** Shown in bold, max 40 chars. */
    title: string;
    /** Max 1800 chars; use \n for line breaks. */
    description?: string;
    /** Decimal string, period-separated (e.g. "0.5", "3"). */
    quantity: string;
    /** Max 20 chars (e.g. "Std", "Stunden"). */
    unit?: string;
    /** { value: "100.00", currency: "EUR" }. */
    unit_price: { value: string; currency: string };
    /** Decimal string (e.g. "0.19" for 19%). */
    vat_rate: string;
}

/** Body for POST /v2/client_invoices. */
export interface CreateClientInvoiceBody {
    client_id: string;
    issue_date: string;
    due_date: string;
    currency: string;
    payment_methods: { iban: string };
    items: ClientInvoiceItem[];
    /** "draft" (editable, not sent) or "unpaid" (finalized). Defaults to "unpaid" if omitted. */
    status?: 'draft' | 'unpaid';
    /** Required only if automatic numbering is disabled for the org. */
    number?: string;
    header?: string;
    footer?: string;
    terms_and_conditions?: string;
    performance_start_date?: string;
    performance_end_date?: string;
    [key: string]: unknown;
}

/** Body for POST /v2/client_invoices/:id/send (email the invoice to the client). */
export interface SendClientInvoiceBody {
    send_to: string[];
    email_title: string;
    email_body?: string;
    /** Copy the email to the authenticated user (default true). */
    copy_to_self?: boolean;
    [key: string]: unknown;
}

/** A Qonto client invoice (outgoing). */
export interface ClientInvoice {
    id: string;
    number?: string;
    status?: string;
    client_id?: string;
    /** The list/detail endpoints embed the full client (the list omits the flat client_id). */
    client?: {
        id?: string;
        name?: string;
        first_name?: string;
        last_name?: string;
        email?: string;
    };
    issue_date?: string;
    due_date?: string;
    currency?: string;
    total_amount?: { value: string; currency: string };
    invoice_url?: string;
    /** The invoice file for GET /v2/attachments/:id; absent while Qonto still generates it. */
    attachment_id?: string;
    /** Service period (the single `performance_date` is deprecated by Qonto). */
    performance_start_date?: string;
    performance_end_date?: string;
}
