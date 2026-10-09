// <bh-kontakte-view> — "Kontakte": the unified party master for the active entity. Customers (we
// invoice → Qonto) and suppliers/correspondents (we receive from → Paperless) live in one list;
// our store is the system of record. "Importieren" pulls Qonto clients + Paperless correspondents
// and links them. Add/edit runs in an adw-preferences-dialog (entry/combo/switch rows); delete
// confirms via adw-alert-dialog. Entity-scoped (not year-scoped); reads/writes /api/contacts.

import type { Adw } from '@gjsify/adwaita-web';
import { api, type Contact, type ImportContactsResult } from '../lib/api.ts';
import { alertDialog, confirmDialog } from '../lib/dialogs.ts';
import { esc, eur, initials, avatarColor } from '../lib/format.ts';
import { openReceivablesByContact } from '../../../../core/invoices/open-receivables.ts';
import { q, qc } from '../lib/dom.ts';

type ContactFilter = 'all' | 'customer' | 'supplier';
const FILTERS: { id: ContactFilter; label: string }[] = [
    { id: 'all', label: 'Alle' },
    { id: 'customer', label: 'Kunden' },
    { id: 'supplier', label: 'Lieferanten' },
];

/** Contact kinds in combo-row order; the combo's selected index maps back to these. */
const KINDS: Contact['kind'][] = ['company', 'individual', 'freelancer', 'organization'];

const KIND_LABELS: Record<string, string> = {
    company: 'Firma',
    individual: 'Person',
    freelancer: 'Freiberuflich',
    organization: 'Organisation',
};

const SYSTEM_LABELS: Record<string, string> = { qonto: 'Qonto', paperless: 'Paperless' };

/** Display name regardless of kind (mirrors store contactDisplayName for the client). */
function displayName(c: Contact): string {
    if (c.name?.trim()) return c.name.trim();
    const full = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
    return full || c.id;
}

export class BhKontakteView extends HTMLElement {
    private entity = '';
    private contacts: Contact[] = [];
    private filter: ContactFilter = 'all';
    /** contactId → Σ open receivables, filled in the background after the list renders. */
    private openByContact = new Map<string, number>();
    /** Guards a slow receivables fetch against an entity switch. */
    private receivablesToken = 0;

    async connectedCallback() {
        this.entity = this.getAttribute('entity') ?? '';
        this.innerHTML = `<div class="bh-loading"><adw-spinner></adw-spinner>Lade Kontakte …</div>`;
        await this.reload();
    }

    private async reload() {
        try {
            this.openByContact = new Map();
            this.contacts = this.entity ? await api.contacts(this.entity) : [];
            this.render();
            void this.fetchReceivables();
        } catch (err) {
            this.innerHTML = `<adw-card class="bh-error">Fehler: ${esc(err instanceof Error ? err.message : err)}</adw-card>`;
        }
    }

    /**
     * Load the open-receivables totals in the background (outbound to the invoicing back-end) and,
     * once in, re-render so matched rows grow a "N € offen" badge. Guarded against an entity switch.
     */
    private async fetchReceivables() {
        if (!this.entity || !this.contacts.some((c) => c.isCustomer)) return;
        const token = ++this.receivablesToken;
        try {
            const invoices = await api.invoices(this.entity);
            if (token !== this.receivablesToken) return;
            const refs = this.contacts.map((c) => ({
                id: c.id,
                displayName: displayName(c),
                qontoClientId: c.links?.find((l) => l.system === 'qonto')?.externalId ?? null,
            }));
            const open = openReceivablesByContact(refs, invoices);
            if (open.size === 0) return;
            this.openByContact = open;
            this.render();
        } catch {
            /* no invoicing back-end / fetch failed → simply no badges */
        }
    }

    /** Role + external-link chips for one contact. */
    private chips(c: Contact): string {
        const chips: string[] = [];
        if (c.isCustomer) chips.push(`<span class="bh-due-badge upcoming">Kunde</span>`);
        if (c.isSupplier) chips.push(`<span class="bh-due-badge soon">Lieferant</span>`);
        for (const l of c.links)
            chips.push(`<span class="bh-due-badge muted">${esc(SYSTEM_LABELS[l.system] ?? l.system)}</span>`);
        return chips.join('');
    }

    private row(c: Contact): string {
        const sub = [
            esc(KIND_LABELS[c.kind] ?? c.kind),
            c.email ? esc(c.email) : '',
            c.vatNumber ? `USt-IdNr. ${esc(c.vatNumber)}` : '',
            esc([c.zip, c.city].filter(Boolean).join(' ')),
        ]
            .filter(Boolean)
            .join(' · ');
        const name = displayName(c);
        const color = avatarColor(c.id || name);
        const open = this.openByContact.get(c.id);
        const openBadge = open && open > 0.005 ? `<span class="bh-due-badge soon">${eur(open)} offen</span>` : '';
        return `<div class="bh-setrow">
        <span class="bh-avatar" style="--bh-av:${color}">${esc(initials(name))}</span>
        <div class="bh-setrow-text">
          <strong>${this.chips(c)} ${esc(name)}</strong>
          <small>${sub}</small>
        </div>
        ${openBadge}
        <button class="adw-button flat" data-edit="${esc(c.id)}">Bearbeiten</button>
        <button class="adw-button flat" data-del="${esc(c.id)}">Löschen</button>
      </div>`;
    }

    private render() {
        const customers = this.contacts.filter((c) => c.isCustomer).length;
        const suppliers = this.contacts.filter((c) => c.isSupplier).length;
        const summary = this.contacts.length
            ? `${this.contacts.length} gesamt · ${customers} Kunden · ${suppliers} Lieferanten`
            : 'noch keine Kontakte';
        const shown = this.contacts.filter((c) =>
            this.filter === 'customer' ? c.isCustomer : this.filter === 'supplier' ? c.isSupplier : true,
        );
        const list = shown.length
            ? shown.map((c) => this.row(c)).join('')
            : this.contacts.length
              ? `<p class="bh-muted bh-set-note">Keine Kontakte in dieser Ansicht.</p>`
              : `<p class="bh-muted bh-set-note">Noch keine Kontakte. Lege einen an oder importiere aus Qonto/Paperless.</p>`;
        const chips = FILTERS.map(
            (f) =>
                `<button class="bh-chip${f.id === this.filter ? ' selected' : ''}" data-filter="${f.id}">${esc(f.label)}</button>`,
        ).join('');

        this.innerHTML = `
      <div class="bh-set-actions">
        <button class="adw-button suggested-action" data-act="add">＋ Kontakt hinzufügen</button>
        <button class="adw-button suggested-action" data-act="import">Aus Qonto/Paperless importieren</button>
        <span class="bh-set-status bh-muted" data-el="import-status"></span>
      </div>

      <div class="bh-filters" role="tablist">${chips}</div>
      <div class="bh-subhead">Alle Kontakte <span class="bh-muted">· ${esc(summary)}</span></div>
      <div class="bh-setlist">${list}</div>`;

        this.bind();
    }

    private bind() {
        this.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((b) =>
            b.addEventListener('click', () => {
                this.filter = (b.dataset.filter as ContactFilter) ?? 'all';
                this.render();
            }),
        );
        this.querySelector('[data-act="add"]')?.addEventListener('click', () => this.openForm(null));
        this.querySelector('[data-act="import"]')?.addEventListener('click', () => void this.runImport());
        this.querySelectorAll('[data-edit]').forEach((b) =>
            b.addEventListener('click', () => {
                const c = this.contacts.find((x) => x.id === (b as HTMLElement).dataset.edit);
                if (c) this.openForm(c);
            }),
        );
        this.querySelectorAll('[data-del]').forEach((b) =>
            b.addEventListener('click', () => {
                const c = this.contacts.find((x) => x.id === (b as HTMLElement).dataset.del);
                if (c) void this.askDelete(c);
            }),
        );
    }

    // ── Add / edit form (adw-preferences-dialog with entry/combo/switch rows) ─────────────
    private openForm(c: Contact | null) {
        const v = (s: string | null | undefined) => esc(s ?? '');
        const kindIdx = Math.max(0, KINDS.indexOf(c?.kind ?? 'company'));
        const dlg = qc<Adw.PreferencesDialog>('adw-preferences-dialog');
        dlg.setAttribute('title', c ? 'Kontakt bearbeiten' : 'Neuer Kontakt');
        dlg.setAttribute('content-width', '520');
        dlg.innerHTML = `
      <adw-preferences-page>
        <adw-preferences-group title="Stammdaten">
          <adw-entry-row data-f="name" title="Anzeigename / Firma" text="${v(c?.name)}"></adw-entry-row>
          <adw-entry-row data-f="firstName" title="Vorname" text="${v(c?.firstName)}"></adw-entry-row>
          <adw-entry-row data-f="lastName" title="Nachname" text="${v(c?.lastName)}"></adw-entry-row>
          <adw-entry-row data-f="email" title="E-Mail" text="${v(c?.email)}"></adw-entry-row>
          <adw-entry-row data-f="vatNumber" title="USt-IdNr." text="${v(c?.vatNumber)}"></adw-entry-row>
          <adw-combo-row data-f="kind" title="Art" model='["Firma","Person","Freiberuflich","Organisation"]' selected="${kindIdx}"></adw-combo-row>
        </adw-preferences-group>
        <adw-preferences-group title="Rollen">
          <adw-switch-row data-f="isCustomer" title="Kunde" subtitle="Rechnungen → Qonto"${c?.isCustomer ? ' active' : ''}></adw-switch-row>
          <adw-switch-row data-f="isSupplier" title="Lieferant" subtitle="Belege → Paperless"${c?.isSupplier ? ' active' : ''}></adw-switch-row>
        </adw-preferences-group>
        <adw-preferences-group>
          <adw-button-row data-el="save" class="suggested-action" title="Speichern"></adw-button-row>
        </adw-preferences-group>
      </adw-preferences-page>`;
        document.body.appendChild(dlg);
        dlg.addEventListener('closed', () => dlg.remove()); // drop from the DOM on any dismissal
        dlg.querySelector('[data-el="save"]')?.addEventListener('activated', () => void this.save(c, dlg));
        dlg.present();
    }

    private async save(c: Contact | null, dlg: Adw.PreferencesDialog) {
        const text = (n: string) => q<Adw.EntryRow>(dlg, `adw-entry-row[data-f="${n}"]`)?.text ?? '';
        const active = (n: string) => q<Adw.SwitchRow>(dlg, `adw-switch-row[data-f="${n}"]`)?.active ?? false;
        const kindIdx = q<Adw.ComboRow>(dlg, 'adw-combo-row[data-f="kind"]')?.selected ?? 0;
        try {
            await api.saveContact(this.entity, {
                ...(c ? { id: c.id } : {}),
                kind: KINDS[kindIdx] ?? 'company',
                name: text('name'),
                firstName: text('firstName'),
                lastName: text('lastName'),
                email: text('email'),
                vatNumber: text('vatNumber'),
                isCustomer: active('isCustomer'),
                isSupplier: active('isSupplier'),
            });
            dlg.close();
            await this.reload();
        } catch (err) {
            await alertDialog({
                heading: 'Speichern fehlgeschlagen',
                body: err instanceof Error ? err.message : String(err),
                choices: [{ id: 'ok', label: 'OK', appearance: 'suggested' }],
            });
        }
    }

    // ── Delete confirm (adw-alert-dialog) ───────────────────────────────────────────────
    private async askDelete(c: Contact) {
        const ok = await confirmDialog({
            heading: 'Kontakt löschen',
            body: `„${displayName(c)}" wirklich löschen? Verknüpfungen zu Qonto/Paperless gehen dabei nur lokal verloren.`,
            confirmLabel: 'Löschen',
            destructive: true,
        });
        if (!ok) return;
        try {
            await api.deleteContact(this.entity, c.id);
            await this.reload();
        } catch (err) {
            await alertDialog({
                heading: 'Löschen fehlgeschlagen',
                body: err instanceof Error ? err.message : String(err),
                choices: [{ id: 'ok', label: 'OK', appearance: 'suggested' }],
            });
        }
    }

    // ── Import from Qonto/Paperless ─────────────────────────────────────────────────────
    private async runImport() {
        const status = this.querySelector('[data-el="import-status"]') as HTMLElement | null;
        const btn = this.querySelector('[data-act="import"]') as HTMLButtonElement | null;
        if (btn) btn.disabled = true;
        if (status) status.textContent = 'Importiere aus den verbundenen Diensten … (kann ~1 Min dauern)';
        try {
            const res = await api.importContacts(this.entity);
            if (status) status.textContent = this.importSummary(res);
            await this.reload();
        } catch (err) {
            if (status) status.textContent = `Fehler: ${err instanceof Error ? err.message : err}`;
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    private importSummary(res: ImportContactsResult): string {
        if (!res.sources.length) return 'Keine verbundenen Dienste — nichts zu importieren.';
        return res.sources
            .map((s) => {
                const label = SYSTEM_LABELS[s.source] ?? s.source;
                if (s.error) return `${label}: Fehler (${s.error})`;
                return `${label}: ${s.imported} neu · ${s.linked} verknüpft · ${s.matched} bekannt`;
            })
            .join('  ·  ');
    }
}

customElements.define('bh-kontakte-view', BhKontakteView);

declare global {
    interface HTMLElementTagNameMap {
        'bh-kontakte-view': BhKontakteView;
    }
}
