// <bh-rechnungen-view> — "Rechnungen": outgoing invoices for the active entity. Lists the
// recurring schedules (overdue · due-soon · upcoming) with one-click draft creation, plus the
// full "Alle Rechnungen" listing pulled from the entity's invoicing back-end (Qonto today, the
// own creation later — both go through the same provider). The back-end itself is configured in
// Einstellungen → Rechnungsstellung. Entity-scoped (not year-scoped); reads /api/recurring +
// /api/invoices.

import { api, type InvoiceCapabilities, type OutgoingInvoiceSummary, type RecurringDueEntry } from '../lib/api.ts';
import { deDate, esc, eur } from '../lib/format.ts';
import './bh-invoice-detail.ts';
import type { BhInvoiceDetail } from './bh-invoice-detail.ts';
import './bh-invoice-form.ts';
import type { BhInvoiceForm } from './bh-invoice-form.ts';
import {
    type DisplayInvoiceStatus,
    displayInvoiceStatus,
    INVOICE_STATUS_LABEL,
} from '../../../../core/invoices/status.ts';

/** Status label + CSS modifier for a recurring reminder row. */
const DUE_META: Record<RecurringDueEntry['status'], { label: string; cls: string }> = {
    overdue: { label: 'überfällig', cls: 'overdue' },
    'due-soon': { label: 'bald fällig', cls: 'soon' },
    upcoming: { label: 'geplant', cls: 'upcoming' },
    paused: { label: 'pausiert', cls: 'muted' },
    cancelled: { label: 'storniert', cls: 'muted' },
};

/** Badge CSS class per normalized display status (shared vocabulary from invoices/status.ts). */
const STATUS_CLASS: Record<DisplayInvoiceStatus, string> = {
    draft: 'muted',
    open: 'soon',
    overdue: 'overdue',
    paid: 'upcoming',
    cancelled: 'muted',
};

/** Filter chips over the "Alle Rechnungen" list, matched against the display status. */
const FILTERS: { key: 'all' | DisplayInvoiceStatus; label: string }[] = [
    { key: 'all', label: 'Alle' },
    { key: 'draft', label: 'Entwürfe' },
    { key: 'open', label: 'Offen' },
    { key: 'overdue', label: 'Überfällig' },
    { key: 'paid', label: 'Bezahlt' },
    { key: 'cancelled', label: 'Storniert' },
];

export class BhRechnungenView extends HTMLElement {
    private entity = '';
    private entries: RecurringDueEntry[] = [];
    private invoices: OutgoingInvoiceSummary[] | null = null;
    private invoicesError = '';
    private capabilities: InvoiceCapabilities | null = null;
    private filter: 'all' | DisplayInvoiceStatus = 'all';
    private today = new Date().toISOString().slice(0, 10);

    async connectedCallback() {
        this.entity = this.getAttribute('entity') ?? '';
        this.innerHTML = `<div class="bh-loading"><adw-spinner></adw-spinner>Lade Rechnungen …</div>`;
        try {
            this.entries = this.entity ? await api.recurring(this.entity) : [];
            // Capabilities are a cheap local read — used to gate future create/finalize actions.
            if (this.entity) {
                try {
                    this.capabilities = (await api.invoiceCapabilities(this.entity)).capabilities;
                } catch {
                    this.capabilities = null;
                }
            }
            this.render();
            // The full Qonto listing is a slow outbound fetch — load it in the background and
            // fill the "Alle Rechnungen" section once it arrives (the recurring view is usable now).
            void this.loadInvoices();
        } catch (err) {
            this.innerHTML = `<adw-card class="bh-error">Fehler: ${esc(err instanceof Error ? err.message : err)}</adw-card>`;
        }
    }

    /** The display status of an invoice (normalized + overdue-derived). */
    private dispStatus(inv: OutgoingInvoiceSummary): DisplayInvoiceStatus {
        return displayInvoiceStatus(inv.status, inv.dueDate, this.today);
    }

    /** Fetch the full invoice list (background) and re-render just the "Alle Rechnungen" section. */
    private async loadInvoices() {
        if (!this.entity) {
            this.invoices = [];
            this.renderAllInvoices();
            return;
        }
        try {
            this.invoices = await api.invoices(this.entity);
        } catch (err) {
            this.invoicesError = err instanceof Error ? err.message : String(err);
        }
        this.renderAllInvoices();
    }

    /** One schedule row: status badge + customer + period/amount + a "create draft" button. */
    private row(e: RecurringDueEntry): string {
        const m = DUE_META[e.status];
        const what = e.description ?? (e.domains.join(', ') || e.customer);
        const when =
            e.daysUntilDue < 0
                ? `seit ${Math.abs(e.daysUntilDue)} Tagen`
                : e.daysUntilDue === 0
                  ? 'heute'
                  : `in ${e.daysUntilDue} Tagen`;
        const last = e.lastInvoiceNumber ? ` · zuletzt ${esc(e.lastInvoiceNumber)}` : '';
        const canCreate = e.status === 'overdue' || e.status === 'due-soon' || e.status === 'upcoming';
        const btn = canCreate
            ? `<button class="adw-button suggested-action" data-create="${esc(e.id)}">Entwurf erstellen</button>`
            : '';
        return `<div class="bh-setrow">
        <div class="bh-setrow-text">
          <strong><span class="bh-due-badge ${m.cls}">${esc(m.label)}</span> ${esc(e.customer)}</strong>
          <small>${esc(what)} · fällig ${deDate(e.dueDate)} (${esc(when)}) · ${eur(e.totals.gross)}${last}</small>
        </div>
        ${btn}
        <span class="bh-set-status bh-muted" data-el="create-status-${esc(e.id)}"></span>
      </div>`;
    }

    private render() {
        const overdue = this.entries.filter((e) => e.status === 'overdue').length;
        const soon = this.entries.filter((e) => e.status === 'due-soon').length;
        const summary = this.entries.length
            ? `${overdue} überfällig · ${soon} bald fällig · ${this.entries.length} gesamt`
            : 'keine wiederkehrenden Rechnungen erfasst';
        const list = this.entries.length
            ? this.entries.map((e) => this.row(e)).join('')
            : `<p class="bh-muted bh-set-note">Noch keine wiederkehrenden Rechnungen. Pflege sie in <code>recurring-invoices.json</code>.</p>`;

        const newBtn = this.capabilities?.createDraft
            ? `<button class="adw-button suggested-action" data-el="new-invoice">Neue Rechnung</button>`
            : '';

        this.innerHTML = `
      <header class="bh-view-head">${newBtn}</header>

      <div class="bh-kpi-grid" data-el="kpis"></div>

      <div class="bh-subhead">Wiederkehrende Rechnungen <span class="bh-muted">· ${esc(summary)}</span></div>
      <div class="bh-setlist">${list}</div>

      <div class="bh-subhead" data-el="all-invoices-head">Alle Rechnungen</div>
      <div class="bh-setlist" data-el="all-invoices"></div>`;

        this.querySelectorAll('[data-create]').forEach((b) =>
            b.addEventListener(
                'click',
                () => void this.createInvoice((b as HTMLElement).dataset.create ?? '', b as HTMLButtonElement),
            ),
        );
        this.querySelector('[data-el="new-invoice"]')?.addEventListener('click', () => this.newInvoice());
        this.renderAllInvoices();
    }

    /** Open the create form for a fresh invoice; reload the list on save. */
    private newInvoice() {
        let form = document.querySelector('bh-invoice-form') as BhInvoiceForm | null;
        if (!form) {
            form = document.createElement('bh-invoice-form') as BhInvoiceForm;
            document.body.appendChild(form);
        }
        void form.open(this.entity, null, () => void this.loadInvoices());
    }

    /** One issued-invoice row: status badge + customer/number + date/amount; the whole row opens detail. */
    private invoiceRow(inv: OutgoingInvoiceSummary): string {
        const disp = this.dispStatus(inv);
        const who = inv.customerName ?? inv.number ?? inv.clientId ?? 'Rechnung';
        const parts = [
            inv.number ? `Nr. ${esc(inv.number)}` : 'ohne Nummer',
            inv.issueDate ? `ausgestellt ${deDate(inv.issueDate)}` : '',
            inv.dueDate ? `fällig ${deDate(inv.dueDate)}` : '',
            eur(inv.total),
        ].filter(Boolean);
        return `<div class="bh-setrow bh-setrow-click" data-open="${esc(inv.id)}" role="button" tabindex="0">
        <div class="bh-setrow-text">
          <strong><span class="bh-due-badge ${STATUS_CLASS[disp]}">${esc(INVOICE_STATUS_LABEL[disp])}</span> ${esc(who)}</strong>
          <small>${parts.join(' · ')}</small>
        </div>
        <span class="bh-set-chevron">›</span>
      </div>`;
    }

    /** Filter chips over the invoice list (client-side; counts per state). */
    private filterChips(): string {
        const invoices = this.invoices ?? [];
        const chip = (f: { key: 'all' | DisplayInvoiceStatus; label: string }) => {
            const n = f.key === 'all' ? invoices.length : invoices.filter((i) => this.dispStatus(i) === f.key).length;
            const active = this.filter === f.key ? ' suggested-action' : ' flat';
            return `<button class="adw-button${active} bh-chip" data-filter="${f.key}">${esc(f.label)}${n ? ` (${n})` : ''}</button>`;
        };
        return `<div class="bh-chiprow">${FILTERS.map(chip).join('')}</div>`;
    }

    /**
     * Design: lead the view with a KPI-card row — Offen (open + overdue) · Überfällig · Bezahlt
     * totals over the loaded invoice list, using the home KPI card markup. Shows a placeholder
     * until the (background) invoice fetch resolves; recomputed on every renderAllInvoices().
     */
    private renderKpis() {
        const box = this.querySelector('[data-el="kpis"]');
        if (!box) return;
        if (this.invoices === null) {
            box.innerHTML = ['Offen', 'Überfällig', 'Bezahlt']
                .map(
                    (l) =>
                        `<div class="bh-kpi"><div class="bh-kpi-l">${esc(l)}</div><div class="bh-kpi-n bh-muted">…</div></div>`,
                )
                .join('');
            return;
        }
        const agg = (pred: (d: DisplayInvoiceStatus) => boolean): { total: number; count: number } => {
            let total = 0;
            let count = 0;
            for (const inv of this.invoices ?? []) {
                if (!pred(this.dispStatus(inv))) continue;
                total += inv.total ?? 0;
                count += 1;
            }
            return { total, count };
        };
        const open = agg((d) => d === 'open' || d === 'overdue');
        const overdue = agg((d) => d === 'overdue');
        const paid = agg((d) => d === 'paid');
        box.innerHTML = `
        <div class="bh-kpi"><div class="bh-kpi-l">Offen</div><div class="bh-kpi-n">${eur(open.total)}</div><div class="bh-kpi-s">${esc(open.count)} Rechnung(en)</div></div>
        <div class="bh-kpi"><div class="bh-kpi-l">Überfällig</div><div class="bh-kpi-n${overdue.total > 0 ? ' neg' : ''}">${eur(overdue.total)}</div><div class="bh-kpi-s">${esc(overdue.count)} Rechnung(en)</div></div>
        <div class="bh-kpi"><div class="bh-kpi-l">Bezahlt</div><div class="bh-kpi-n pos">${eur(paid.total)}</div><div class="bh-kpi-s">${esc(paid.count)} Rechnung(en)</div></div>`;
    }

    /** Fill the "Alle Rechnungen" section based on load state (loading / error / filtered list). */
    private renderAllInvoices() {
        this.renderKpis();
        const head = this.querySelector('[data-el="all-invoices-head"]');
        const box = this.querySelector('[data-el="all-invoices"]');
        if (!box || !head) return;
        if (this.invoicesError) {
            head.innerHTML = 'Alle Rechnungen';
            box.innerHTML = `<p class="bh-muted bh-set-note">Konnte die Rechnungen nicht laden: ${esc(this.invoicesError)}</p>`;
            return;
        }
        if (this.invoices === null) {
            head.innerHTML = 'Alle Rechnungen';
            box.innerHTML = `<p class="bh-muted bh-set-note">Lade Rechnungen aus dem Back-End …</p>`;
            return;
        }
        head.innerHTML = `Alle Rechnungen <span class="bh-muted">· ${this.invoices.length} gesamt</span>`;
        const shown = this.invoices.filter((i) => this.filter === 'all' || this.dispStatus(i) === this.filter);
        box.innerHTML =
            this.filterChips() +
            (shown.length
                ? shown.map((inv) => this.invoiceRow(inv)).join('')
                : `<p class="bh-muted bh-set-note">Keine Rechnungen in dieser Ansicht.</p>`);
        // Filter chips.
        box.querySelectorAll('[data-filter]').forEach((b) =>
            b.addEventListener('click', () => {
                this.filter = (b as HTMLElement).dataset.filter as 'all' | DisplayInvoiceStatus;
                this.renderAllInvoices();
            }),
        );
        // Row clicks → detail modal.
        box.querySelectorAll('[data-open]').forEach((row) => {
            const open = () => this.openDetail((row as HTMLElement).dataset.open ?? '');
            row.addEventListener('click', open);
            row.addEventListener('keydown', (e) => {
                if ((e as KeyboardEvent).key === 'Enter' || (e as KeyboardEvent).key === ' ') {
                    e.preventDefault();
                    open();
                }
            });
        });
    }

    /** Open the singleton detail modal for one invoice id. */
    private openDetail(id: string) {
        const inv = this.invoices?.find((i) => i.id === id);
        if (!inv || !this.capabilities) return;
        let modal = document.querySelector('bh-invoice-detail') as BhInvoiceDetail | null;
        if (!modal) {
            modal = document.createElement('bh-invoice-detail') as BhInvoiceDetail;
            document.body.appendChild(modal);
        }
        modal.open(inv, this.capabilities, this.entity, () => void this.loadInvoices());
    }

    /** Create a Qonto draft for one schedule, then surface the draft number + a link to Qonto. */
    private async createInvoice(id: string, btn: HTMLButtonElement) {
        const status = this.querySelector(`[data-el="create-status-${id}"]`) as HTMLElement | null;
        btn.disabled = true;
        if (status) status.textContent = 'Erstelle Entwurf …';
        try {
            const res = await api.createRecurring(id);
            if (status) {
                status.textContent = res.draft?.number
                    ? `✓ Entwurf ${res.draft.number} erstellt`
                    : '✓ Entwurf erstellt';
                if (res.draft?.url) {
                    const a = document.createElement('a');
                    a.href = res.draft.url;
                    a.target = '_blank';
                    a.rel = 'noopener';
                    a.textContent = ' – in Qonto öffnen';
                    status.appendChild(a);
                }
            }
            // The schedule advanced server-side; the list refreshes on the next mount (tab switch).
        } catch (err) {
            if (status) status.textContent = `Fehler: ${err instanceof Error ? err.message : err}`;
        } finally {
            btn.disabled = false;
        }
    }
}

customElements.define('bh-rechnungen-view', BhRechnungenView);

declare global {
    interface HTMLElementTagNameMap {
        'bh-rechnungen-view': BhRechnungenView;
    }
}
