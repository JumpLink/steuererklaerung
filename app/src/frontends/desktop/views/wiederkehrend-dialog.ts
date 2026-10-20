/**
 * Creating and editing a recurring-invoice schedule.
 *
 * The dashboard reminds when one comes due and the button beside it issues the invoice, but the
 * SCHEDULE itself could only be written by editing the manifest by hand. The one recurring revenue
 * an app like this exists to not forget was configurable in a text editor and nowhere else.
 *
 * The line items are the reason this is a dialog and not a settings row: a schedule has one or more
 * of them, each with title, quantity, unit price and VAT — a repeating sub-form no list row can
 * hold. The rest (customer, interval, period) is a handful of fields around it.
 */

import Adw from '@girs/adw-1';
import GObject from '@girs/gobject-2.0';
import Gtk from '@girs/gtk-4.0';

import {
    listSchedules,
    nextPeriod,
    saveSchedule,
    slugForSchedule,
    uniqueScheduleId,
} from '../../../core/actions/recurring-schedules.ts';
import { issuerNameFor } from '../../../core/actions/recurring-invoices.ts';
import type { MailTemplate } from '../../../core/config/index.ts';
import type { Project } from '../../../core/config/schema/project.ts';
import type { RecurringInvoice, RecurringItem } from '../../../core/config/schema/recurring.ts';
import {
    GREETING_MISSING,
    HEADER_PLACEHOLDERS,
    buildHeader,
    buildHeaderWithWarnings,
    resolveAddressing,
} from '../../../core/invoices/header-template.ts';
import { contactDisplayName } from '@steuererklaerung/store';
import { loadCustomerContacts } from '../data/contacts.ts';
import { loadEntityProjects } from '../data/projects.ts';
import { loadInvoicing } from '../data/settings.ts';
import { parseGermanInput } from '../../../core/lib/parsing.ts';
import type { AppEntity } from '../entities.ts';
import { markup } from './util.ts';
import { _, _p, fmt } from '../i18n.ts';
import { errorText } from '../error-text.ts';

/** Intervals a person actually bills in, in months. */
const INTERVALS: Array<{ label: string; months: number }> = [
    { label: _('monthly'), months: 1 },
    { label: _('quarterly'), months: 3 },
    { label: _('half-yearly'), months: 6 },
    { label: _('yearly'), months: 12 },
];

export type ScheduleResult = (message: string, changed: boolean) => void;

export class BhWiederkehrendDialog extends Adw.Dialog {
    static {
        GObject.registerClass({ GTypeName: 'BhWiederkehrendDialog' }, this);
    }

    private readonly entity: AppEntity;
    private readonly existing: RecurringInvoice | null;
    private readonly done: ScheduleResult;

    private readonly customer = new Adw.EntryRow({ title: _('Customer') });
    private readonly contact = new Adw.ComboRow({ title: _('Customer contact') });
    private readonly project = new Adw.ComboRow({ title: _('Project') });
    private readonly mailTemplate = new Adw.ComboRow({ title: _('Mail template') });
    private mailTemplates: MailTemplate[] = [];
    private readonly email = new Adw.EntryRow({ title: _('Email (for the reminder)') });
    private readonly description = new Adw.EntryRow({ title: _('Designation') });
    private readonly notes = new Adw.EntryRow({ title: _('Note (internal only)') });
    private readonly interval = new Adw.ComboRow({ title: _('Rhythm') });
    private readonly start = new Adw.EntryRow({ title: _('Next period from (YYYY-MM-DD)') });
    private readonly end = new Adw.EntryRow({ title: _('until (YYYY-MM-DD)') });
    private readonly formality = new Adw.ComboRow({
        title: _('Form of address'),
        model: Gtk.StringList.new(['Du', 'Sie']),
    });
    private readonly greeting = new Adw.EntryRow({
        title: _('Salutation in the contract (e.g. “Silke”; the project takes precedence)'),
    });
    private readonly closing = new Adw.EntryRow({ title: _('Sign-off (empty = the entity’s default)') });
    private readonly headerView = new Gtk.TextView({
        wrapMode: Gtk.WrapMode.WORD_CHAR,
        topMargin: 8,
        bottomMargin: 8,
        leftMargin: 8,
        rightMargin: 8,
    });
    private readonly preview = new Gtk.Label({
        wrap: true,
        selectable: true,
        xalign: 0,
        yalign: 0,
    });
    private readonly addressed = new Gtk.Label({ wrap: true, xalign: 0 });
    /** Selectable customers, in combo order after the leading "keiner" entry. */
    private readonly contactChoices: Array<{ id: string; label: string }> = [];
    private readonly allProjects: Project[];
    /** Projects of the selected contact, in combo order after the leading "keins" entry. */
    private projectChoices: Project[] = [];
    private readonly banner = new Adw.Banner({ revealed: false });
    private readonly itemsGroup = new Adw.PreferencesGroup({
        title: _('Line items'),
        description: _('Net per unit; VAT is added when the invoice is issued.'),
    });
    private readonly itemRows: Array<{
        title: Adw.EntryRow;
        quantity: Adw.EntryRow;
        price: Adw.EntryRow;
        vat: Adw.EntryRow;
    }> = [];

    constructor(entity: AppEntity, existing: RecurringInvoice | null, done: ScheduleResult) {
        super();
        this.entity = entity;
        this.existing = existing;
        this.done = done;
        this.allProjects = loadEntityProjects(entity.id);
        this.loadContactChoices();

        this.set_title(existing ? _('Edit recurring schedule') : _('New recurring schedule'));
        this.set_content_width(640);
        this.set_content_height(720);
        this.set_child(this.build());
        this.fill();
    }

    private build(): Gtk.Widget {
        const page = new Adw.PreferencesPage();

        const bannerGroup = new Adw.PreferencesGroup();
        bannerGroup.add(this.banner);
        page.add(bannerGroup);

        const who = new Adw.PreferencesGroup({ title: _('Customer') });
        who.add(this.customer);
        who.add(this.contact);
        who.add(this.project);
        this.mailTemplates = loadInvoicing(this.entity).mailTemplates;
        this.mailTemplate.set_subtitle(
            _('Picks the text used when the invoice is mailed; empty = the project’s or the entity’s default'),
        );
        this.mailTemplate.set_model(
            Gtk.StringList.new([_('as project/default'), ...this.mailTemplates.map((t) => t.name)]),
        );
        this.mailTemplate.set_selected(
            Math.max(0, this.mailTemplates.findIndex((t) => t.id === this.existing?.mailTemplateId) + 1),
        );
        this.mailTemplate.set_sensitive(this.mailTemplates.length > 0);
        who.add(this.mailTemplate);
        who.add(this.email);
        who.add(this.description);
        who.add(this.notes);
        page.add(who);

        const when = new Adw.PreferencesGroup({
            title: _('Period'),
            description: _('The period the NEXT invoice covers. After that it moves on automatically.'),
        });
        this.interval.set_model(Gtk.StringList.new(INTERVALS.map((i) => i.label)));
        when.add(this.interval);
        when.add(this.start);
        when.add(this.end);
        // Changing the rhythm or the start recomputes the end — the two belong together, and a
        // yearly schedule whose period is three months long bills a quarter of what it should.
        this.interval.connect('notify::selected', () => this.syncEnd());
        this.start.connect('apply', () => this.syncEnd());
        page.add(when);

        page.add(this.itemsGroup);
        page.add(this.buildLetterGroup());

        const scroller = new Gtk.ScrolledWindow({ hexpand: true, vexpand: true });
        scroller.set_child(page);

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        toolbar.set_content(scroller);

        const bottom = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.END,
            marginTop: 10,
            marginBottom: 12,
            marginStart: 12,
            marginEnd: 12,
        });
        const add = new Gtk.Button({ label: _('Add line item') });
        add.add_css_class('pill');
        add.connect('clicked', () => this.addItemRow(null).title.grab_focus());
        bottom.append(add);
        const save = new Gtk.Button({ label: _('Save') });
        save.add_css_class('suggested-action');
        save.add_css_class('pill');
        save.connect('clicked', () => this.onSave());
        bottom.append(save);
        toolbar.add_bottom_bar(bottom);
        return toolbar;
    }

    /** Cover letter: salutation, sign-off, the template and a live preview of what the customer will read. */
    private buildLetterGroup(): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({
            title: _('Cover letter'),
            description: fmt(
                _(
                    'Text above the line items. Placeholders: {list}. Empty = the entity’s default text (Settings → Invoicing).',
                ),
                {
                    list: Object.keys(HEADER_PLACEHOLDERS)
                        .map((k) => `{${k}}`)
                        .join(' '),
                },
            ),
        });
        group.add(this.formality);
        group.add(this.greeting);
        group.add(this.closing);

        const scroller = new Gtk.ScrolledWindow({ minContentHeight: 140, hasFrame: true });
        scroller.set_child(this.headerView);
        group.add(scroller);

        this.preview.add_css_class('dim-label');
        const previewBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, marginTop: 12 });
        const caption = new Gtk.Label({ label: _('Preview'), xalign: 0 });
        caption.add_css_class('heading');
        previewBox.append(caption);
        this.addressed.add_css_class('caption');
        previewBox.append(this.addressed);
        previewBox.append(this.preview);
        group.add(previewBox);

        this.headerView.get_buffer().connect('changed', () => this.updatePreview());
        this.formality.connect('notify::selected', () => this.updatePreview());
        this.greeting.connect('changed', () => this.updatePreview());
        this.closing.connect('changed', () => this.updatePreview());
        return group;
    }

    /** The entity's customers (plus the schedule's current contact, even if it is not one any more). */
    private loadContactChoices(): void {
        const current = this.existing?.customer.contactId;
        const contacts = loadCustomerContacts(this.entity.id, current);
        for (const c of contacts) this.contactChoices.push({ id: c.id, label: contactDisplayName(c) });
        // A contact that no longer exists stays selectable, so saving does not drop the link unasked.
        if (current && !this.contactChoices.some((c) => c.id === current)) {
            this.contactChoices.push({ id: current, label: fmt(_('Unknown contact ({id})'), { id: current }) });
        }
        this.contact.set_model(
            Gtk.StringList.new([_p('contact', '— none —'), ...this.contactChoices.map((c) => c.label)]),
        );
        this.contact.set_selected(Math.max(0, this.contactChoices.findIndex((c) => c.id === current) + 1));
        this.contact.connect('notify::selected', () => {
            const picked = this.selectedContactId();
            if (picked && !(this.customer.get_text() ?? '').trim()) {
                this.customer.set_text(this.contactChoices.find((c) => c.id === picked)?.label ?? '');
            }
            this.refreshProjects(null);
            this.updatePreview();
        });
        this.refreshProjects(this.existing?.projectId ?? null);
        this.project.connect('notify::selected', () => this.updatePreview());
    }

    private selectedContactId(): string | undefined {
        return this.contactChoices[this.contact.get_selected() - 1]?.id;
    }

    private selectedProject(): Project | undefined {
        return this.projectChoices[this.project.get_selected() - 1];
    }

    /** Offer only the projects of the chosen customer; keep `keep` selected when it is among them. */
    private refreshProjects(keep: string | null): void {
        const contactId = this.selectedContactId();
        this.projectChoices = contactId ? this.allProjects.filter((p) => p.contactId === contactId) : [];
        this.project.set_model(
            Gtk.StringList.new([_p('project', '— none —'), ...this.projectChoices.map((p) => p.name)]),
        );
        this.project.set_selected(Math.max(0, this.projectChoices.findIndex((p) => p.id === keep) + 1));
        this.project.set_sensitive(this.projectChoices.length > 0);
        this.project.set_subtitle(
            !contactId
                ? _('Pick a customer contact first')
                : this.projectChoices.length === 0
                  ? _('This customer has no project yet (Projects view)')
                  : '',
        );
    }

    private selectedFormality(): 'du' | 'sie' {
        return this.formality.get_selected() === 1 ? 'sie' : 'du';
    }

    private headerText(): string {
        const buffer = this.headerView.get_buffer();
        return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
    }

    /** Render the template against the form as it stands; a bad placeholder shows its error instead. */
    private updatePreview(): void {
        const customer = (this.customer.get_text() ?? '').trim() || _('Customer');
        const project = this.selectedProject();
        const draft = {
            ...this.existing,
            projectId: project?.id,
            customer: {
                ...this.existing?.customer,
                name: customer,
                greeting: (this.greeting.get_text() ?? '').trim() || undefined,
                formality: this.selectedFormality(),
                closing: (this.closing.get_text() ?? '').trim() || undefined,
            },
            description: (this.description.get_text() ?? '').trim() || undefined,
            domains: this.existing?.domains ?? [],
            nextPeriod: { start: (this.start.get_text() ?? '').trim(), end: (this.end.get_text() ?? '').trim() },
            items: this.itemRows.map((r) => ({ title: (r.title.get_text() ?? '').trim() })).filter((i) => i.title),
            header: this.headerText(),
        } as RecurringInvoice;
        try {
            const inv = loadInvoicing(this.entity);
            const rendered = buildHeaderWithWarnings(
                draft,
                {
                    defaultHeader: inv.defaultHeader,
                    defaultClosing: inv.defaultClosing,
                    defaultHeaderSie: inv.defaultHeaderSie,
                    defaultClosingSie: inv.defaultClosingSie,
                    issuerName: issuerNameFor(this.entity.id),
                },
                project,
            );
            const { greeting, formality, greetingFrom } = resolveAddressing(draft, project);
            const from = {
                project: _('from the project'),
                contract: _('from the contract'),
                none: _('not set'),
            }[greetingFrom];
            this.addressed.set_label(
                fmt(_('Addressed: {name} ({source}), {formality}'), {
                    name: greeting || '—',
                    source: from,
                    formality: formality === 'sie' ? 'Sie' : 'du',
                }),
            );
            const missing = rendered?.warnings.includes(GREETING_MISSING)
                ? `\n\n⚠ ${_('Salutation missing – add a contact person to the project or the contract')}`
                : '';
            this.preview.set_label(
                rendered
                    ? rendered.text + missing
                    : _('No cover letter (set neither here nor as the entity’s default).'),
            );
        } catch (err) {
            this.preview.set_label(errorText(err));
        }
    }

    private fill(): void {
        const e = this.existing;
        const months = e?.intervalMonths ?? 12;
        this.interval.set_selected(
            Math.max(
                0,
                INTERVALS.findIndex((i) => i.months === months),
            ),
        );
        if (e) {
            this.customer.set_text(e.customer.name);
            this.email.set_text(e.customer.email ?? '');
            this.description.set_text(e.description ?? '');
            this.notes.set_text(e.notes ?? '');
            this.formality.set_selected(e.customer.formality === 'sie' ? 1 : 0);
            this.greeting.set_text(e.customer.greeting ?? '');
            this.closing.set_text(e.customer.closing ?? '');
            this.headerView.get_buffer().set_text(e.header ?? '', -1);
            this.start.set_text(e.nextPeriod.start);
            this.end.set_text(e.nextPeriod.end);
            for (const item of e.items) this.addItemRow(item);
            this.updatePreview();
            return;
        }
        // A fresh schedule starts today and runs one interval — the shape of nearly every real one,
        // and a starting point beats an empty date field nobody knows the format of.
        const today = new Date().toISOString().slice(0, 10);
        this.start.set_text(today);
        this.end.set_text(nextPeriod({ start: today, end: today }, months).start);
        this.syncEnd();
        this.addItemRow(null);
        this.updatePreview();
    }

    /** The end of the period the current start + rhythm imply (the day before the next start). */
    private syncEnd(): void {
        const start = (this.start.get_text() ?? '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return;
        const months = INTERVALS[this.interval.get_selected()]?.months ?? 12;
        this.end.set_text(nextPeriod({ start, end: start }, months).end);
    }

    private addItemRow(item: RecurringItem | null): { title: Adw.EntryRow } {
        const title = new Adw.EntryRow({ title: _('Line item (max. 40 characters)') });
        const quantity = new Adw.EntryRow({ title: _('Quantity') });
        const price = new Adw.EntryRow({ title: _('Net per unit (€)') });
        const vat = new Adw.EntryRow({ title: _('VAT rate (%)') });
        title.set_text(item?.title ?? '');
        quantity.set_text(String(item?.quantity ?? 1));
        price.set_text(item ? String(item.unitPrice) : '');
        vat.set_text(String(item?.vatRate ?? 19));

        const remove = new Gtk.Button({ iconName: 'user-trash-symbolic', valign: Gtk.Align.CENTER });
        remove.add_css_class('flat');
        remove.set_tooltip_text(_('Remove line item'));
        remove.connect('clicked', () => {
            for (const row of [title, quantity, price, vat]) {
                row.set_text('');
                row.set_visible(false);
            }
        });
        title.add_suffix(remove);

        for (const row of [title, quantity, price, vat]) this.itemsGroup.add(row);
        this.itemRows.push({ title, quantity, price, vat });
        return { title };
    }

    private onSave(): void {
        const customer = (this.customer.get_text() ?? '').trim();
        if (!customer) return this.warn(_('The customer name is missing.'));

        const start = (this.start.get_text() ?? '').trim();
        const end = (this.end.get_text() ?? '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
            return this.warn(_('The period must be in YYYY-MM-DD format.'));
        }
        if (end < start) return this.warn(_('The period ends before it begins.'));

        const items: RecurringItem[] = [];
        for (const row of this.itemRows) {
            const label = (row.title.get_text() ?? '').trim();
            if (!label) continue; // a removed or never-filled row
            const price = parseGermanInput(row.price.get_text() ?? '');
            if (price == null) return this.warn(fmt(_('“{item}”: the net amount is not a number.'), { item: label }));
            const quantity = parseGermanInput(row.quantity.get_text() ?? '') ?? 1;
            const vat = parseGermanInput(row.vat.get_text() ?? '') ?? 19;
            items.push({ title: label.slice(0, 40), quantity, unitPrice: price, vatRate: vat });
        }
        if (items.length === 0) return this.warn(_('At least one line item with a designation and an amount.'));

        const months = INTERVALS[this.interval.get_selected()]?.months ?? 12;
        const description = (this.description.get_text() ?? '').trim();
        const email = (this.email.get_text() ?? '').trim();
        const greeting = (this.greeting.get_text() ?? '').trim();
        const closing = (this.closing.get_text() ?? '').trim();
        const header = this.headerText().trim();
        // Fail at save, not at invoice time: a typo'd placeholder would otherwise surface months later.
        try {
            if (header)
                buildHeader(
                    {
                        ...this.existing,
                        customer: { name: customer, formality: this.selectedFormality() },
                        header,
                        nextPeriod: { start, end },
                        items,
                        domains: [],
                    } as unknown as RecurringInvoice,
                    {},
                );
        } catch (err) {
            return this.warn(errorText(err));
        }

        try {
            const id =
                this.existing?.id ??
                uniqueScheduleId(
                    slugForSchedule(customer, description),
                    listSchedules(this.entity.id).map((s) => s.id),
                );
            saveSchedule({
                ...this.existing,
                id,
                entityId: this.entity.id,
                status: this.existing?.status ?? 'active',
                projectId: this.selectedProject()?.id,
                mailTemplateId: this.mailTemplates[this.mailTemplate.get_selected() - 1]?.id,
                customer: {
                    ...this.existing?.customer,
                    name: customer,
                    contactId: this.selectedContactId(),
                    ...(email ? { email } : {}),
                    greeting: greeting || undefined,
                    formality: this.selectedFormality(),
                    closing: closing || undefined,
                },
                header: header || undefined,
                ...(description ? { description } : {}),
                notes: (this.notes.get_text() ?? '').trim() || undefined,
                domains: this.existing?.domains ?? [],
                intervalMonths: months,
                nextPeriod: { start, end },
                reminderLeadDays: this.existing?.reminderLeadDays ?? 28,
                currency: this.existing?.currency ?? 'EUR',
                items,
            } as RecurringInvoice);
            this.done(
                this.existing
                    ? fmt(_('“{name}” saved'), { name: customer })
                    : fmt(_('“{name}” created'), { name: customer }),
                true,
            );
            this.close();
        } catch (err) {
            this.warn(fmt(_('Could not save: {error}'), { error: errorText(err) }));
        }
    }

    private warn(message: string): void {
        this.banner.set_title(markup(message));
        this.banner.set_revealed(true);
    }
}
