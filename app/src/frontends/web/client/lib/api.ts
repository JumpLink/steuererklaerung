/** Typed fetch wrappers for the read-only review API (src/web/routes.ts). */

import type { EuerTxAggregate, EuerTxDetailRow } from '../../../../core/elster/euer-transactions.ts';
import type { EuerKennzahl } from '../../../../core/actions/elster/euer.ts';
import type { BwaResult } from '../../../../core/elster/bwa.ts';
import type { SteuerDashboard } from '../../../../core/elster/fristen.ts';
import type { HomeModel } from '../../../../core/elster/home.ts';
import type { Hinweis } from '../../../../core/elster/hinweise.ts';
import type { AppSettings } from '../../../../core/config/index.ts';
import type { UsteAggregate } from '../../../../core/elster/uste-aggregate.ts';
import type { UstvaYearQuarter } from '../../../../core/elster/ustva-aggregate.ts';
import type { OpenItem } from '../../../../core/actions/fristen.ts';
import type { SteuerTermin } from '../../../../core/elster/steuertermine.ts';
import type { OffeneSteuerzahlung } from '../../../../core/elster/steuerzahlungen.ts';
import type { GewstReport } from '../../../../core/actions/elster/gewst.ts';
import type { FeststellungReport } from '../../../../core/actions/elster/feststellung.ts';
import type { TaxReturnPlan } from '../../../../core/actions/elster/wizard.ts';
import type { CrossCheckResult, CrossCheckSummary } from '../../../../core/actions/elster/cross-checks.ts';
import type { SteuerkontoReport } from '../../../../core/actions/elster/steuerkonto.ts';
import type { EstIntakeProposal } from '../../../../core/actions/elster/est-intake-topics.ts';
import { type StoreReconciliationStatus, type DmsDocument, type AnalyzeResult } from '@steuererklaerung/dms';
import type { TxViewExtras } from '../../../../core/lib/tx-view.ts';
import type { MetaInfo, EntityMeta, McpGroupTools, McpToolInfo } from '../../routes.ts';
import type { AccountsResponse, ConnectionInfo, ImportResult, ImportFormat } from '../../../../core/actions/accounts.ts';
import type { EntityDmsView, EntityInvoicingView } from '../../../../core/config/index.ts';
import type { RecurringDueEntry } from '../../../../core/invoices/recurring.ts';
import type { CreateRecurringResult } from '../../../../core/actions/recurring-invoices.ts';
import type {
    CreateInvoiceInput,
    InvoiceCapabilities,
    OutgoingInvoiceDetail,
    OutgoingInvoiceDraft,
    OutgoingInvoiceSummary,
} from '../../../../core/invoices/provider.ts';
import type { PaymentCandidate } from '../../../../core/actions/invoice-payments.ts';
import type { Contact, ContactInput } from '@steuererklaerung/store';

/** The /api/invoicing/capabilities payload. */
export interface InvoiceCapabilitiesInfo {
    providerType: 'qonto' | 'self';
    providerName: string;
    capabilities: InvoiceCapabilities;
}
import type { ImportContactsResult } from '../../../../core/actions/contacts.ts';

export interface ReceiptInfo {
    docId: number;
    title: string | null;
    invoiceNumber: string | null;
    net: number | null;
    gross: number | null;
    vat: number | null;
}
export type TxRow = EuerTxDetailRow & { receipt: ReceiptInfo | null } & TxViewExtras;

// The meta shape is owned by the server (routes.ts) — re-export so views import it from here.
// `assistant` is added dynamically by the /api/meta handler (reflects the live setting).
export type { EntityMeta };
export type { AppSettings };
export type { McpGroupTools, McpToolInfo };
export type { AccountsResponse, ConnectionInfo, ImportResult, ImportFormat };
export type { DmsDocument, AnalyzeResult };
export type EntityDms = EntityDmsView;
export type EntityInvoicing = EntityInvoicingView;
export type { RecurringDueEntry };
export type { OutgoingInvoiceSummary, OutgoingInvoiceDetail, OutgoingInvoiceDraft, InvoiceCapabilities, CreateInvoiceInput };
export type { PaymentCandidate };
export type { Contact, ContactInput };
export type { ImportContactsResult };
export interface DocumentsResponse {
    dmsKind: 'builtin' | 'paperless';
    documents: DmsDocument[];
}
/** Filters for the Belege list (all optional; empty values are dropped). */
export interface DocumentFilters {
    query?: string;
    from?: string;
    to?: string;
    direction?: 'incoming' | 'outgoing';
    linked?: 'yes' | 'no';
}
export type Meta = MetaInfo & { assistant: boolean };
export interface TransactionsResponse {
    year: number;
    rows: TxRow[];
    totals: EuerTxAggregate['totals'];
    coverage: EuerTxAggregate['coverage'];
    /** Post-Betriebsaufgabe rows (§24 kept / excluded), enriched like `rows` + an `included` flag. */
    aufgabe: (TxRow & { included: boolean })[];
}
export interface EuerResponse {
    aggregate: EuerTxAggregate;
    kennzahlen: EuerKennzahl[];
}

async function get<T>(path: string): Promise<T> {
    const r = await fetch(path);
    const body = (await r.json()) as T & { error?: string };
    if (!r.ok || body?.error) throw new Error(body?.error || `${path} → HTTP ${r.status}`);
    return body;
}

async function post<T>(path: string, payload: unknown): Promise<T> {
    const r = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const body = (await r.json()) as T & { error?: string };
    if (!r.ok || body?.error) throw new Error(body?.error || `${path} → HTTP ${r.status}`);
    return body;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** The assistant's reply as the client consumes it: text + any intake proposals to approve. */
export interface ChatReply {
    answer: string;
    proposals: EstIntakeProposal[];
}

/** Ask the assistant: POST the question, then poll the job until done (≤ ~2 min). */
async function chat(entity: string, year: number, question: string): Promise<ChatReply> {
    const { jobId } = await post<{ jobId: string }>('/api/chat', { entity, year, question });
    for (let i = 0; i < 120; i++) {
        await sleep(1000);
        const job = await get<{ status: string; answer?: string; proposals?: EstIntakeProposal[]; error?: string }>(
            `/api/chat/${jobId}`,
        );
        if (job.status === 'done') return { answer: job.answer ?? '', proposals: job.proposals ?? [] };
        if (job.status === 'error') throw new Error(job.error || 'Der Assistent konnte nicht antworten.');
    }
    throw new Error('Zeitüberschreitung — der Assistent hat nicht rechtzeitig geantwortet.');
}

/** Approve-to-apply: persist an intake proposal the assistant previewed. Returns the applied headline. */
async function applyEstIntake(
    entity: string,
    year: number,
    proposal: EstIntakeProposal,
): Promise<{ ergebnis: string; hinweise: string[] }> {
    return post<{ ergebnis: string; hinweise: string[] }>('/api/est-intake/apply', { entity, year, proposal });
}

/** `?entity=…&year=…` — every data endpoint is scoped to one firm + year. */
const q = (entity: string, year: number) => `entity=${encodeURIComponent(entity)}&year=${year}`;

export const api = {
    meta: () => get<Meta>('/api/meta'),
    transactions: (entity: string, year: number) => get<TransactionsResponse>(`/api/transactions?${q(entity, year)}`),
    reconciliation: (entity: string, year: number) =>
        get<StoreReconciliationStatus>(`/api/reconciliation?${q(entity, year)}`),
    euer: (entity: string, year: number) => get<EuerResponse>(`/api/euer?${q(entity, year)}`),
    bwa: (entity: string, year: number) => get<BwaResult>(`/api/bwa?${q(entity, year)}`),
    uste: (entity: string, year: number) => get<UsteAggregate>(`/api/uste?${q(entity, year)}`),
    gewst: (entity: string, year: number) => get<GewstReport>(`/api/gewst?${q(entity, year)}`),
    feststellung: (entity: string, year: number) => get<FeststellungReport>(`/api/feststellung?${q(entity, year)}`),
    wizard: (entity: string, year: number) => get<TaxReturnPlan>(`/api/wizard?${q(entity, year)}`),
    /** Machine cross-checks for the Gegenprüfung (business entities); {checks:[]} for a privat/ESt entity. */
    crosschecks: (entity: string, year: number) =>
        get<{ checks: CrossCheckResult[]; summary: CrossCheckSummary }>(`/api/crosschecks?${q(entity, year)}`),
    dashboard: (entity: string, year: number) => get<SteuerDashboard>(`/api/dashboard?${q(entity, year)}`),
    home: (entity: string, year: number) => get<HomeModel>(`/api/home?${q(entity, year)}`),
    ustva: (entity: string, year: number) => get<UstvaYearQuarter[]>(`/api/ustva?${q(entity, year)}`),
    openItems: () => get<OpenItem[]>('/api/open-items'),
    steuertermine: () => get<SteuerTermin[]>('/api/steuertermine'),
    steuerzahlungen: () => get<OffeneSteuerzahlung[]>('/api/steuerzahlungen'),
    hinweise: (entity: string, year: number) => get<Hinweis[]>(`/api/hinweise?${q(entity, year)}`),
    chat,
    applyEstIntake,
    settings: () => get<AppSettings>('/api/settings'),
    saveSettings: (s: AppSettings) => post<AppSettings>('/api/settings', s),
    mcpTools: () => get<McpGroupTools[]>('/api/mcp-tools'),
    accounts: () => get<AccountsResponse>('/api/accounts'),
    importAccount: (payload: { format?: ImportFormat; filename: string; contentBase64: string; full?: boolean }) =>
        post<ImportResult & { rebuilding: boolean }>('/api/accounts/import', payload),
    removeAccount: (accountKey: string, mode: 'delete-all' | 'stop-sync') =>
        post<{ mode: string; transactions: number; rebuilding: boolean }>('/api/accounts/remove', { accountKey, mode }),
    rebuildStatus: () => get<{ status: string; error?: string }>('/api/accounts/rebuild'),
    connectQonto: (p: { login: string; secretKey: string; env?: string; bankAccountId?: string }) =>
        post<{ ok: boolean; env: string }>('/api/accounts/connect/qonto', p),
    connectFints: (p: {
        name: string;
        url: string;
        blz: string;
        user_id: string;
        product_id: string;
        product_version?: string;
        pin: string;
    }) => post<{ ok: boolean; name: string }>('/api/accounts/connect/fints', p),
    syncAccounts: (account?: string) =>
        post<{ started: boolean }>('/api/accounts/sync', account ? { account } : {}),
    syncStatus: () =>
        get<{ status: string; reports?: { accountKey: string; added: number; total: number; error?: string }[]; error?: string }>(
            '/api/accounts/sync',
        ),
    steuerkonto: (entity: string, year: number) => get<SteuerkontoReport>(`/api/steuerkonto?${q(entity, year)}`),

    // ── Belege (DMS-agnostic documents) ──────────────────────────────────────────────
    documents: (entity: string, year: number, f: DocumentFilters = {}) => {
        const p = new URLSearchParams({ entity, year: String(year) });
        for (const [k, v] of Object.entries(f)) if (v) p.set(k, String(v));
        return get<DocumentsResponse>(`/api/documents?${p.toString()}`);
    },
    document: (entity: string, year: number, id: string) =>
        get<DmsDocument>(`/api/documents/${encodeURIComponent(id)}?${q(entity, year)}`),
    /** Direct URL to a document's file (built-in: served inline; Paperless: prepared via a job). */
    documentFileUrl: (entity: string, year: number, id: string) =>
        `/api/documents/${encodeURIComponent(id)}/file?${q(entity, year)}`,
    /** URL to a document's card thumbnail image (built-in renders locally, Paperless via a job;
     *  200 = image bytes, 202 = preparing → poll, 404 = no preview → keep the icon). */
    documentThumbnailUrl: (entity: string, year: number, id: string) =>
        `/api/documents/${encodeURIComponent(id)}/thumbnail?${q(entity, year)}`,
    uploadDocument: (payload: {
        entity: string;
        year: number;
        filename: string;
        contentBase64: string;
        mimeType?: string;
        linkTxId?: string;
    }) => {
        const { entity, year, ...rest } = payload;
        return post<{ ok: boolean; id: string; rebuilding: boolean }>(
            `/api/documents?${q(entity, year)}`,
            rest,
        );
    },
    linkDocument: (entity: string, id: string, txId: string) =>
        post<{ ok: boolean; rebuilding: boolean }>(
            `/api/documents/${encodeURIComponent(id)}/link?entity=${encodeURIComponent(entity)}`,
            { txId },
        ),
    /** Record a classification decision after linking (accept the AI reading, or override the Kategorie).
     *  Synchronous store write server-side → a plain post, no job-poll. */
    recordDecision: (
        entity: string,
        id: string,
        payload: { txId: string; category?: string; note?: string; aiNote?: string; aiNoteAccepted?: boolean },
    ) =>
        post<{ ok: boolean; rebuilding: boolean }>(
            `/api/documents/${encodeURIComponent(id)}/decision?entity=${encodeURIComponent(entity)}`,
            payload,
        ),
    /** Run the AI analysis on a built-in document; resolves with the extraction + match candidates. */
    analyzeDocument: async (entity: string, id: string): Promise<AnalyzeResult> => {
        const { jobId } = await post<{ jobId: string }>(
            `/api/documents/analyze?entity=${encodeURIComponent(entity)}`,
            { id },
        );
        for (let i = 0; i < 120; i++) {
            await sleep(1000);
            const job = await get<{ status: string; result?: AnalyzeResult; error?: string }>(
                `/api/documents/analyze/${jobId}`,
            );
            if (job.status === 'done' && job.result) return job.result;
            if (job.status === 'error') throw new Error(job.error || 'Die KI-Analyse ist fehlgeschlagen.');
        }
        throw new Error('Zeitüberschreitung — die KI-Analyse hat nicht rechtzeitig geantwortet.');
    },
    documentsRebuild: () => get<{ status: string; error?: string }>('/api/documents/rebuild'),
    entityDms: (entity: string) => get<EntityDms>(`/api/entity-dms?entity=${encodeURIComponent(entity)}`),
    saveEntityDms: (payload: { entity: string; type: string; paperlessUrl?: string; paperlessToken?: string }) => {
        const { entity, ...rest } = payload;
        return post<{ ok: boolean; rebuilding: boolean }>(`/api/entity-dms?entity=${encodeURIComponent(entity)}`, rest);
    },

    // ── Recurring outgoing invoices ─────────────────────────────────────────────────────
    /** Reminder dashboard for one entity (pass dueOnly to get only overdue + soon-due). */
    recurring: (entity: string, dueOnly = false) =>
        get<{ entries: RecurringDueEntry[] }>(
            `/api/recurring?entity=${encodeURIComponent(entity)}${dueOnly ? '&due=1' : ''}`,
        ).then((r) => r.entries),
    entityInvoicing: (entity: string) =>
        get<EntityInvoicing>(`/api/entity-invoicing?entity=${encodeURIComponent(entity)}`),
    saveEntityInvoicing: (payload: {
        entity: string;
        type: string;
        iban?: string;
        paymentTermsDays?: number;
        selfNumberPrefix?: string;
        selfIssuer?: Record<string, unknown>;
    }) => {
        const { entity, ...rest } = payload;
        return post<{ ok: boolean }>(`/api/entity-invoicing?entity=${encodeURIComponent(entity)}`, rest);
    },
    /** Create a draft for one schedule: POST then poll the job until done (≤ ~2 min). */
    createRecurring: async (id: string): Promise<CreateRecurringResult> => {
        const { jobId } = await post<{ jobId: string }>(`/api/recurring/${encodeURIComponent(id)}/create`, {});
        for (let i = 0; i < 120; i++) {
            await sleep(1000);
            const job = await get<{ status: string; result?: CreateRecurringResult; error?: string }>(
                `/api/recurring/create/${jobId}`,
            );
            if (job.status === 'done' && job.result) return job.result;
            if (job.status === 'error') throw new Error(job.error || 'Die Rechnung konnte nicht erstellt werden.');
        }
        throw new Error('Zeitüberschreitung — die Rechnung wurde nicht rechtzeitig erstellt.');
    },
    /** List all issued invoices for an entity's back-end: POST then poll (outbound Qonto fetch). */
    invoices: async (entity: string): Promise<OutgoingInvoiceSummary[]> => {
        const { jobId } = await post<{ jobId: string }>(`/api/invoices?entity=${encodeURIComponent(entity)}`, {});
        for (let i = 0; i < 120; i++) {
            await sleep(1000);
            const job = await get<{ status: string; invoices?: OutgoingInvoiceSummary[]; error?: string }>(
                `/api/invoices/${jobId}`,
            );
            if (job.status === 'done' && job.invoices) return job.invoices;
            if (job.status === 'error') throw new Error(job.error || 'Die Rechnungen konnten nicht geladen werden.');
        }
        throw new Error('Zeitüberschreitung — die Rechnungen wurden nicht rechtzeitig geladen.');
    },
    /** The entity back-end + its capabilities (which invoice actions the UI shows). */
    invoiceCapabilities: (entity: string) =>
        get<InvoiceCapabilitiesInfo>(`/api/invoicing/capabilities?entity=${encodeURIComponent(entity)}`),
    /** Full detail for one invoice (self back-end; local, so a plain GET). */
    invoiceDetail: (entity: string, id: string) =>
        get<OutgoingInvoiceDetail>(
            `/api/invoices/${encodeURIComponent(id)}/detail?entity=${encodeURIComponent(entity)}`,
        ),
    /** URL to open/download the invoice PDF (self renders bytes; Qonto → use inv.url instead). */
    invoicePdfUrl: (entity: string, id: string) =>
        `/api/invoices/${encodeURIComponent(id)}/pdf?entity=${encodeURIComponent(entity)}`,
    /** URL to download the XRechnung XML (self only). */
    invoiceXmlUrl: (entity: string, id: string) =>
        `/api/invoices/${encodeURIComponent(id)}/xml?entity=${encodeURIComponent(entity)}`,
    /** URL to open a tax-return review datasheet (Prüf-Datenblatt) as a cairo PDF — same as the CLI. */
    reportPdfUrl: (kind: 'euer' | 'uste' | 'gewst' | 'feststellung', entity: string, year: number) =>
        `/api/${kind}/pdf?${q(entity, year)}`,
    /** URL to download one quarter's USt-VA as the plain ISO-8859-15 XML for the Mein-ELSTER XML-Import. */
    ustvaXmlUrl: (entity: string, year: number, quarter: number) =>
        `/api/ustva/xml?${q(entity, year)}&quarter=${quarter}`,
    /** Create or (with id) update a draft: POST then poll the job (a Qonto create is outbound). */
    saveInvoiceDraft: async (
        entity: string,
        input: CreateInvoiceInput,
        id?: string,
    ): Promise<OutgoingInvoiceDraft> => {
        const { jobId } = await post<{ jobId: string }>(
            `/api/invoices/draft?entity=${encodeURIComponent(entity)}`,
            { id, input },
        );
        for (let i = 0; i < 120; i++) {
            await sleep(1000);
            const job = await get<{ status: string; draft?: OutgoingInvoiceDraft; error?: string }>(
                `/api/invoices/draft/${jobId}`,
            );
            if (job.status === 'done' && job.draft) return job.draft;
            if (job.status === 'error') throw new Error(job.error || 'Der Entwurf konnte nicht gespeichert werden.');
        }
        throw new Error('Zeitüberschreitung — der Entwurf wurde nicht rechtzeitig gespeichert.');
    },
    /** Festschreiben one invoice (self, local) — assigns the number and archives PDF + XML. */
    finalizeInvoice: (entity: string, id: string) =>
        post<{ invoice: OutgoingInvoiceSummary }>(
            `/api/invoices/${encodeURIComponent(id)}/finalize?entity=${encodeURIComponent(entity)}`,
            {},
        ).then((r) => r.invoice),
    /** Candidate bank transactions that likely settled an open invoice. */
    paymentCandidates: (entity: string, id: string) =>
        get<{ candidates: PaymentCandidate[] }>(
            `/api/invoices/${encodeURIComponent(id)}/payment-candidates?entity=${encodeURIComponent(entity)}`,
        ).then((r) => r.candidates),
    /** Mark an open invoice paid (self, local), optionally linking the settling transaction. */
    markInvoicePaid: (entity: string, id: string, opts: { paidOn?: string; txId?: string }) =>
        post<{ invoice: OutgoingInvoiceSummary }>(
            `/api/invoices/${encodeURIComponent(id)}/mark-paid?entity=${encodeURIComponent(entity)}`,
            opts,
        ).then((r) => r.invoice),
    /** Delete a DRAFT invoice (self, local). */
    deleteInvoiceDraft: (entity: string, id: string) =>
        post<{ ok: boolean }>(
            `/api/invoices/${encodeURIComponent(id)}/delete?entity=${encodeURIComponent(entity)}`,
            {},
        ),
    /** Cancel an invoice via a storno counter-invoice (self, local). */
    cancelInvoice: (entity: string, id: string, reason?: string) =>
        post<{ storno: OutgoingInvoiceSummary; original: OutgoingInvoiceSummary }>(
            `/api/invoices/${encodeURIComponent(id)}/cancel?entity=${encodeURIComponent(entity)}`,
            { reason },
        ),

    // ── Contacts (parties) ──────────────────────────────────────────────────────────────
    contacts: (entity: string) =>
        get<{ contacts: Contact[] }>(`/api/contacts?entity=${encodeURIComponent(entity)}`).then((r) => r.contacts),
    saveContact: (entity: string, input: Partial<ContactInput>) =>
        post<{ contact: Contact }>(`/api/contacts?entity=${encodeURIComponent(entity)}`, input).then((r) => r.contact),
    deleteContact: (entity: string, id: string) =>
        post<{ ok: boolean }>(
            `/api/contacts/${encodeURIComponent(id)}/delete?entity=${encodeURIComponent(entity)}`,
            {},
        ),
    /** Import contacts from Qonto/Paperless: POST then poll the job (≤ ~2 min, outbound fetch). */
    importContacts: async (entity: string): Promise<ImportContactsResult> => {
        const { jobId } = await post<{ jobId: string }>(`/api/contacts/import?entity=${encodeURIComponent(entity)}`, {});
        for (let i = 0; i < 120; i++) {
            await sleep(1000);
            const job = await get<{ status: string; result?: ImportContactsResult; error?: string }>(
                `/api/contacts/import/${jobId}`,
            );
            if (job.status === 'done' && job.result) return job.result;
            if (job.status === 'error') throw new Error(job.error || 'Der Import ist fehlgeschlagen.');
        }
        throw new Error('Zeitüberschreitung — der Import wurde nicht rechtzeitig fertig.');
    },
};
