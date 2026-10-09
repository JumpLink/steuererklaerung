/**
 * Self (local) outgoing-invoice back-end — create/manage customer invoices without Qonto, under
 * German law. Persists to the SQLite invoices tables (packages/store), renders the PDF via
 * @steuererklaerung/invoice-pdf, emits the XRechnung XML, and archives both through the entity's DMS
 * provider (content-addressed → GoBD-tamper-evident). See docs: the finalize step is the point of
 * no return (fortlaufende Nummer + frozen snapshots).
 *
 * The class takes an injectable {@link SelfProviderDeps} bundle so it is unit-testable with a fake
 * DMS + renderer; {@link buildSelfProvider} wires the real deps from config/DMS/ledger.
 */

import {
    createInvoiceDraft,
    createStornoInvoice,
    deleteInvoiceDraft,
    finalizeInvoice,
    getInvoice as repoGetInvoice,
    listInvoices as repoListInvoices,
    markInvoicePaid,
    migrate,
    openLedger,
    setArchivedDocuments,
    updateInvoiceDraft,
    validateInvoiceForFinalize,
    contactDisplayName,
    ledgerDbPath,
    type InvoiceDraftInput,
    type InvoiceIssuerSnapshot,
    type InvoiceRecipient,
    type LedgerDatabase,
    type StoredInvoice,
} from '@steuererklaerung/store';
import { buildInvoicePdfModel, pdfRenderingAvailable, renderInvoicePdf } from '@steuererklaerung/invoice-pdf';
import { type DmsProvider } from '@steuererklaerung/dms';
import { createAppContext } from '../context.ts';
import { dmsProviderForEntity } from '../dms-provider.ts';
import { parseGermanDecimal, parseVatRate } from './form.ts';
import { getContactById } from '../actions/contacts.ts';
import {
    loadEntityInvoicing,
    loadManifest,
    resolveEntityElster,
    resolveWorkspaceEntities,
    type EntityInvoicingConfig,
} from '../config/index.ts';
import { buildEpcPayload } from '../lib/sepa-qr.ts';
import { buildCiiInvoiceXml } from './cii-xml.ts';
import { elsterIssuerFallback, resolveInvoiceIssuer } from './issuer.ts';
import {
    commonInvoiceProblems,
    SELF_CAPABILITIES,
    type CreateInvoiceInput,
    type OutgoingInvoiceDetail,
    type OutgoingInvoiceDraft,
    type OutgoingInvoiceFile,
    type OutgoingInvoiceProvider,
    type OutgoingInvoiceProviderContext,
    type OutgoingInvoiceRecipient,
    type OutgoingInvoiceSummary,
    type ListOutgoingInvoicesOptions,
} from './provider.ts';

/** Injectable dependencies for the self provider (real wiring in {@link buildSelfProvider}). */
export interface SelfProviderDeps {
    entityId: string;
    numberPrefix: string | null;
    /** Own default IBAN (customer pays to it) when an invoice sets none. */
    iban: string | null;
    logoPath: string | null;
    /** Open + migrate the ledger, run `fn`, close. */
    withDb<T>(fn: (db: LedgerDatabase) => T): T;
    /** Resolve the §14 issuer identity (config over ELSTER fallback). */
    resolveIssuer(): InvoiceIssuerSnapshot;
    /** Build the entity's DMS provider for archiving the finalized artefacts. */
    makeDms(): DmsProvider;
    /** Resolve the §14 recipient for a create/update request (from contactId or explicit block). */
    resolveRecipient(input: CreateInvoiceInput): InvoiceRecipient | null;
    /** Current ISO timestamp (injectable for tests). */
    now(): string;
}

function toSummary(inv: StoredInvoice): OutgoingInvoiceSummary {
    return {
        id: inv.id,
        number: inv.number,
        status: inv.status,
        clientId: null,
        customerName: inv.recipient?.name ?? null,
        issueDate: inv.issueDate,
        dueDate: inv.dueDate,
        total: inv.totals.gross,
        currency: inv.currency,
        url: null,
        paidOn: inv.paidAt,
        provider: 'self',
    };
}

function toDetail(inv: StoredInvoice): OutgoingInvoiceDetail {
    return {
        ...toSummary(inv),
        kind: inv.kind,
        recipient: inv.recipient,
        contactId: inv.contactId,
        items: inv.items.map((it) => ({
            title: it.title,
            description: it.description ?? null,
            quantity: it.quantity,
            unit: it.unit ?? null,
            unitPrice: it.unitPriceNet,
            vatRate: it.vatRate,
            net: it.net,
        })),
        totals: {
            net: inv.totals.net,
            vat: inv.totals.vat,
            gross: inv.totals.gross,
            byRate: inv.totals.byRate.map((r) => ({ rate: r.rate, net: r.net, vat: r.vat })),
        },
        performanceStart: inv.performanceStart,
        performanceEnd: inv.performanceEnd,
        iban: inv.iban,
        buyerReference: inv.buyerReference,
        header: inv.header,
        footer: inv.footer,
        termsAndConditions: inv.terms,
        paidOn: inv.paidAt,
        paidTxId: inv.paidTxId,
        cancelsId: inv.stornoOfId,
        cancelledById: inv.cancelledById,
    };
}

/**
 * Parse a money/quantity value. MUST use the same German-decimal parser as the forms
 * (parseGermanDecimal) — otherwise a thousands-grouped price like "1.234,56" that the form
 * validates + previews as 1234.56 would be stored differently (the old normalizeAmount did a
 * single comma→dot replace → parseFloat("1.234.56") = 1.234). A number passes through unchanged.
 */
function numOf(v: string | number, label: string): number {
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw new Error(`${label}: ungültiger Wert.`);
        return v;
    }
    const n = parseGermanDecimal(v);
    if (n == null) throw new Error(`${label}: ungültiger Wert "${v}".`);
    return n;
}

/** Parse a VAT rate to a fraction (0.19); accepts "19", "19 %", "0,19" or a number. */
function rateOf(v: string | number): number {
    const n = parseVatRate(String(v));
    if (n == null) throw new Error(`Ungültiger USt-Satz "${v}".`);
    return n;
}

/** Map the provider-agnostic input to the store's draft shape. */
function toDraftInput(input: CreateInvoiceInput, deps: SelfProviderDeps): InvoiceDraftInput {
    return {
        entityId: deps.entityId,
        contactId: input.contactId ?? null,
        recipient: deps.resolveRecipient(input),
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        performanceStart: input.performanceStart ?? null,
        performanceEnd: input.performanceEnd ?? null,
        currency: input.currency || 'EUR',
        iban: input.iban || deps.iban,
        buyerReference: input.buyerReference ?? null,
        header: input.header ?? null,
        footer: input.footer ?? null,
        terms: input.termsAndConditions ?? null,
        items: input.items.map((it) => ({
            title: it.title,
            description: it.description ?? null,
            quantity: numOf(it.quantity, `Position „${it.title}": Menge`),
            unit: it.unit ?? null,
            unitPriceNet: numOf(it.unit_price, `Position „${it.title}": Einzelpreis`),
            vatRate: rateOf(it.vat_rate),
        })),
    };
}

export class SelfOutgoingInvoiceProvider implements OutgoingInvoiceProvider {
    readonly name = 'Eigene Erstellung';
    readonly type = 'self' as const;
    readonly capabilities = SELF_CAPABILITIES;

    constructor(private readonly deps: SelfProviderDeps) {}

    validate(input: CreateInvoiceInput): string[] {
        const problems = commonInvoiceProblems(input);
        if (input.currency && input.currency !== 'EUR') problems.push('Eigene Rechnungen: derzeit nur EUR.');
        return problems;
    }

    async createDraft(input: CreateInvoiceInput): Promise<OutgoingInvoiceDraft> {
        const problems = this.validate(input);
        if (problems.length) throw new Error(`Rechnung ungültig:\n- ${problems.join('\n- ')}`);
        const inv = this.deps.withDb((db) => createInvoiceDraft(db, toDraftInput(input, this.deps), this.deps.now()));
        return { id: inv.id, number: inv.number, status: inv.status, url: null, provider: 'self' };
    }

    async updateDraft(id: string, input: CreateInvoiceInput): Promise<OutgoingInvoiceDraft> {
        // Same content checks as createDraft (EUR-only etc.) — an edit must not bypass them.
        const problems = this.validate(input);
        if (problems.length) throw new Error(`Rechnung ungültig:\n- ${problems.join('\n- ')}`);
        const inv = this.deps.withDb((db) =>
            updateInvoiceDraft(db, id, toDraftInput(input, this.deps), this.deps.now()),
        );
        return { id: inv.id, number: inv.number, status: inv.status, url: null, provider: 'self' };
    }

    async deleteDraft(id: string): Promise<void> {
        this.deps.withDb((db) => deleteInvoiceDraft(db, id, this.deps.now()));
    }

    async getInvoice(id: string): Promise<OutgoingInvoiceDetail | null> {
        const inv = this.deps.withDb((db) => repoGetInvoice(db, id));
        return inv ? toDetail(inv) : null;
    }

    async listInvoices(opts: ListOutgoingInvoicesOptions = {}): Promise<OutgoingInvoiceSummary[]> {
        const invoices = this.deps.withDb((db) =>
            repoListInvoices(db, this.deps.entityId, opts.status ? { status: opts.status } : {}),
        );
        return invoices.map(toSummary);
    }

    async finalize(id: string): Promise<OutgoingInvoiceSummary> {
        if (!pdfRenderingAvailable()) {
            throw new Error('Festschreiben benötigt die GJS-Laufzeit für das PDF-Rendering (Cairo/Pango).');
        }
        const issuer = this.deps.resolveIssuer();
        const finalized = this.deps.withDb((db) => {
            const draft = repoGetInvoice(db, id);
            if (!draft) throw new Error(`Rechnung ${id} nicht gefunden.`);
            const recipient = draft.recipient;
            if (!recipient) throw new Error('Empfänger fehlt — bitte im Entwurf einen Kunden hinterlegen.');
            const problems = validateInvoiceForFinalize(draft, issuer, recipient);
            if (problems.length) throw new Error(`Rechnung ungültig:\n- ${problems.join('\n- ')}`);
            return finalizeInvoice(db, id, {
                issuer,
                recipient,
                prefix: this.deps.numberPrefix ?? undefined,
                at: this.deps.now(),
            });
        });
        // The invoice is now legally finalized (number consumed). Archiving is best-effort: if the
        // DMS is briefly unreachable, DON'T report the finalize as failed — otherwise the number is
        // spent but the UI shows an error and a retry says "already finalized". The archive is
        // retried lazily on the next getPdf/getXml (ensureArchived), so GoBD archiving still lands.
        try {
            await this.archive(finalized);
        } catch (err) {
            if (typeof console !== 'undefined') {
                console.error(
                    `[self-invoice] Archivierung nach Festschreiben fehlgeschlagen (wird nachgeholt): ${String(err)}`,
                );
            }
        }
        return toSummary(finalized);
    }

    async markPaid(id: string, opts: { txId?: string; paidAt?: string } = {}): Promise<OutgoingInvoiceSummary> {
        const paidAt = opts.paidAt ?? this.deps.now().slice(0, 10);
        const inv = this.deps.withDb((db) =>
            markInvoicePaid(db, id, { txId: opts.txId ?? null, paidAt }, this.deps.now()),
        );
        // Link the archived outgoing-invoice document to the settling transaction so the tx-driven
        // EÜR / store reconciliation sees the income's supporting document (not just the paid flag).
        if (opts.txId) {
            try {
                const archived = await this.ensureArchived(inv);
                const dms = this.deps.makeDms();
                if (archived.archive.pdfDocumentId && dms.link) {
                    await dms.link(archived.archive.pdfDocumentId, opts.txId);
                }
            } catch {
                /* best-effort — the payment status is already recorded even if the link fails */
            }
        }
        return toSummary(inv);
    }

    async cancel(
        id: string,
        opts: { reason?: string } = {},
    ): Promise<{ storno: OutgoingInvoiceSummary; original: OutgoingInvoiceSummary }> {
        const issuer = this.deps.resolveIssuer();
        const { storno, original } = this.deps.withDb((db) => {
            const inv = repoGetInvoice(db, id);
            return createStornoInvoice(db, id, {
                issuer,
                recipient: inv?.recipient ?? { name: '' },
                prefix: this.deps.numberPrefix ?? undefined,
                at: this.deps.now(),
                reason: opts.reason,
            });
        });
        // Best-effort archive of the storno (it is already legally issued).
        if (pdfRenderingAvailable()) await this.archive(storno, original.number ?? undefined);
        return { storno: toSummary(storno), original: toSummary(original) };
    }

    /**
     * Lazily archive a finalized-but-unarchived invoice (e.g. the DMS was down at finalize). Best-
     * effort + archive-once via setArchivedDocuments, so opening the PDF/XML later completes the
     * GoBD archiving that finalize couldn't. Returns the (possibly re-read) invoice.
     */
    private async ensureArchived(inv: StoredInvoice): Promise<StoredInvoice> {
        if (inv.status === 'draft' || inv.archive.pdfDocumentId || !pdfRenderingAvailable()) return inv;
        try {
            await this.archive(inv, inv.kind === 'storno' ? await this.originalNumber(inv) : undefined);
            return this.deps.withDb((db) => repoGetInvoice(db, inv.id)) ?? inv;
        } catch {
            return inv; // still unarchived; getPdf/getXml fall back to a fresh render
        }
    }

    async getPdf(id: string): Promise<OutgoingInvoiceFile | null> {
        let inv = this.deps.withDb((db) => repoGetInvoice(db, id));
        if (!inv || inv.status === 'draft') return null;
        inv = await this.ensureArchived(inv);
        const filename = `${inv.number}.pdf`;
        const dms = this.deps.makeDms();
        if (inv.archive.pdfDocumentId && dms.getFile) {
            const file = await dms.getFile(inv.archive.pdfDocumentId);
            if (file) return { kind: 'bytes', bytes: file.bytes, filename };
        }
        // Fall back to a deterministic re-render from the frozen snapshot.
        if (!pdfRenderingAvailable()) return null;
        const bytes = await renderInvoicePdf(
            buildInvoicePdfModel(inv, { epcPayload: this.epcFor(inv), logoPath: this.deps.logoPath }),
        );
        return { kind: 'bytes', bytes, filename };
    }

    async getXml(id: string): Promise<OutgoingInvoiceFile | null> {
        let inv = this.deps.withDb((db) => repoGetInvoice(db, id));
        if (!inv || inv.status === 'draft') return null;
        inv = await this.ensureArchived(inv);
        const filename = `${inv.number}.xrechnung.xml`;
        const dms = this.deps.makeDms();
        if (inv.archive.xmlDocumentId && dms.getFile) {
            const file = await dms.getFile(inv.archive.xmlDocumentId);
            if (file) return { kind: 'bytes', bytes: file.bytes, filename };
        }
        const xml = buildCiiInvoiceXml(
            inv,
            inv.kind === 'storno' ? { originalNumber: await this.originalNumber(inv) } : {},
        );
        return { kind: 'bytes', bytes: new TextEncoder().encode(xml), filename };
    }

    /** Render PDF + XML and archive both through the DMS (idempotent via setArchivedDocuments). */
    private async archive(inv: StoredInvoice, originalNumber?: string): Promise<void> {
        const dms = this.deps.makeDms();
        if (!dms.store) return; // Paperless-less / read-only DMS: skip archiving.
        const created = inv.issueDate ?? undefined;
        const pdf = await renderInvoicePdf(
            buildInvoicePdfModel(inv, { epcPayload: this.epcFor(inv), logoPath: this.deps.logoPath }),
        );
        const pdfDoc = await dms.store({
            bytes: pdf,
            filename: `${inv.number}.pdf`,
            mimeType: 'application/pdf',
            created,
        });
        if (dms.setMetadata) {
            await dms.setMetadata(pdfDoc.id, {
                direction: 'outgoing',
                invoiceNumber: inv.number,
                net: inv.totals.net,
                vat: inv.totals.vat,
                gross: inv.totals.gross,
            });
        }
        const xml = buildCiiInvoiceXml(inv, inv.kind === 'storno' ? { originalNumber } : {});
        const xmlDoc = await dms.store({
            bytes: new TextEncoder().encode(xml),
            filename: `${inv.number}.xrechnung.xml`,
            mimeType: 'application/xml',
            created,
        });
        this.deps.withDb((db) =>
            setArchivedDocuments(
                db,
                inv.id,
                { dms: dms.kind, pdfDocumentId: pdfDoc.id, xmlDocumentId: xmlDoc.id },
                this.deps.now(),
            ),
        );
    }

    /** Build the scan-to-pay GiroCode payload (invoices only, positive gross, bank IBAN present). */
    private epcFor(inv: StoredInvoice): string | null {
        if (inv.kind !== 'invoice' || inv.totals.gross <= 0) return null;
        const iban = inv.iban ?? inv.issuer?.bank?.iban ?? null;
        if (!iban || !inv.issuer?.name) return null;
        try {
            return buildEpcPayload({
                name: inv.issuer.name,
                iban,
                amount: inv.totals.gross,
                remittance: inv.number ?? '',
            });
        } catch {
            return null;
        }
    }

    private async originalNumber(storno: StoredInvoice): Promise<string | undefined> {
        if (!storno.stornoOfId) return undefined;
        const original = this.deps.withDb((db) => repoGetInvoice(db, storno.stornoOfId as string));
        return original?.number ?? undefined;
    }
}

/** Map a contact-master record to a §14 recipient block. */
function contactToRecipient(contactId: string): OutgoingInvoiceRecipient | null {
    const c = getContactById(contactId);
    if (!c) return null;
    return {
        name: contactDisplayName(c),
        address: c.address,
        zip: c.zip,
        city: c.city,
        countryCode: c.countryCode,
        vatNumber: c.vatNumber,
        email: c.email,
    };
}

/**
 * Wire the real self-provider deps from config + DMS + ledger. Requires a workspace entity id; a
 * guard provider (methods throw) is returned when it's missing so list/validate stay usable.
 */
export function buildSelfProvider(
    invoicing: EntityInvoicingConfig,
    ctx: OutgoingInvoiceProviderContext,
): OutgoingInvoiceProvider {
    const entityId = ctx.entityId;
    if (!entityId) return new GuardSelfProvider();

    const view = loadEntityInvoicing(entityId, ctx.path);
    const deps: SelfProviderDeps = {
        entityId,
        numberPrefix: view.selfNumberPrefix,
        iban: view.iban,
        logoPath: view.selfIssuer?.logoPath ?? null,
        withDb<T>(fn: (db: LedgerDatabase) => T): T {
            const db = openLedger(ledgerDbPath());
            try {
                migrate(db);
                return fn(db);
            } finally {
                db.close();
            }
        },
        resolveIssuer: () =>
            resolveInvoiceIssuer(view.selfIssuer, elsterIssuerFallback(resolveEntityElster(entityId, ctx.path))),
        makeDms: () => makeDmsForEntity(entityId, ctx.path),
        resolveRecipient: (input) => input.recipient ?? (input.contactId ? contactToRecipient(input.contactId) : null),
        now: () => new Date().toISOString(),
    };
    return new SelfOutgoingInvoiceProvider(deps);
}

/** Build the entity's DMS provider via the shared core builder (built-in default, else Paperless). */
function makeDmsForEntity(entityId: string, path?: string): DmsProvider {
    const dms = resolveWorkspaceEntities([], loadManifest(path)).find((e) => e.id === entityId)?.dms;
    return dmsProviderForEntity(entityId, dms, createAppContext().config);
}

/** Returned when the self provider is selected without an entity id — reads work, writes explain. */
class GuardSelfProvider implements OutgoingInvoiceProvider {
    readonly name = 'Eigene Erstellung';
    readonly type = 'self' as const;
    readonly capabilities = SELF_CAPABILITIES;
    validate(input: CreateInvoiceInput): string[] {
        return commonInvoiceProblems(input);
    }
    private fail(): never {
        throw new Error('Für die eigene Rechnungsverwaltung fehlt die Entität (entityId).');
    }
    createDraft(): Promise<OutgoingInvoiceDraft> {
        return this.fail();
    }
    listInvoices(): Promise<OutgoingInvoiceSummary[]> {
        return this.fail();
    }
}
