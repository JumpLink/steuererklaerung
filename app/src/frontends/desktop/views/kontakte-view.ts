/**
 * <BhKontakteView> — the Kontakte view (list + full CRUD).
 *
 * Mirrors the web "Kontakte" (bh-kontakte-view): a summary (gesamt · Kunden · Lieferanten) and one
 * row per contact (avatar + display name + kind/email/USt-IdNr/city, with Kunde/Lieferant and
 * external-link chips). The list-group header carries "＋ Kontakt hinzufügen" (opens the form) and
 * "Importieren" (pulls Qonto clients + Paperless correspondents and links them). Each row is
 * activatable → edit; a per-row "Löschen" confirms via Adw.AlertDialog. Store-only reads/writes
 * (see data/contacts.ts); entity-scoped, not year-scoped.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import Template from './kontakte-view.blp';
import {
    type Contact,
    type ImportContactsResult,
    importContacts,
    loadContacts,
    loadOpenReceivables,
    removeContact,
} from '../data/contacts.ts';
import { humanizeKey } from '../../../core/lib/qonto-categories.ts';
import { contactDisplayName } from '@steuererklaerung/store';
import { eur } from '../../../core/lib/format.ts';
import type { AppEntity } from '../entities.ts';
import { confirmDialog, errorDialog } from './dialogs.ts';
import { showToast } from '../toast.ts';
import { BhKontaktFormDialog } from './kontakt-form-dialog.ts';
import { GroupRows, LoadToken, emptyState, loadIntoStack, markup } from './util.ts';

const KIND_LABEL: Record<string, string> = {
    company: 'Firma',
    individual: 'Person',
    freelancer: 'Freiberuflich',
    organization: 'Organisation',
};

/** Human labels for the external back-ends a contact can be linked to (chip text). */
const SYSTEM_LABEL: Record<string, string> = { qonto: 'Qonto', paperless: 'Paperless' };

type ContactFilter = 'all' | 'customer' | 'supplier';
const FILTERS: { id: ContactFilter; label: string }[] = [
    { id: 'all', label: 'Alle' },
    { id: 'customer', label: 'Kunden' },
    { id: 'supplier', label: 'Lieferanten' },
];

export class BhKontakteView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _summary_group: Adw.PreferencesGroup;
    declare private _filter_box: Gtk.Box;
    declare private _list_group: Adw.PreferencesGroup;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhKontakteView',
                Template,
                InternalChildren: ['stack', 'error_page', 'summary_group', 'filter_box', 'list_group'],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    private readonly summary: GroupRows;
    private readonly list: GroupRows;
    private entity: AppEntity | null = null;
    /** Full loaded set (the list is re-rendered from this on a filter change). */
    private contacts: Contact[] = [];
    private filter: ContactFilter = 'all';
    /** contactId → Σ open receivables, filled in the background after the list renders. */
    private openByContact = new Map<string, number>();
    /** Guards a slow receivables fetch against an entity switch (mirrors LoadToken). */
    private receivablesToken = 0;

    constructor() {
        super();
        this.summary = new GroupRows(this._summary_group);
        this.list = new GroupRows(this._list_group);
        this.buildFilterChips();
    }

    reload(entity: AppEntity, _year: number): void {
        this.entity = entity;
        this.openByContact = new Map();
        this.load(entity);
    }

    /** The Alle · Kunden · Lieferanten linked toggle group (built once; state is per-instance). */
    private buildFilterChips(): void {
        let group: Gtk.ToggleButton | null = null;
        for (const f of FILTERS) {
            const btn = new Gtk.ToggleButton({ label: f.label, active: f.id === this.filter });
            if (group) btn.set_group(group);
            else group = btn;
            btn.connect('toggled', () => {
                if (!btn.get_active()) return; // only react to the newly-activated button
                this.filter = f.id;
                this.renderList();
            });
            this._filter_box.append(btn);
        }
    }

    /** (Re)load the contact list for `entity` into the stack. Shared by reload + post-write refresh. */
    private load(entity: AppEntity): void {
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: 'Kontakte konnten nicht geladen werden',
            load: () => loadContacts(entity.id),
            fill: (contacts) => this.fill(contacts),
        });
    }

    /** Re-read + re-render after a write (save/delete/import). No-op before the first load. */
    private refresh(): void {
        if (this.entity) this.load(this.entity);
    }

    private fill(contacts: Contact[]): void {
        this.contacts = [...contacts].sort((a, b) => contactDisplayName(a).localeCompare(contactDisplayName(b), 'de'));
        this.fillSummary(this.contacts);
        this.renderList();
        void this.fetchReceivables();
        if (process.env.STEUER_APP_DEBUG) console.error(`[app] Kontakte ok: ${contacts.length} gesamt`);
    }

    /** Apply the active filter chip and (re)render the visible rows from the loaded set. */
    private renderList(): void {
        const shown = this.contacts.filter((c) =>
            this.filter === 'customer' ? c.isCustomer : this.filter === 'supplier' ? c.isSupplier : true,
        );
        this.fillList(shown);
    }

    /**
     * Load the open-receivables totals in the background (outbound to the invoicing back-end) and,
     * once in, re-render so the matched rows grow a "N € offen" badge. Guarded against an entity
     * switch so a slow fetch can't decorate the wrong entity's list.
     */
    private async fetchReceivables(): Promise<void> {
        if (!this.entity) return;
        // Only worth the outbound fetch when there's a customer to owe us anything.
        if (!this.contacts.some((c) => c.isCustomer)) return;
        const entity = this.entity;
        const token = ++this.receivablesToken;
        const open = await loadOpenReceivables(entity, this.contacts);
        if (token !== this.receivablesToken || open.size === 0) return;
        this.openByContact = open;
        this.renderList();
    }

    private fillSummary(contacts: Contact[]): void {
        this.summary.clear();
        this._summary_group.set_title('Kontakte');
        this._summary_group.set_description(
            'Der gemeinsame Stamm für Kunden (Rechnungen → Qonto) und Lieferanten/Korrespondenten ' +
                '(Belege → Paperless). „Importieren" holt vorhandene Datensätze aus den verbundenen Diensten ' +
                'und verknüpft sie.',
        );
        const kunden = contacts.filter((c) => c.isCustomer).length;
        const lieferanten = contacts.filter((c) => c.isSupplier).length;
        this.summary.add(
            new Adw.ActionRow({
                title: `${contacts.length} gesamt`,
                subtitle: `${kunden} Kunden · ${lieferanten} Lieferanten`,
            }),
        );
    }

    private fillList(contacts: Contact[]): void {
        this.list.clear();
        this._list_group.set_header_suffix(this.buildListActions());
        if (contacts.length === 0) {
            // Distinguish a truly empty master from a filter that hides everything.
            this.list.add(
                this.contacts.length === 0
                    ? emptyState({
                          icon: 'system-users-symbolic',
                          title: 'Noch keine Kontakte',
                          description:
                              'Kunden und Lieferanten stehen hier — sie füllen Rechnungen aus und ordnen Belege zu.',
                          action: { label: 'Kontakt anlegen', run: () => this.openForm(null) },
                      })
                    : emptyState({
                          icon: 'edit-find-symbolic',
                          title: 'Nichts gefunden',
                          description: 'Kein Kontakt passt auf Suche und Filter.',
                      }),
            );
            return;
        }
        for (const c of contacts) this.list.add(this.buildRow(c));
    }

    /** The list-group header actions: add a contact (suggested) + import from the connected services. */
    private buildListActions(): Gtk.Box {
        const box = new Gtk.Box({ spacing: 8, valign: Gtk.Align.CENTER });
        const add = new Gtk.Button({
            label: '＋ Kontakt hinzufügen',
            cssClasses: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        add.connect('clicked', () => this.openForm(null));
        const importBtn = new Gtk.Button({ label: 'Importieren', valign: Gtk.Align.CENTER });
        importBtn.set_tooltip_text('Kunden aus Qonto und Korrespondenten aus Paperless importieren und verknüpfen');
        importBtn.connect('clicked', () => void this.runImport(importBtn));
        box.append(add);
        box.append(importBtn);
        return box;
    }

    private buildRow(c: Contact): Adw.ActionRow {
        const name = contactDisplayName(c);
        const sub = [
            KIND_LABEL[c.kind] ?? humanizeKey(c.kind),
            c.email,
            c.vatNumber ? `USt-IdNr. ${c.vatNumber}` : null,
            [c.zip, c.city].filter(Boolean).join(' ') || null,
        ].filter(Boolean);
        const row = new Adw.ActionRow({
            title: markup(name),
            subtitle: markup(sub.join(' · ')),
            activatable: true,
        });
        // Adw.Avatar self-derives initials + a stable colour from the name (the native equivalent of
        // the web's initials()/avatarColor(); GTK has no inline seed-colour mechanism).
        row.add_prefix(new Adw.Avatar({ size: 32, text: name, showInitials: true, valign: Gtk.Align.CENTER }));

        // Open receivables (filled in the background) — the amber "N € offen" pill from the design.
        const open = this.openByContact.get(c.id);
        if (open && open > 0.005) {
            row.add_suffix(
                new Gtk.Label({
                    label: `${eur(open)} offen`,
                    cssClasses: ['caption', 'warning'],
                    valign: Gtk.Align.CENTER,
                }),
            );
        }
        if (c.isCustomer) row.add_suffix(this.badge('Kunde', 'accent'));
        if (c.isSupplier) row.add_suffix(this.badge('Lieferant', 'accent'));
        for (const l of c.links) row.add_suffix(this.badge(SYSTEM_LABEL[l.system] ?? l.system, 'dim-label'));

        const del = new Gtk.Button({ label: 'Löschen', cssClasses: ['flat'], valign: Gtk.Align.CENTER });
        del.connect('clicked', () => void this.askDelete(c)); // the button consumes the click → no row activation
        row.add_suffix(del);

        row.connect('activated', () => this.openForm(c));
        return row;
    }

    private badge(label: string, css: string): Gtk.Label {
        return new Gtk.Label({ label, cssClasses: ['caption', css], valign: Gtk.Align.CENTER });
    }

    /** Open the create/edit form; refresh the list on save. */
    private openForm(c: Contact | null): void {
        if (!this.entity) return;
        const dialog = new BhKontaktFormDialog();
        dialog.open(this, this.entity, c, () => this.refresh());
    }

    /** Confirm + delete one contact (its Qonto/Paperless links go only locally). */
    private async askDelete(c: Contact): Promise<void> {
        if (!this.entity) return;
        const ok = await confirmDialog(this, {
            heading: 'Kontakt löschen',
            body: `„${contactDisplayName(c)}" wirklich löschen? Verknüpfungen zu Qonto/Paperless gehen dabei nur lokal verloren.`,
            confirmLabel: 'Löschen',
            destructive: true,
        });
        if (!ok) return;
        try {
            removeContact(this.entity.id, c.id);
            showToast('Kontakt gelöscht');
            this.refresh();
        } catch (err) {
            await errorDialog(this, 'Löschen fehlgeschlagen', err instanceof Error ? err.message : String(err));
        }
    }

    /** Pull + link contacts from the connected back-ends; toast the per-source result, then reload. */
    private async runImport(btn: Gtk.Button): Promise<void> {
        if (!this.entity) return;
        btn.set_sensitive(false);
        btn.set_label('Importiere …');
        try {
            const res = await importContacts(this.entity.id);
            showToast(this.importSummary(res), 5);
            // refresh() rebuilds the header (fresh, enabled Importieren button), so no manual restore.
            this.refresh();
        } catch (err) {
            btn.set_sensitive(true);
            btn.set_label('Importieren');
            showToast(`Import fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`, 5);
        }
    }

    private importSummary(res: ImportContactsResult): string {
        if (!res.sources.length) return 'Keine verbundenen Dienste — nichts zu importieren.';
        return res.sources
            .map((s) => {
                const label = SYSTEM_LABEL[s.source] ?? s.source;
                if (s.error) return `${label}: Fehler`;
                return `${label}: ${s.imported} neu · ${s.linked} verknüpft · ${s.matched} bekannt`;
            })
            .join('  ·  ');
    }
}
