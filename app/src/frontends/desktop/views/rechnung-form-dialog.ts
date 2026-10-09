/**
 * <BhRechnungFormDialog> — create / edit an outgoing DRAFT invoice (self back-end), the native
 * counterpart to the web <bh-invoice-form>. An Adw.Dialog with a customer picker, header dates and
 * a DYNAMIC list of Adw.ExpanderRow position rows (add/remove at runtime), plus a live
 * Netto/USt/Brutto row. Built programmatically (the item list is fully dynamic). Uses the shared
 * invoices/form.ts helpers so the preview matches what the back-end freezes.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import {
    type Contact,
    type CreateInvoiceInput,
    loadCustomers,
    type OutgoingInvoiceDetail,
} from '../../../core/presenters/rechnungen.ts';
import { saveOutgoingInvoiceDraft } from '../../../core/actions/outgoing-invoices.ts';
import { listProjects } from '../../../core/actions/projects.ts';
import { getRechnungProjekt, vorschlagProjekt } from '../../../core/actions/rechnung-projekt.ts';
import {
    buildProjectTimeDraft,
    listOpenTimeForInvoice,
    type TimeGrouping,
} from '../../../core/actions/time-invoice.ts';
import { formatDuration } from '../../../core/actions/time.ts';
import type { Project } from '../../../core/config/index.ts';
import type { AppEntity } from '../entities.ts';
import { contactDisplayName } from '@steuererklaerung/store';
import { computeFormTotals, emptyItem, type InvoiceItemDraft, validateFormDraft } from '../../../core/invoices/form.ts';
import { num2 } from '../../../core/lib/format.ts';
import { errorDialog } from './dialogs.ts';
import { showToast } from '../toast.ts';

const VAT_OPTIONS = ['19', '7', '0'];
const vatIndex = (rate: string): number => Math.max(0, VAT_OPTIONS.indexOf(rate));

/** The widgets backing one position row (kept in a parallel array to avoid stashing on the row). */
interface ItemWidgets {
    row: Adw.ExpanderRow;
    title: Adw.EntryRow;
    description: Adw.EntryRow;
    quantity: Adw.EntryRow;
    unit: Adw.EntryRow;
    unitPrice: Adw.EntryRow;
    vatRate: Adw.ComboRow;
}

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

export class BhRechnungFormDialog {
    private readonly dialog = new Adw.Dialog();
    private entity!: AppEntity;
    private customers: Contact[] = [];
    private editId: string | null = null;
    /** The invoice being edited — its non-form fields (header/footer/terms/iban/…) survive a save. */
    private existing: OutgoingInvoiceDetail | null = null;
    private onSaved: (() => void) | null = null;

    private customerRow!: Adw.ComboRow;
    private issueRow!: Adw.EntryRow;
    private termRow!: Adw.EntryRow;
    private perfStartRow!: Adw.EntryRow;
    private perfEndRow!: Adw.EntryRow;
    private itemsGroup!: Adw.PreferencesGroup;
    private totalsRow!: Adw.ActionRow;
    private saveButton!: Adw.ButtonRow;
    private readonly items: ItemWidgets[] = [];

    private projects: Project[] = [];
    private projectRow!: Adw.ComboRow;
    private projectTouched = false;
    private timeGroup!: Adw.PreferencesGroup;
    private timeRows: { entryId: string; row: Adw.ActionRow; check: Gtk.CheckButton }[] = [];
    private timeRateRow!: Adw.EntryRow;
    private timeVatRow!: Adw.ComboRow;
    private timeGroupingRow!: Adw.ComboRow;
    private timeInsertRow!: Adw.ButtonRow;
    private timeItems: ItemWidgets[] = [];
    /** Entries inserted as lines: reserved with the draft, billed only on finalize. */
    private timeEntryIds: string[] | undefined;

    constructor() {
        this.dialog.set_content_width(640);
        this.dialog.set_content_height(720);
    }

    open(parent: Gtk.Widget, entity: AppEntity, existing: OutgoingInvoiceDetail | null, onSaved: () => void): void {
        this.entity = entity;
        this.editId = existing?.id ?? null;
        this.existing = existing;
        this.onSaved = onSaved;
        this.customers = loadCustomers(entity.id);
        this.build(parent, existing);
    }

    private build(parent: Gtk.Widget, existing: OutgoingInvoiceDetail | null): void {
        const today = new Date().toISOString().slice(0, 10);
        const header = new Adw.HeaderBar();
        header.set_title_widget(
            new Adw.WindowTitle({ title: existing ? 'Rechnung bearbeiten' : 'Neue Rechnung', subtitle: '' }),
        );

        const page = new Adw.PreferencesPage();

        // Empfänger.
        const recipientGroup = new Adw.PreferencesGroup({ title: 'Empfänger' });
        const names = new Gtk.StringList();
        for (const c of this.customers) names.append(contactDisplayName(c));
        this.customerRow = new Adw.ComboRow({ title: 'Kunde', model: names });
        if (existing?.contactId) {
            const idx = this.customers.findIndex((c) => c.id === existing.contactId);
            if (idx >= 0) this.customerRow.set_selected(idx);
        }
        if (this.customers.length === 0)
            this.customerRow.set_subtitle('Kein Kunde vorhanden — lege zuerst einen unter Kontakte an.');
        recipientGroup.add(this.customerRow);
        page.add(recipientGroup);

        // Projekt + Zeiten übernehmen.
        this.projects = listProjects(this.entity.id);
        const projectGroup = new Adw.PreferencesGroup({ title: 'Projekt' });
        const projectNames = new Gtk.StringList();
        projectNames.append('Kein Projekt');
        for (const p of this.projects) projectNames.append(p.name);
        this.projectRow = new Adw.ComboRow({ title: 'Projekt', model: projectNames });
        const assigned = existing ? getRechnungProjekt(this.entity.id, existing.id) : null;
        const assignedIdx = this.projects.findIndex((p) => p.id === assigned);
        if (assignedIdx >= 0) this.projectRow.set_selected(assignedIdx + 1);
        else if (!existing) this.proposeProject();
        this.projectRow.connect('notify::selected', () => {
            this.projectTouched = true;
            this.refreshTimeGroup();
        });
        this.customerRow.connect('notify::selected', () => {
            if (!this.projectTouched && !existing) this.proposeProject();
        });
        projectGroup.add(this.projectRow);
        page.add(projectGroup);

        this.timeGroup = new Adw.PreferencesGroup({
            title: 'Zeiten übernehmen',
            description:
                'Offene Zeiten des Projekts werden Positionen. Abgerechnet gelten sie erst beim Festschreiben.',
        });
        page.add(this.timeGroup);

        // Eckdaten.
        const meta = new Adw.PreferencesGroup({ title: 'Eckdaten' });
        this.issueRow = new Adw.EntryRow({
            title: 'Ausstellungsdatum (JJJJ-MM-TT)',
            text: existing?.issueDate ?? today,
        });
        // On edit, derive the term from the existing dates so re-saving keeps the same due date.
        const termDays = daysBetween(existing?.issueDate ?? null, existing?.dueDate ?? null) ?? 14;
        this.termRow = new Adw.EntryRow({ title: 'Zahlungsziel (Tage)', text: String(termDays) });
        this.perfStartRow = new Adw.EntryRow({
            title: 'Leistung von (optional)',
            text: existing?.performanceStart ?? '',
        });
        this.perfEndRow = new Adw.EntryRow({ title: 'Leistung bis (optional)', text: existing?.performanceEnd ?? '' });
        for (const r of [this.issueRow, this.termRow, this.perfStartRow, this.perfEndRow]) meta.add(r);
        page.add(meta);

        // Positionen (dynamic).
        this.itemsGroup = new Adw.PreferencesGroup({ title: 'Positionen' });
        page.add(this.itemsGroup);

        const actionsGroup = new Adw.PreferencesGroup();
        this.totalsRow = new Adw.ActionRow({ title: 'Summe' });
        actionsGroup.add(this.totalsRow);
        const addRow = new Adw.ButtonRow({ title: '＋ Position hinzufügen' });
        addRow.connect('activated', () => this.addItemRow(emptyItem()));
        actionsGroup.add(addRow);
        this.saveButton = new Adw.ButtonRow({ title: 'Entwurf speichern' });
        this.saveButton.add_css_class('suggested-action');
        this.saveButton.connect('activated', () => void this.save());
        actionsGroup.add(this.saveButton);
        page.add(actionsGroup);

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(header);
        toolbar.set_content(page);
        this.dialog.set_child(toolbar);

        // Seed items.
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
        this.updateTotals();
        this.refreshTimeGroup();

        this.dialog.present(parent);
    }

    /** Append one position expander row and track its widgets. */
    private addItemRow(item: InvoiceItemDraft): void {
        const row = new Adw.ExpanderRow({ title: item.title || 'Neue Position', expanded: true });
        const w: ItemWidgets = {
            row,
            title: new Adw.EntryRow({ title: 'Bezeichnung', text: item.title }),
            description: new Adw.EntryRow({ title: 'Beschreibung (optional)', text: item.description ?? '' }),
            quantity: new Adw.EntryRow({ title: 'Menge', text: item.quantity }),
            unit: new Adw.EntryRow({ title: 'Einheit (optional)', text: item.unit ?? '' }),
            unitPrice: new Adw.EntryRow({ title: 'Einzelpreis netto (€)', text: item.unitPrice }),
            vatRate: new Adw.ComboRow({ title: 'USt-Satz', model: this.vatModel() }),
        };
        w.vatRate.set_selected(vatIndex(item.vatRate));
        const remove = new Adw.ButtonRow({ title: 'Position entfernen' });
        remove.add_css_class('destructive-action');
        for (const r of [w.title, w.description, w.quantity, w.unit, w.unitPrice, w.vatRate, remove]) row.add_row(r);

        remove.connect('activated', () => {
            const i = this.items.indexOf(w);
            if (i >= 0) this.items.splice(i, 1);
            this.itemsGroup.remove(row);
            this.updateTotals();
        });
        const recompute = () => {
            row.set_title(w.title.get_text()?.trim() || 'Neue Position');
            this.updateTotals();
        };
        for (const e of [w.title, w.quantity, w.unitPrice]) e.connect('changed', recompute);
        w.vatRate.connect('notify::selected', () => this.updateTotals());

        this.items.push(w);
        this.itemsGroup.add(row);
        this.updateTotals();
    }

    private selectedProject(): Project | null {
        return this.projects[this.projectRow.get_selected() - 1] ?? null;
    }

    /** Preselect the customer's only project — shown in the row for the person to confirm, never applied silently. */
    private proposeProject(): void {
        const contactId = this.customers[this.customerRow.get_selected()]?.id;
        const id = vorschlagProjekt(this.projects, contactId);
        const idx = this.projects.findIndex((p) => p.id === id);
        this.projectRow.set_selected(idx >= 0 ? idx + 1 : 0);
        this.projectRow.set_subtitle(
            idx >= 0 ? 'Vorschlag: das einzige Projekt dieses Kunden — bitte bestätigen.' : '',
        );
        this.projectTouched = false;
    }

    /** (Re)build the choice list of open entries for the chosen project. */
    private refreshTimeGroup(): void {
        if (!this.timeGroup) return;
        for (const r of this.timeRows) this.timeGroup.remove(r.row);
        this.timeRows = [];
        for (const w of [this.timeRateRow, this.timeVatRow, this.timeGroupingRow, this.timeInsertRow]) {
            if (w) this.timeGroup.remove(w);
        }
        const project = this.selectedProject();
        this.timeGroup.set_visible(!!project);
        if (!project) return;
        const open = listOpenTimeForInvoice(this.entity.id, { projectId: project.id }, this.editId ?? undefined);
        if (open.length === 0) {
            this.timeGroup.set_description('Dieses Projekt hat keine offenen Zeiten.');
            return;
        }
        for (const e of open) {
            const row = new Adw.ActionRow({
                title: e.description?.trim() || project.name,
                subtitle: `${e.startedAt.slice(0, 10)} · ${formatDuration(e.durationSeconds ?? 0)}`,
            });
            const check = new Gtk.CheckButton({ active: true, valign: Gtk.Align.CENTER });
            row.add_prefix(check);
            row.set_activatable_widget(check);
            this.timeGroup.add(row);
            this.timeRows.push({ entryId: e.id, row, check });
        }
        this.timeRateRow = new Adw.EntryRow({ title: 'Netto-Stundensatz (€)' });
        this.timeVatRow = new Adw.ComboRow({ title: 'USt-Satz der Zeiten', model: this.vatModel() });
        const grouping = new Gtk.StringList();
        grouping.append('Je Tätigkeit eine Position');
        grouping.append('Eine Position gesamt');
        this.timeGroupingRow = new Adw.ComboRow({ title: 'Gruppierung', model: grouping });
        this.timeInsertRow = new Adw.ButtonRow({ title: 'Zeiten als Positionen einfügen' });
        this.timeInsertRow.connect('activated', () => void this.insertTime(project));
        for (const w of [this.timeRateRow, this.timeVatRow, this.timeGroupingRow, this.timeInsertRow])
            this.timeGroup.add(w);
    }

    private async insertTime(project: Project): Promise<void> {
        try {
            const rate = Number((this.timeRateRow.get_text() ?? '').replace(',', '.'));
            const grouping: TimeGrouping = this.timeGroupingRow.get_selected() === 1 ? 'gesamt' : 'task';
            const chosen = this.timeRows.filter((r) => r.check.get_active()).map((r) => r.entryId);
            const built = buildProjectTimeDraft(this.entity.id, project, {
                grouping,
                hourlyRate: rate,
                vatRate: Number(VAT_OPTIONS[this.timeVatRow.get_selected()] ?? '19') / 100,
                entryIds: chosen,
                exceptInvoiceId: this.editId ?? undefined,
            });
            // Replace earlier time lines, so inserting twice never doubles the hours.
            for (const w of this.timeItems) {
                const i = this.items.indexOf(w);
                if (i >= 0) this.items.splice(i, 1);
                this.itemsGroup.remove(w.row);
            }
            this.timeItems = [];
            for (const line of built.lines) {
                const before = this.items.length;
                this.addItemRow({
                    title: line.title,
                    description: line.description,
                    quantity: String(line.quantity),
                    unit: line.unit,
                    unitPrice: String(line.unitPriceNet),
                    vatRate: String(Math.round(line.vatRate * 100)),
                });
                this.timeItems.push(...this.items.slice(before));
            }
            if (!this.perfStartRow.get_text()) this.perfStartRow.set_text(built.performanceStart);
            if (!this.perfEndRow.get_text()) this.perfEndRow.set_text(built.performanceEnd);
            this.timeEntryIds = built.entryIds;
            this.updateTotals();
            showToast(`${built.entryIds.length} Zeiten eingefügt — abgerechnet erst beim Festschreiben`);
        } catch (err) {
            await errorDialog(this.dialog, 'Zeiten übernehmen', err instanceof Error ? err.message : String(err));
        }
    }

    private vatModel(): Gtk.StringList {
        const list = new Gtk.StringList();
        for (const v of ['19 %', '7 %', '0 %']) list.append(v);
        return list;
    }

    private readItems(): InvoiceItemDraft[] {
        return this.items.map((w) => ({
            title: w.title.get_text() ?? '',
            description: w.description.get_text() ?? '',
            quantity: w.quantity.get_text() ?? '',
            unit: w.unit.get_text() ?? '',
            unitPrice: w.unitPrice.get_text() ?? '',
            vatRate: VAT_OPTIONS[w.vatRate.get_selected()] ?? '19',
        }));
    }

    private updateTotals(): void {
        const t = computeFormTotals(this.readItems());
        this.totalsRow.set_subtitle(`Netto ${num2(t.net)} € · USt ${num2(t.vat)} € · Brutto ${num2(t.gross)} €`);
    }

    private async save(): Promise<void> {
        const contactId = this.customers[this.customerRow.get_selected()]?.id ?? '';
        const issueDate = this.issueRow.get_text() ?? '';
        const items = this.readItems();
        const problems = validateFormDraft({ contactId, issueDate, items });
        if (problems.length) {
            await errorDialog(this.dialog, 'Bitte prüfen', problems.join('\n'));
            return;
        }
        const termDays = Number(this.termRow.get_text()) || 14;
        const prev = this.existing; // carry the fields the form does not expose (edit must not null them)
        const input: CreateInvoiceInput = {
            contactId,
            issueDate,
            dueDate: addDays(issueDate, termDays),
            currency: 'EUR',
            // No IBAN/header/footer/terms/buyerReference fields in the form — preserve the draft's
            // (esp. the §20-UStG footer from the recurring path) instead of nulling them on edit.
            iban: prev?.iban ?? '', // empty → the self back-end resolves it from the entity config
            performanceStart: this.perfStartRow.get_text() || undefined,
            performanceEnd: this.perfEndRow.get_text() || undefined,
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
        this.saveButton.set_sensitive(false);
        this.saveButton.set_title('Speichere …');
        try {
            await saveOutgoingInvoiceDraft(this.entity.id, input, this.editId ?? undefined, undefined, {
                projectId: this.selectedProject()?.id ?? null,
                ...(this.timeEntryIds ? { timeEntryIds: this.timeEntryIds } : {}),
            });
            this.dialog.close();
            showToast('Entwurf gespeichert');
            this.onSaved?.();
        } catch (err) {
            this.saveButton.set_sensitive(true);
            this.saveButton.set_title('Entwurf speichern');
            await errorDialog(
                this.dialog,
                'Speichern fehlgeschlagen',
                err instanceof Error ? err.message : String(err),
            );
        }
    }
}
