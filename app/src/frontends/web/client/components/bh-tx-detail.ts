// <bh-tx-detail> — modal overlay showing ALL available information for one transaction:
// the EÜR classification, the raw bank fields, the linked Paperless receipt, and any
// PayPal / internal-transfer link. Opened from a row click in <bh-transactions-view>.

import { eur, deDate, esc } from '../lib/format.ts';
import { SOURCE_LABEL, KIND_LABEL } from '../lib/view-helpers.ts';
import type { TxRow } from '../lib/api.ts';

export class BhTxDetail extends HTMLElement {
    private base: string | null = null;

    open(row: TxRow, base: string | null) {
        this.base = base;
        this.render(row);
        document.removeEventListener('keydown', this.onKey); // idempotent across re-opens
        document.addEventListener('keydown', this.onKey);
    }

    private close = () => {
        this.innerHTML = '';
        document.removeEventListener('keydown', this.onKey);
    };
    private onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') this.close();
    };

    /** A definition row (value escaped), omitted entirely when the value is empty. */
    private def(label: string, value: string | number | null | undefined): string {
        if (value == null || value === '') return '';
        return `<div class="bh-d-row"><dt>${esc(label)}</dt><dd>${typeof value === 'string' ? esc(value) : value}</dd></div>`;
    }
    /** A definition row whose value is trusted HTML (e.g. a link); label still escaped. */
    private defHtml(label: string, html: string): string {
        if (!html) return '';
        return `<div class="bh-d-row"><dt>${esc(label)}</dt><dd>${html}</dd></div>`;
    }
    private section(title: string, rows: string): string {
        return rows.replace(/\s/g, '')
            ? `<section class="bh-d-sec"><h3>${esc(title)}</h3><dl>${rows}</dl></section>`
            : '';
    }

    private render(r: TxRow) {
        const raw = r.raw;
        const ueberblick =
            this.def('Betrag', eur(r.amount)) +
            this.def('Buchungsdatum', deDate(r.bookingDate)) +
            this.def('Wertstellung', raw?.valueDate ? deDate(raw.valueDate) : '') +
            this.def('Gegenseite', r.counterparty) +
            this.def('Verwendungszweck', r.purpose);

        const klass =
            this.def('Kategorie (EÜR)', r.category) +
            this.def('Kennzahl', r.kz ? `Kz ${r.kz}` : '') +
            this.def('Art', KIND_LABEL[r.kind] ?? r.kind) +
            this.def('Quelle', SOURCE_LABEL[r.source] ?? r.source) +
            this.def('Regel', r.rule) +
            this.def('Netto', eur(r.net)) +
            this.def('Umsatzsteuer', eur(r.vat)) +
            this.def('Brutto', eur(r.gross));

        const bank =
            this.def('Konto', r.account) +
            this.def('Konto-Schlüssel', r.accountKey) +
            this.def('IBAN (eigen)', raw?.iban) +
            this.def('IBAN (Gegenseite)', raw?.counterpartyIban) +
            this.def('Währung', raw?.currency) +
            this.def('Referenz', raw?.reference) +
            this.def('Buchungstext / Typ', raw?.type) +
            this.def('Quelle (Import)', raw?.source) +
            this.def('Transaktions-ID', r.id);

        const beleg = r.receipt
            ? this.def('Rechnungsnummer', r.receipt.invoiceNumber) +
              this.def('Titel', r.receipt.title) +
              this.def('Netto (Beleg)', r.receipt.net != null ? eur(r.receipt.net) : '') +
              this.def('Brutto (Beleg)', r.receipt.gross != null ? eur(r.receipt.gross) : '') +
              this.def('USt (Beleg)', r.receipt.vat != null ? eur(r.receipt.vat) : '') +
              (this.base
                  ? this.defHtml(
                        'Paperless',
                        `<a class="bh-link" href="${esc(this.base)}/documents/${r.receipt.docId}" target="_blank" rel="noreferrer">Dokument #${r.receipt.docId} öffnen ↗</a>`,
                    )
                  : this.def('Paperless', `#${r.receipt.docId}`))
            : '';

        const extra =
            (r.paypal ? this.def('PayPal-Händler', r.paypal.merchant) + this.def('PayPal-Posten', r.paypal.item) : '') +
            (r.transfer
                ? this.def('Umbuchung', `${r.transfer.direction === 'out' ? 'an' : 'von'} ${r.transfer.partner}`)
                : '');

        this.innerHTML = `
      <div class="bh-modal-backdrop" data-close>
        <div class="bh-modal" role="dialog" aria-modal="true" aria-label="Transaktionsdetails">
          <header class="bh-modal-head">
            <div class="bh-modal-title">
              <h2>${esc(r.counterparty || '—')}</h2>
              <div class="bh-modal-sub">${esc(deDate(r.bookingDate))} · ${esc(r.account)}</div>
            </div>
            <div class="bh-modal-amt ${r.amount < 0 ? 'neg' : 'pos'}">${eur(r.amount)}</div>
            <button class="bh-modal-x" data-close aria-label="Schließen">✕</button>
          </header>
          <div class="bh-modal-body">
            ${this.section('Überblick', ueberblick)}
            ${this.section('Klassifizierung (EÜR)', klass)}
            ${this.section('Beleg (Paperless)', beleg)}
            ${this.section('Verknüpfungen', extra)}
            ${this.section('Bank-Details', bank)}
          </div>
        </div>
      </div>`;

        this.querySelectorAll('[data-close]').forEach((el) =>
            el.addEventListener('click', (e) => {
                if (e.target === el) this.close();
            }),
        );
    }
}

customElements.define('bh-tx-detail', BhTxDetail);

declare global {
    interface HTMLElementTagNameMap {
        'bh-tx-detail': BhTxDetail;
    }
}
