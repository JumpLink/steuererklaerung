// <bh-invoice-form> — create / edit an outgoing DRAFT invoice (self back-end). An
// adw-preferences-dialog (kontakte-view pattern) with a customer picker, header dates and a
// DYNAMIC list of position rows (add/remove adw-expander-rows at runtime), plus a live
// net/USt/Brutto preview. On save it validates (invoices/form.ts), builds a CreateInvoiceInput and
// calls api.saveInvoiceDraft. Appended to <body>; removed on dismissal.

import type { Adw } from '@gjsify/adwaita-web';
import { api, type Contact, type CreateInvoiceInput, type OutgoingInvoiceDetail } from '../lib/api.ts';
import { alertDialog } from '../lib/dialogs.ts';
import { esc, eur } from '../lib/format.ts';
import {
    computeFormTotals,
    emptyItem,
    type InvoiceItemDraft,
    validateFormDraft,
} from '../../../../core/invoices/form.ts';
import { q, qc } from '../lib/dom.ts';

const VAT_OPTIONS = ['19', '7', '0'];
const vatIndex = (rate: number): number => Math.max(0, VAT_OPTIONS.indexOf(String(Math.round(rate * 100))));

/** Add `days` to a YYYY-MM-DD date. */
function addDays(iso: string, days: number): string {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD dates, or null if either is missing/unparseable. */
function daysBetween(from: string | null, to: string | null): number | null {
    if (!from || !to) return null;
    const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
    const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return Math.round((b - a) / 86_400_000);
}

export class BhInvoiceForm extends HTMLElement {
    private entity = '';
    private customers: Contact[] = [];
    private editId: string | null = null;
    /** The invoice being edited — its non-form fields (header/footer/terms/…) must survive a save. */
    private existing: OutgoingInvoiceDetail | null = null;
    private dlg: Adw.PreferencesDialog | null = null;
    private onSaved: (() => void) | null = null;

    /** Open the form. `existing` prefills for an edit; `onSaved` refreshes the caller. */
    async open(entity: string, existing: OutgoingInvoiceDetail | null, onSaved: () => void) {
        this.entity = entity;
        this.editId = existing?.id ?? null;
        this.existing = existing;
        this.onSaved = onSaved;
        try {
            this.customers = (await api.contacts(entity)).filter((c) => c.isCustomer);
        } catch {
            this.customers = [];
        }
        this.render(existing);
    }

    private render(existing: OutgoingInvoiceDetail | null) {
        const today = new Date().toISOString().slice(0, 10);
        // On edit, prefill the payment term from the existing dates so re-saving reproduces the
        // same due date instead of silently jumping to issueDate+14.
        const termDays = daysBetween(existing?.issueDate ?? null, existing?.dueDate ?? null) ?? 14;
        const dlg = qc<Adw.PreferencesDialog>('adw-preferences-dialog');
        this.dlg = dlg;
        dlg.setAttribute('title', existing ? 'Rechnung bearbeiten' : 'Neue Rechnung');
        dlg.setAttribute('content-width', '620');

        const customerItems = JSON.stringify(
            this.customers.map((c) => (c.name ?? `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim()) || c.id),
        );
        const selectedCustomer = existing?.contactId
            ? Math.max(
                  0,
                  this.customers.findIndex((c) => c.id === existing.contactId),
              )
            : 0;
        const emptyHint = this.customers.length
            ? ''
            : `<p class="bh-muted bh-set-note">Kein Kunde vorhanden — lege zuerst einen unter <strong>Kontakte</strong> an.</p>`;

        dlg.innerHTML = `
      <adw-preferences-page>
        <adw-preferences-group title="Empfänger">
          ${this.customers.length ? `<adw-combo-row data-f="customer" title="Kunde" model='${esc(customerItems)}' selected="${selectedCustomer}"></adw-combo-row>` : ''}
          ${emptyHint}
        </adw-preferences-group>
        <adw-preferences-group title="Eckdaten">
          <adw-entry-row data-f="issueDate" title="Ausstellungsdatum (JJJJ-MM-TT)" text="${esc(existing?.issueDate ?? today)}"></adw-entry-row>
          <adw-entry-row data-f="termDays" title="Zahlungsziel (Tage)" text="${esc(String(termDays))}"></adw-entry-row>
          <adw-entry-row data-f="perfStart" title="Leistung von (optional)" text="${esc(existing?.performanceStart ?? '')}"></adw-entry-row>
          <adw-entry-row data-f="perfEnd" title="Leistung bis (optional)" text="${esc(existing?.performanceEnd ?? '')}"></adw-entry-row>
        </adw-preferences-group>
        <adw-preferences-group title="Positionen" data-el="items"></adw-preferences-group>
        <adw-preferences-group>
          <div class="bh-invoice-total" data-el="totals"></div>
          <adw-button-row data-el="add" title="＋ Position hinzufügen"></adw-button-row>
          <adw-button-row data-el="save" class="suggested-action" title="Entwurf speichern"></adw-button-row>
        </adw-preferences-group>
      </adw-preferences-page>`;

        document.body.appendChild(dlg);
        dlg.addEventListener('closed', () => {
            dlg.remove();
            this.dlg = null;
        });

        // Seed the item rows (existing items, else one empty row).
        const seed: InvoiceItemDraft[] = existing?.items.length
            ? existing.items.map((it) => ({
                  title: it.title,
                  description: it.description ?? '',
                  quantity: String(it.quantity),
                  unit: it.unit ?? '',
                  unitPrice: String(it.unitPrice),
                  vatRate: String(Math.round(it.vatRate * 100)),
              }))
            : [emptyItem()];
        for (const it of seed) this.addItemRow(it);

        dlg.querySelector('[data-el="add"]')?.addEventListener('activated', () => this.addItemRow(emptyItem()));
        dlg.querySelector('[data-el="save"]')?.addEventListener('activated', () => void this.save());
        this.updateTotals();
        dlg.present();
    }

    /** Append one position expander row and wire its remove button + live recompute. */
    private addItemRow(item: InvoiceItemDraft) {
        const group = this.dlg?.querySelector('[data-el="items"]');
        if (!group) return;
        const row = document.createElement('adw-expander-row');
        row.classList.add('bh-item-row');
        row.setAttribute('title', item.title || 'Neue Position');
        row.innerHTML = `
      <adw-entry-row data-f="title" title="Bezeichnung" text="${esc(item.title)}"></adw-entry-row>
      <adw-entry-row data-f="description" title="Beschreibung (optional)" text="${esc(item.description ?? '')}"></adw-entry-row>
      <adw-entry-row data-f="quantity" title="Menge" text="${esc(item.quantity)}"></adw-entry-row>
      <adw-entry-row data-f="unit" title="Einheit (optional)" text="${esc(item.unit ?? '')}"></adw-entry-row>
      <adw-entry-row data-f="unitPrice" title="Einzelpreis netto (€)" text="${esc(item.unitPrice)}"></adw-entry-row>
      <adw-combo-row data-f="vatRate" title="USt-Satz" model='["19 %","7 %","0 %"]' selected="${vatIndex(Number(item.vatRate) / 100)}"></adw-combo-row>
      <adw-button-row data-el="remove" class="destructive-action" title="Position entfernen"></adw-button-row>`;
        group.appendChild(row);
        row.querySelector('[data-el="remove"]')?.addEventListener('activated', () => {
            row.remove();
            this.updateTotals();
        });
        // Recompute totals + refresh the row title as the user types.
        row.addEventListener('input', () => {
            const title = q<Adw.EntryRow>(row, 'adw-entry-row[data-f="title"]')?.text;
            row.setAttribute('title', title?.trim() || 'Neue Position');
            this.updateTotals();
        });
        this.updateTotals();
    }

    /** Read the current item rows from the DOM. */
    private readItems(): InvoiceItemDraft[] {
        const rows = Array.from(this.dlg?.querySelectorAll('.bh-item-row') ?? []);
        return rows.map((row) => {
            const text = (n: string) => q<Adw.EntryRow>(row, `adw-entry-row[data-f="${n}"]`)?.text ?? '';
            const vatIdx = q<Adw.ComboRow>(row, 'adw-combo-row[data-f="vatRate"]')?.selected ?? 0;
            return {
                title: text('title'),
                description: text('description'),
                quantity: text('quantity'),
                unit: text('unit'),
                unitPrice: text('unitPrice'),
                vatRate: VAT_OPTIONS[vatIdx] ?? '19',
            };
        });
    }

    private updateTotals() {
        const box = this.dlg?.querySelector('[data-el="totals"]');
        if (!box) return;
        const t = computeFormTotals(this.readItems());
        box.innerHTML = `Netto ${eur(t.net)} · USt ${eur(t.vat)} · <strong>Brutto ${eur(t.gross)}</strong>`;
    }

    private async save() {
        if (!this.dlg) return;
        const text = (n: string) =>
            (this.dlg?.querySelector(`adw-entry-row[data-f="${n}"]`) as unknown as Adw.EntryRow | null)?.text ?? '';
        const customerIdx = q<Adw.ComboRow>(this.dlg, 'adw-combo-row[data-f="customer"]')?.selected ?? 0;
        const contactId = this.customers[customerIdx]?.id ?? '';
        const items = this.readItems();

        const problems = validateFormDraft({ contactId, issueDate: text('issueDate'), items });
        if (problems.length) {
            await alertDialog({
                heading: 'Bitte prüfen',
                body: problems.join('\n'),
                choices: [{ id: 'ok', label: 'OK', appearance: 'suggested' }],
            });
            return;
        }

        const issueDate = text('issueDate');
        const termDays = Number(text('termDays')) || 14;
        const prev = this.existing; // carry the fields the form does not expose (edit must not null them)
        const input: CreateInvoiceInput = {
            contactId,
            issueDate,
            dueDate: addDays(issueDate, termDays),
            currency: 'EUR',
            // The form has no IBAN/header/footer/terms/buyerReference fields; preserve the draft's
            // (esp. the §20-UStG footer set by the recurring path) instead of nulling them on edit.
            iban: prev?.iban ?? '', // empty → the self back-end resolves it from the entity config
            performanceStart: text('perfStart') || undefined,
            performanceEnd: text('perfEnd') || undefined,
            ...(prev?.header ? { header: prev.header } : {}),
            ...(prev?.footer ? { footer: prev.footer } : {}),
            ...(prev?.termsAndConditions ? { termsAndConditions: prev.termsAndConditions } : {}),
            ...(prev?.buyerReference ? { buyerReference: prev.buyerReference } : {}),
            items: items.map((it) => ({
                title: it.title,
                ...(it.description ? { description: it.description } : {}),
                quantity: it.quantity,
                ...(it.unit ? { unit: it.unit } : {}),
                unit_price: it.unitPrice,
                vat_rate: it.vatRate,
            })),
        };

        const save = this.dlg.querySelector('[data-el="save"]');
        save?.setAttribute('title', 'Speichere …');
        try {
            await api.saveInvoiceDraft(this.entity, input, this.editId ?? undefined);
            this.dlg.close();
            this.onSaved?.();
        } catch (err) {
            save?.setAttribute('title', 'Entwurf speichern');
            await alertDialog({
                heading: 'Speichern fehlgeschlagen',
                body: err instanceof Error ? err.message : String(err),
                choices: [{ id: 'ok', label: 'OK', appearance: 'suggested' }],
            });
        }
    }
}

customElements.define('bh-invoice-form', BhInvoiceForm);

declare global {
    interface HTMLElementTagNameMap {
        'bh-invoice-form': BhInvoiceForm;
    }
}
