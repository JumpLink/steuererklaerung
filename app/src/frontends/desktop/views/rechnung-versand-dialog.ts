/**
 * <BhRechnungVersandDialog> — mail one invoice to the customer: edit the text, look at the
 * preview, confirm. Nothing is sent before that last confirmation.
 *
 * The account is the entity's own SMTP account, set up once under Einstellungen → Anbindungen →
 * E-Mail-Versand (host, port, user, sender in the manifest; the password in the keyring). This
 * dialog only reads it: it shows the sender, or, without a usable account, a way to the settings.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import {
    defaultInvoiceMailDeps,
    draftInvoiceMail,
    loadInvoiceMailSetup,
    sendInvoiceEmail,
    type InvoiceMailRequest,
    type InvoiceMailSetup,
} from '../../../core/actions/send-invoice-email.ts';
import type { OutgoingInvoiceDetail, OutgoingInvoiceSummary } from '../../../core/presenters/rechnungen.ts';
import { smtpAccountFor } from '../../../core/mail/mail-sender.ts';
import {
    BUILTIN_TEMPLATE_ID,
    BUILTIN_TEMPLATE_NAME,
    MAIL_PLACEHOLDERS,
    unknownMailPlaceholders,
    type MailPlaceholder,
} from '../../../core/mail/invoice-mail.ts';
import { deDateTime } from '../../../core/lib/format.ts';
import type { AppEntity } from '../entities.ts';
import { navigateTo } from '../nav.ts';
import { lookupMailPassword } from '../data/mail-secret.ts';
import { desktopMailSender } from '../data/mail-sender.ts';
import { showToast } from '../toast.ts';
import { confirmDialog, errorDialog } from './dialogs.ts';
import { _, fmt } from '../i18n.ts';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const kib = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;

export class BhRechnungVersandDialog {
    private readonly dialog = new Adw.Dialog();
    private readonly toRow = new Adw.EntryRow({ title: _('Recipient') });
    private readonly subjectRow = new Adw.EntryRow({ title: _('Subject') });
    private readonly textView = new Gtk.TextView({
        wrapMode: Gtk.WrapMode.WORD_CHAR,
        topMargin: 8,
        bottomMargin: 8,
        leftMargin: 12,
        rightMargin: 12,
    });
    private readonly templateRow = new Adw.ComboRow({ title: _('Template') });
    private readonly warnRow = new Adw.ActionRow({ title: _('Note'), visible: false });
    private previewRow: Adw.ButtonRow | null = null;
    private templateIds: string[] = [];
    private currentTemplate = BUILTIN_TEMPLATE_ID;
    private missing: string[] = [];
    private filling = false;
    private dirty = false;
    private lastFocus: 'subject' | 'text' = 'text';
    private setup!: InvoiceMailSetup;
    private entity!: AppEntity;
    private summary!: OutgoingInvoiceSummary;
    private storedPassword: string | null = null;
    private parent!: Gtk.Widget;
    private busy = false;
    /** Called after a send attempt reached the ledger — success or failure — so lists can reload. */
    onSent: (() => void) | null = null;

    /** Open the dialog for one invoice on a parent widget. */
    open(
        parent: Gtk.Widget,
        entity: AppEntity,
        summary: OutgoingInvoiceSummary,
        detail: OutgoingInvoiceDetail | null,
    ): void {
        this.parent = parent;
        this.entity = entity;
        this.summary = summary;
        try {
            this.setup = loadInvoiceMailSetup(
                entity.id,
                { invoiceId: summary.id, invoiceNumber: summary.number },
                detail?.recipient?.email ?? null,
                entity.name,
            );
        } catch (err) {
            void errorDialog(parent, _('Cannot send'), errorText(err));
            return;
        }
        this.storedPassword = lookupMailPassword(entity.id);

        this.dialog.set_title(_('Invoice by email'));
        this.dialog.set_content_width(560);
        this.dialog.set_content_height(900);

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        toolbar.set_content(this.buildPage());
        this.dialog.set_child(toolbar);
        this.fillFields();
        this.dialog.present(parent);
        if (this.ready()) this.toRow.grab_focus();
    }

    private buildPage(): Adw.PreferencesPage {
        const page = new Adw.PreferencesPage();

        const accounts = new Adw.PreferencesGroup({ title: _('Sending account') });
        const sentBefore = this.setup.history.find((h) => h.result === 'sent');
        if (sentBefore)
            accounts.set_description(
                fmt(_('Caution: already sent on {date} to {recipients}'), {
                    date: deDateTime(sentBefore.at),
                    recipients: sentBefore.to.join(', '),
                }),
            );
        else if (this.setup.lastSent)
            accounts.set_description(
                fmt(_('Last sent on {date} to {recipients}'), {
                    date: deDateTime(this.setup.lastSent.sentAt),
                    recipients: this.setup.lastSent.sentTo.join(', '),
                }),
            );
        if (this.setup.account && this.storedPassword) {
            accounts.add(
                new Adw.ActionRow({ title: fmt(_('From: {sender} (SMTP)'), { sender: this.setup.account.from }) }),
            );
        } else {
            const missing = new Adw.ActionRow({
                title: this.setup.account
                    ? _('The sending account’s password is missing')
                    : _('No sending account set up'),
                subtitle: _('Settings → Connections → Email sending'),
            });
            const open = new Gtk.Button({ label: _('Set up sending account'), valign: Gtk.Align.CENTER });
            open.add_css_class('suggested-action');
            open.connect('clicked', () => {
                this.dialog.close();
                navigateTo(this.parent, 'settings');
            });
            missing.add_suffix(open);
            accounts.add(missing);
        }
        page.add(accounts);

        const message = new Adw.PreferencesGroup({
            title: _('Message'),
            description: fmt(_('Invoice {number} is attached as a PDF. Subject and text can be changed.'), {
                number: this.summary.number ?? '',
            }),
        });
        this.templateIds = [BUILTIN_TEMPLATE_ID, ...this.setup.templates.map((t) => t.id)];
        this.templateRow.set_model(
            Gtk.StringList.new([BUILTIN_TEMPLATE_NAME, ...this.setup.templates.map((t) => t.name)]),
        );
        this.templateRow.set_selected(Math.max(0, this.templateIds.indexOf(this.setup.templateId)));
        this.currentTemplate = this.templateIds[this.templateRow.get_selected()];
        this.templateRow.connect('notify::selected', () => void this.onTemplateChosen());
        message.add(this.templateRow);
        message.add(this.toRow);
        message.add(this.subjectRow);
        this.subjectRow.connect('changed', () => this.onEdited());
        this.textView.get_buffer().connect('changed', () => this.onEdited());
        const subjectFocus = new Gtk.EventControllerFocus();
        subjectFocus.connect('enter', () => (this.lastFocus = 'subject'));
        this.subjectRow.add_controller(subjectFocus);
        const textFocus = new Gtk.EventControllerFocus();
        textFocus.connect('enter', () => (this.lastFocus = 'text'));
        this.textView.add_controller(textFocus);
        const frame = new Gtk.Frame({
            child: new Gtk.ScrolledWindow({
                hscrollbarPolicy: Gtk.PolicyType.NEVER,
                minContentHeight: 200,
                child: this.textView,
            }),
        });
        message.add(frame);
        page.add(message);

        const warn = new Adw.PreferencesGroup();
        this.warnRow.add_css_class('error');
        warn.add(this.warnRow);
        page.add(warn);

        const holders = new Adw.PreferencesGroup();
        const expander = new Adw.ExpanderRow({
            title: _('Placeholders'),
            subtitle: _('A click inserts the placeholder at the cursor'),
        });
        for (const [name, what] of Object.entries(MAIL_PLACEHOLDERS)) {
            const row = new Adw.ActionRow({ title: `{${name}}`, subtitle: what, activatable: true });
            row.connect('activated', () => this.insertPlaceholder(name as MailPlaceholder));
            expander.add_row(row);
        }
        holders.add(expander);
        page.add(holders);

        if (this.setup.history.length) {
            const hist = new Adw.PreferencesGroup({ title: _('Previous sends') });
            for (const h of this.setup.history) {
                hist.add(
                    new Adw.ActionRow({
                        title: `${deDateTime(h.at)} · ${h.result === 'sent' ? _('sent') : _('failed')}`,
                        subtitle:
                            h.result === 'sent'
                                ? fmt(_('to {recipients}'), { recipients: h.to.join(', ') })
                                : (h.error ?? ''),
                    }),
                );
            }
            page.add(hist);
        }

        const actions = new Adw.PreferencesGroup();
        const preview = new Adw.ButtonRow({ title: _('Preview and send …') });
        preview.add_css_class('suggested-action');
        this.previewRow = preview;
        preview.set_sensitive(this.ready());
        preview.connect('activated', () => void this.previewAndSend());
        actions.add(preview);
        page.add(actions);
        return page;
    }

    /** The account is saved and its password is in the keyring. */
    private ready(): boolean {
        return !!this.setup.account && !!this.storedPassword;
    }

    private fillFields(): void {
        this.toRow.set_text(this.setup.recipient);
        this.applyTemplate(this.currentTemplate);
    }

    /** Draft subject and text from a template; marks the fields as untouched. */
    private applyTemplate(templateId: string): void {
        const mail = draftInvoiceMail(
            this.setup,
            {
                number: this.summary.number ?? '',
                total: this.summary.total ?? null,
                dueDate: this.summary.dueDate ?? null,
                issueDate: this.summary.issueDate ?? null,
                period:
                    this.summary.performanceStart && this.summary.performanceEnd
                        ? { start: this.summary.performanceStart, end: this.summary.performanceEnd }
                        : null,
                url: this.summary.url,
            },
            templateId,
        );
        this.filling = true;
        this.subjectRow.set_text(mail.subject);
        this.textView.get_buffer().set_text(mail.text, -1);
        this.filling = false;
        this.dirty = false;
        this.missing = mail.missing;
        this.refreshWarning();
    }

    private async onTemplateChosen(): Promise<void> {
        if (this.filling) return;
        const next = this.templateIds[this.templateRow.get_selected()];
        if (!next || next === this.currentTemplate) return;
        if (this.dirty) {
            const ok = await confirmDialog(this.dialog, {
                heading: _('Discard your changes?'),
                body: _('Subject and text were edited by hand. Another template discards those changes.'),
                confirmLabel: _('Discard'),
                destructive: true,
            });
            if (!ok) {
                this.filling = true;
                this.templateRow.set_selected(Math.max(0, this.templateIds.indexOf(this.currentTemplate)));
                this.filling = false;
                return;
            }
        }
        this.currentTemplate = next;
        this.applyTemplate(next);
    }

    private onEdited(): void {
        if (this.filling) return;
        this.dirty = true;
        this.refreshWarning();
    }

    private currentText(): string {
        const buffer = this.textView.get_buffer();
        return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false);
    }

    /** Unknown placeholders block sending; missing values are only reported. */
    private refreshWarning(): void {
        const unknown = unknownMailPlaceholders(`${this.subjectRow.get_text()}\n${this.currentText()}`);
        const lines: string[] = [];
        if (unknown.length)
            lines.push(fmt(_('Unknown placeholders: {list}'), { list: unknown.map((u) => `{${u}}`).join(', ') }));
        if (this.missing.length && !this.dirty)
            lines.push(fmt(_('Missing values: {list}'), { list: this.missing.map((m) => `{${m}}`).join(', ') }));
        this.warnRow.set_visible(lines.length > 0);
        this.warnRow.set_title(_('Note'));
        this.warnRow.set_subtitle(lines.join(' · '));
        this.previewRow?.set_sensitive(this.ready() && unknown.length === 0);
    }

    private insertPlaceholder(name: MailPlaceholder): void {
        const token = `{${name}}`;
        if (this.lastFocus === 'subject') {
            const pos = this.subjectRow.get_position();
            this.subjectRow.insert_text(token, -1, pos);
            this.subjectRow.set_position(pos + token.length);
        } else {
            this.textView.get_buffer().insert_at_cursor(token, -1);
        }
    }

    private request(): InvoiceMailRequest {
        const mail = this.setup.account;
        if (!mail || !this.storedPassword) throw new Error(_('The sending account is not set up.'));
        const account = smtpAccountFor(mail, this.storedPassword);
        return {
            entityId: this.entity.id,
            invoiceId: this.summary.id,
            invoiceNumber: this.summary.number,
            from: mail.from,
            to: this.toRow
                .get_text()
                .split(/[,;]/)
                .map((a) => a.trim())
                .filter(Boolean),
            subject: this.subjectRow.get_text(),
            text: this.currentText(),
            account,
        };
    }

    /** Build the preview, ask, and only then send — the single place `confirm: true` is set. */
    private async previewAndSend(): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        let attempted = false;
        try {
            const req = this.request();
            const deps = defaultInvoiceMailDeps(req, desktopMailSender);
            const result = await sendInvoiceEmail(req, { confirm: false }, deps);
            const p = result.preview;
            const ok = await confirmDialog(this.dialog, {
                heading: _('Send invoice now?'),
                body: [
                    fmt(_('To: {value}'), { value: p.to.join(', ') }),
                    fmt(_('From: {value}'), { value: p.from }),
                    fmt(_('Subject: {value}'), { value: p.subject }),
                    fmt(_('Attachment: {file} ({size})'), {
                        file: p.attachment.filename,
                        size: kib(p.attachment.size),
                    }),
                    '',
                    p.text.length > 400 ? `${p.text.slice(0, 400)} …` : p.text,
                ].join('\n'),
                confirmLabel: _('Send'),
            });
            if (!ok) return;
            attempted = true;
            const sent = await sendInvoiceEmail(req, { confirm: true }, deps);
            if (sent.status !== 'sent') return;
            if (sent.logError) {
                await errorDialog(
                    this.dialog,
                    _('Sent, but not recorded'),
                    fmt(_('The mail was sent. The note on the invoice could not be written: {error}'), {
                        error: sent.logError,
                    }),
                );
            } else {
                showToast(_('Invoice sent'));
            }
            this.dialog.close();
        } catch (err) {
            await errorDialog(this.dialog, _('Sending failed'), errorText(err));
        } finally {
            this.busy = false;
            if (attempted) this.onSent?.();
        }
    }
}
