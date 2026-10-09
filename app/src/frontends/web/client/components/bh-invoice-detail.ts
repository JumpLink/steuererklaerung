// <bh-invoice-detail> — modal overlay with the full detail of one outgoing invoice: recipient,
// positions, per-VAT-rate totals, dates, payment + storno links, and the lifecycle actions the
// back-end supports (PDF/XRechnung today; finalize/edit/mark-paid/storno wired by later slices).
// Opened from a row click in <bh-rechnungen-view>. Mirrors <bh-tx-detail>.

import type { AdwDataGrid } from '@gjsify/adwaita-web';
import { api, type InvoiceCapabilities, type OutgoingInvoiceDetail, type OutgoingInvoiceSummary } from '../lib/api.ts';
import { deDate, esc, eur } from '../lib/format.ts';
import { alertDialog, confirmDialog } from '../lib/dialogs.ts';

import {
    displayInvoiceStatus,
    INVOICE_STATUS_LABEL,
    normalizeInvoiceStatus,
} from '../../../../core/invoices/status.ts';
import './bh-invoice-form.ts';
import type { BhInvoiceForm } from './bh-invoice-form.ts';
import { q } from '../lib/dom.ts';

const TONE_CLASS: Record<string, string> = {
    draft: 'muted',
    open: 'soon',
    overdue: 'overdue',
    paid: 'upcoming',
    cancelled: 'muted',
};

export class BhInvoiceDetail extends HTMLElement {
    private entity = '';
    private detail: OutgoingInvoiceDetail | null = null;
    private capsRef: InvoiceCapabilities | null = null;
    private onChanged: (() => void) | null = null;
    /** Monotonic open counter — a slow detail fetch for an earlier invoice must not fill a later one. */
    private loadSeq = 0;

    /** Open the modal for one invoice; loads full detail from the back-end. */
    open(summary: OutgoingInvoiceSummary, capabilities: InvoiceCapabilities, entity: string, onChanged?: () => void) {
        this.entity = entity;
        this.capsRef = capabilities;
        this.onChanged = onChanged ?? null;
        this.dataset.invoiceId = summary.id; // set before any actionBar() reads currentId()
        this.renderShell(summary);
        document.removeEventListener('keydown', this.onKey);
        document.addEventListener('keydown', this.onKey);
        void this.load(summary, capabilities);
    }

    private close = () => {
        this.innerHTML = '';
        document.removeEventListener('keydown', this.onKey);
    };
    private onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') this.close();
    };

    private def(label: string, value: string | number | null | undefined): string {
        if (value == null || value === '') return '';
        return `<div class="bh-d-row"><dt>${esc(label)}</dt><dd>${typeof value === 'string' ? esc(value) : value}</dd></div>`;
    }
    private section(title: string, rows: string): string {
        return rows.replace(/\s/g, '')
            ? `<section class="bh-d-sec"><h3>${esc(title)}</h3><dl>${rows}</dl></section>`
            : '';
    }

    /** Modal frame + a loading body; the detail fills in once loaded. */
    private renderShell(inv: OutgoingInvoiceSummary) {
        const today = new Date().toISOString().slice(0, 10);
        const disp = displayInvoiceStatus(inv.status, inv.dueDate, today);
        const who = inv.customerName ?? inv.number ?? 'Rechnung';
        this.innerHTML = `
      <div class="bh-modal-backdrop" data-close>
        <div class="bh-modal" role="dialog" aria-modal="true" aria-label="Rechnungsdetails">
          <header class="bh-modal-head">
            <div class="bh-modal-title">
              <h2>${esc(who)}</h2>
              <div class="bh-modal-sub"><span class="bh-due-badge ${TONE_CLASS[disp] ?? 'muted'}">${esc(INVOICE_STATUS_LABEL[disp])}</span> ${inv.number ? `Nr. ${esc(inv.number)}` : 'ohne Nummer'}</div>
            </div>
            <div class="bh-modal-amt pos">${eur(inv.total)}</div>
            <button class="bh-modal-x" data-close aria-label="Schließen">✕</button>
          </header>
          <div class="bh-modal-body" data-el="body"><div class="bh-loading"><adw-spinner></adw-spinner>Lade Details …</div></div>
        </div>
      </div>`;
        this.wireClose();
    }

    private wireClose() {
        this.querySelectorAll('[data-close]').forEach((el) =>
            el.addEventListener('click', (e) => {
                if (e.target === el) this.close();
            }),
        );
    }

    private async load(summary: OutgoingInvoiceSummary, capabilities: InvoiceCapabilities) {
        const seq = ++this.loadSeq;
        const body = this.querySelector('[data-el="body"]') as HTMLElement | null;
        if (!body) return;
        // Only the self back-end exposes item-level detail; for Qonto we show the summary + PDF link.
        let detail: OutgoingInvoiceDetail | null = null;
        try {
            detail = await api.invoiceDetail(this.entity, summary.id);
        } catch {
            detail = null;
        }
        // Guard against a stale response: if the user opened a different invoice meanwhile, drop this.
        if (seq !== this.loadSeq) return;
        this.detail = detail;
        body.innerHTML = detail
            ? this.renderDetail(detail, capabilities)
            : this.renderSummaryOnly(summary, capabilities);
        this.wireActions();
        this.wireInvoiceGrid();
    }

    /** Populate the positions grid (adw-data-grid property API) from the loaded detail. */
    private wireInvoiceGrid() {
        const d = this.detail;
        const grid = q<AdwDataGrid>(this, '[data-el="invoice-items"]');
        if (!d || !grid) return;
        grid.columns = [
            { key: 'pos', label: 'Pos.', width: '3rem' },
            { key: 'title', label: 'Bezeichnung', flex: 2 },
            { key: 'qty', label: 'Menge', numeric: true },
            { key: 'price', label: 'Einzelpreis', numeric: true },
            { key: 'vat', label: 'USt', numeric: true },
            { key: 'net', label: 'Netto', numeric: true },
        ];
        // Cell values are pre-formatted strings; the grid renders them as text (no escaping needed).
        grid.rows = d.items.map((it, i) => ({
            pos: String(i + 1),
            title: it.description ? `${it.title} · ${it.description}` : it.title,
            qty: `${it.quantity}${it.unit ? ` ${it.unit}` : ''}`,
            price: eur(it.unitPrice),
            vat: `${(it.vatRate * 100).toLocaleString('de-DE')} %`,
            net: eur(it.net),
        }));
    }

    /** Wire the capability-gated action buttons after the body renders. */
    private wireActions() {
        this.querySelector('[data-action="edit"]')?.addEventListener('click', () => this.edit());
        this.querySelector('[data-action="finalize"]')?.addEventListener('click', () => void this.finalize());
        this.querySelector('[data-action="mark-paid"]')?.addEventListener('click', () => void this.openPaidPanel());
        this.querySelector('[data-action="cancel"]')?.addEventListener('click', () => void this.storno());
        this.querySelector('[data-action="delete"]')?.addEventListener('click', () => void this.deleteDraft());
    }

    /** Delete the draft (destructive confirmation). */
    private async deleteDraft() {
        const ok = await confirmDialog({
            heading: 'Entwurf löschen?',
            body: 'Der Rechnungsentwurf wird endgültig entfernt.',
            confirmLabel: 'Löschen',
            destructive: true,
        });
        if (!ok) return;
        try {
            await api.deleteInvoiceDraft(this.entity, this.currentId());
            this.onChanged?.();
            this.close();
        } catch (err) {
            await alertDialog({
                heading: 'Löschen fehlgeschlagen',
                body: err instanceof Error ? err.message : String(err),
                choices: [{ id: 'ok', label: 'OK', appearance: 'suggested' }],
            });
        }
    }

    /** Inline "mark paid" panel: a date + the suggested settling transactions. */
    private async openPaidPanel() {
        const host = this.querySelector('.bh-invoice-actions');
        if (!host) return;
        const today = new Date().toISOString().slice(0, 10);
        host.innerHTML = `<div class="bh-paid-panel">
        <label class="bh-paid-date">Bezahlt am <input type="date" value="${esc(today)}" data-el="paid-date"></label>
        <div class="bh-muted bh-set-note" data-el="cand-status">Suche passende Zahlungen …</div>
        <div data-el="candidates"></div>
        <div class="bh-invoice-actions">
          <button class="adw-button suggested-action" data-el="paid-none">Ohne Transaktion buchen</button>
          <button class="adw-button flat" data-el="paid-cancel">Abbrechen</button>
        </div>
      </div>`;
        host.querySelector('[data-el="paid-cancel"]')?.addEventListener('click', () => this.reloadDetail());
        const dateOf = () => (host.querySelector('[data-el="paid-date"]') as HTMLInputElement | null)?.value || today;
        host.querySelector('[data-el="paid-none"]')?.addEventListener(
            'click',
            () => void this.markPaid(dateOf(), undefined),
        );

        try {
            const candidates = await api.paymentCandidates(this.entity, this.currentId());
            const status = host.querySelector('[data-el="cand-status"]');
            const box = host.querySelector('[data-el="candidates"]');
            if (!box) return;
            if (!candidates.length) {
                if (status) status.textContent = 'Keine passende Buchung gefunden — du kannst ohne Transaktion buchen.';
                return;
            }
            if (status) status.textContent = 'Passende Zahlungseingänge — zum Verknüpfen anklicken:';
            box.innerHTML = candidates
                .map(
                    (c) => `<button class="adw-button flat bh-cand" data-tx="${esc(c.txId)}">
              ${esc(deDate(c.bookingDate))} · ${eur(c.amount)} · ${esc(c.counterparty || c.accountKey)}
            </button>`,
                )
                .join('');
            box.querySelectorAll('[data-tx]').forEach((b) =>
                b.addEventListener('click', () => void this.markPaid(dateOf(), (b as HTMLElement).dataset.tx)),
            );
        } catch {
            const status = host.querySelector('[data-el="cand-status"]');
            if (status) status.textContent = 'Zahlungsvorschläge nicht verfügbar — du kannst ohne Transaktion buchen.';
        }
    }

    private async markPaid(paidOn: string, txId?: string) {
        try {
            await api.markInvoicePaid(this.entity, this.currentId(), { paidOn, txId });
            this.onChanged?.();
            this.close();
        } catch (err) {
            await alertDialog({
                heading: 'Als bezahlt markieren fehlgeschlagen',
                body: err instanceof Error ? err.message : String(err),
                choices: [{ id: 'ok', label: 'OK', appearance: 'suggested' }],
            });
        }
    }

    /** Cancel via storno (destructive confirmation). */
    private async storno() {
        const ok = await confirmDialog({
            heading: 'Rechnung stornieren?',
            body: 'Es wird eine Stornorechnung erstellt; die Rechnung gilt danach als aufgehoben. Dieser Schritt ist unwiderruflich.',
            confirmLabel: 'Stornieren',
            destructive: true,
        });
        if (!ok) return;
        try {
            await api.cancelInvoice(this.entity, this.currentId());
            this.onChanged?.();
            this.close();
        } catch (err) {
            await alertDialog({
                heading: 'Stornieren fehlgeschlagen',
                body: err instanceof Error ? err.message : String(err),
                choices: [{ id: 'ok', label: 'OK', appearance: 'suggested' }],
            });
        }
    }

    /** Re-open the modal for the same invoice (used to leave the mark-paid panel). */
    private reloadDetail() {
        const body = this.querySelector('[data-el="body"]') as HTMLElement | null;
        if (body && this.detail) {
            body.innerHTML = this.renderDetail(this.detail, this.currentCaps());
            this.wireActions();
            // renderDetail() re-creates the Positionen adw-data-grid; its rows are injected via the
            // grid's property API, so it must be re-populated too (load() pairs the same two calls).
            this.wireInvoiceGrid();
        }
    }

    private currentCaps(): InvoiceCapabilities {
        return this.capsRef as InvoiceCapabilities;
    }

    /** Open the create/edit form prefilled with this draft. */
    private edit() {
        if (!this.detail) return;
        let form = document.querySelector('bh-invoice-form') as BhInvoiceForm | null;
        if (!form) {
            form = document.createElement('bh-invoice-form') as BhInvoiceForm;
            document.body.appendChild(form);
        }
        void form.open(this.entity, this.detail, () => {
            this.onChanged?.();
            this.close();
        });
    }

    /** Festschreiben with an irreversible-action confirmation. */
    private async finalize() {
        const ok = await confirmDialog({
            heading: 'Rechnung festschreiben?',
            body: 'Die Rechnung erhält eine fortlaufende Nummer und kann danach nicht mehr bearbeitet werden. Dieser Schritt ist unwiderruflich.',
            confirmLabel: 'Festschreiben',
        });
        if (!ok) return;
        try {
            await api.finalizeInvoice(this.entity, this.currentId());
            this.onChanged?.();
            this.close();
        } catch (err) {
            await alertDialog({
                heading: 'Festschreiben fehlgeschlagen',
                body: err instanceof Error ? err.message : String(err),
                choices: [{ id: 'ok', label: 'OK', appearance: 'suggested' }],
            });
        }
    }

    /** Positions table + amounts + dates + payment/storno + actions (self detail). */
    private renderDetail(d: OutgoingInvoiceDetail, caps: InvoiceCapabilities): string {
        // Positions render into an adw-data-grid (populated via its property API in wireInvoiceGrid()).
        const vatLines = d.totals.byRate
            .map((r) => this.def(`USt ${(r.rate * 100).toLocaleString('de-DE')} %`, eur(r.vat)))
            .join('');
        const amounts =
            this.def('Nettobetrag', eur(d.totals.net)) + vatLines + this.def('Bruttobetrag', eur(d.totals.gross));

        const dates =
            this.def('Rechnungsdatum', deDate(d.issueDate)) +
            this.def('Fällig bis', deDate(d.dueDate)) +
            (d.performanceStart && d.performanceEnd
                ? this.def('Leistungszeitraum', `${deDate(d.performanceStart)} – ${deDate(d.performanceEnd)}`)
                : this.def('Leistungsdatum', deDate(d.performanceStart ?? d.performanceEnd))) +
            this.def('Empfänger', d.recipient?.name) +
            this.def('USt-IdNr. Empfänger', d.recipient?.vatNumber);

        const payment =
            this.def('Bezahlt am', deDate(d.paidOn)) +
            (d.paidTxId ? this.def('Verknüpfte Transaktion', d.paidTxId) : '');
        const storno =
            (d.cancelsId ? this.def('Storniert Rechnung', d.cancelsId) : '') +
            (d.cancelledById ? this.def('Storniert durch', d.cancelledById) : '');

        return `
      <section class="bh-d-sec"><h3>Positionen</h3><adw-data-grid data-el="invoice-items" class="bh-invoice-grid"></adw-data-grid></section>
      ${this.section('Beträge', amounts)}
      ${this.section('Daten', dates)}
      ${this.section('Zahlung', payment)}
      ${this.section('Storno', storno)}
      ${this.actionBar(d.status, caps, d)}`;
    }

    /** Qonto (no item detail): show a hint + the hosted PDF link. */
    private renderSummaryOnly(inv: OutgoingInvoiceSummary, caps: InvoiceCapabilities): string {
        const info =
            this.def('Rechnungsdatum', deDate(inv.issueDate)) +
            this.def('Fällig bis', deDate(inv.dueDate)) +
            this.def('Betrag', eur(inv.total));
        return `${this.section('Übersicht', info)}
      <p class="bh-muted bh-set-note">Für dieses Back-End sind keine Positionsdetails verfügbar.</p>
      ${this.actionBar(inv.status, caps, inv)}`;
    }

    /** Lifecycle action buttons, gated by capabilities + status. */
    private actionBar(status: string, caps: InvoiceCapabilities, inv: { url: string | null }): string {
        const buttons: string[] = [];
        const isDraft = status === 'draft';
        // Draft-only: edit + finalize (wired via data-action in wireActions()).
        if (isDraft && caps.editDraft) {
            buttons.push(`<button class="adw-button" data-action="edit">Bearbeiten</button>`);
        }
        if (isDraft && caps.finalize) {
            buttons.push(`<button class="adw-button suggested-action" data-action="finalize">Festschreiben</button>`);
        }
        if (isDraft && caps.deleteDraft) {
            buttons.push(`<button class="adw-button destructive-action" data-action="delete">Entwurf löschen</button>`);
        }
        if (caps.pdf === 'local' && !isDraft) {
            buttons.push(
                `<a class="adw-button" href="${esc(api.invoicePdfUrl(this.entity, this.currentId()))}" target="_blank" rel="noopener">PDF öffnen</a>`,
            );
        } else if (caps.pdf === 'hosted' && inv.url) {
            buttons.push(
                `<a class="adw-button" href="${esc(inv.url)}" target="_blank" rel="noopener">In Qonto öffnen</a>`,
            );
        }
        if (caps.xml && !isDraft) {
            buttons.push(
                `<a class="adw-button flat" href="${esc(api.invoiceXmlUrl(this.entity, this.currentId()))}" target="_blank" rel="noopener">XRechnung (XML)</a>`,
            );
        }
        const norm = normalizeInvoiceStatus(status);
        if (norm === 'open' && caps.markPaid) {
            buttons.push(`<button class="adw-button" data-action="mark-paid">Als bezahlt markieren</button>`);
        }
        if ((norm === 'open' || norm === 'paid') && caps.cancelStorno) {
            buttons.push(`<button class="adw-button destructive-action" data-action="cancel">Stornieren</button>`);
        }
        return buttons.length ? `<div class="bh-invoice-actions">${buttons.join('')}</div>` : '';
    }

    private currentId(): string {
        return this.dataset.invoiceId ?? '';
    }
}

customElements.define('bh-invoice-detail', BhInvoiceDetail);

declare global {
    interface HTMLElementTagNameMap {
        'bh-invoice-detail': BhInvoiceDetail;
    }
}
