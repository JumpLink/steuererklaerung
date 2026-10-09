/**
 * <BhRechnungDetailDialog> — an Adw.Dialog with the full detail of one outgoing invoice: positions,
 * per-VAT-rate amounts, dates, payment + storno info, and the back-end's supported actions
 * (PDF/XRechnung open + save today; edit/finalize/mark-paid/storno wired by later slices). Mirrors
 * the web <bh-invoice-detail>. Built programmatically (the body is fully dynamic).
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';
import GObject from '@girs/gobject-2.0';

import Template from './rechnung-detail-dialog.blp';

import {
    loadInvoiceDetail,
    loadInvoicePdf,
    loadInvoiceXml,
    loadInvoiceDoppelzahlung,
    loadOpenInvoicesForPicker,
    loadPaymentCandidates,
    loadRueckzahlungKandidaten,
    entscheideDoppelzahlung,
    type DoppelzahlungEntscheidung,
    type DoppelzahlungVerdachtDetail,
    type OffeneRueckzahlung,
    type InvoiceCapabilities,
    type OutgoingInvoiceDetail,
    type OutgoingInvoiceSummary,
} from '../../../core/presenters/rechnungen.ts';
import {
    cancelOutgoingInvoice,
    deleteOutgoingInvoiceDraft,
    finalizeOutgoingInvoice,
    markOutgoingInvoicePaid,
} from '../../../core/actions/outgoing-invoices.ts';
import { listProjects } from '../../../core/actions/projects.ts';
import {
    clearRechnungProjekt,
    rechnungProjektAnsicht,
    setRechnungProjekt,
} from '../../../core/actions/rechnung-projekt.ts';
import type { AppEntity } from '../entities.ts';
import { deDate, deDateTime, eur, pct } from '../../../core/lib/format.ts';
import { loadRecurringInvoices } from '../../../core/config/index.ts';
import { loadInvoiceMailHistory, withLegacySent } from '../../../core/actions/send-invoice-email.ts';
import { displayInvoiceStatus, INVOICE_STATUS_LABEL, normalizeInvoiceStatus } from '../../../core/invoices/status.ts';
import { verdachtTitel, zahlungZeile } from '../../../core/invoices/doppelzahlung-text.ts';
import { GroupRows, LoadToken, amountLabel, markup } from './util.ts';
import { confirmDialog, errorDialog } from './dialogs.ts';
import { BhRechnungFormDialog } from './rechnung-form-dialog.ts';
import { BhRechnungVersandDialog } from './rechnung-versand-dialog.ts';
import { showToast } from '../toast.ts';

function msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** A small list dialog: one activatable row per item; picking closes the dialog and reports the index. */
function pickDialog(
    parent: Gtk.Widget,
    opts: { title: string; empty: string; items: { title: string; sub: string }[]; onPick: (index: number) => void },
): void {
    const dlg = new Adw.Dialog();
    dlg.set_content_width(520);
    dlg.set_content_height(480);
    const header = new Adw.HeaderBar();
    header.set_title_widget(new Adw.WindowTitle({ title: opts.title, subtitle: '' }));
    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup();
    if (!opts.items.length) group.set_description(opts.empty);
    opts.items.forEach((it, i) => {
        const row = new Adw.ActionRow({ title: markup(it.title), subtitle: markup(it.sub), activatable: true });
        row.set_subtitle_lines(0);
        row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
        row.connect('activated', () => {
            dlg.close();
            opts.onPick(i);
        });
        group.add(row);
    });
    page.add(group);
    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(header);
    toolbar.set_content(page);
    dlg.set_child(toolbar);
    dlg.present(parent);
}

/** Dialog chrome: header (title + subtitle) over a loading/error stack; "content" is added once loaded. */
class BhRechnungDetailBody extends Adw.Bin {
    declare private _window_title: Adw.WindowTitle;
    declare private _stack: Gtk.Stack;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhRechnungDetailBody',
                Template,
                InternalChildren: ['window_title', 'stack'],
            },
            this,
        );
    }

    get stack(): Gtk.Stack {
        return this._stack;
    }

    setTitles(title: string, subtitle: string): void {
        this._window_title.set_title(title);
        this._window_title.set_subtitle(subtitle);
    }
}

export class BhRechnungDetailDialog {
    private readonly dialog = new Adw.Dialog();
    private readonly body = new BhRechnungDetailBody();
    private readonly stack = this.body.stack;
    private readonly token = new LoadToken();
    private entity!: AppEntity;
    private summary!: OutgoingInvoiceSummary;
    private caps!: InvoiceCapabilities;
    private parent!: Gtk.Widget;
    private detail: OutgoingInvoiceDetail | null = null;
    /** Called after a mutation (finalize/storno/paid) so the caller reloads. */
    onChanged: (() => void) | null = null;
    private historyBox: Gtk.Box | null = null;
    private historyGroup: Adw.PreferencesGroup | null = null;
    private doppelBox: Gtk.Box | null = null;
    private readonly doppelToken = new LoadToken();

    constructor() {
        this.dialog.set_content_width(680);
        this.dialog.set_content_height(640);
    }

    /** Present the dialog on a parent view and load the detail. */
    open(parent: Gtk.Widget, entity: AppEntity, summary: OutgoingInvoiceSummary, caps: InvoiceCapabilities): void {
        this.entity = entity;
        this.summary = summary;
        this.caps = caps;
        this.parent = parent;

        const today = new Date().toISOString().slice(0, 10);
        const disp = displayInvoiceStatus(summary.status, summary.dueDate, today);
        this.body.setTitles(
            summary.customerName || summary.number || 'Rechnung',
            `${summary.number ? `Nr. ${summary.number} · ` : ''}${INVOICE_STATUS_LABEL[disp]}`,
        );
        this.dialog.set_child(this.body);
        this.dialog.present(parent);

        const tok = this.token.next();
        loadInvoiceDetail(entity.id, summary.id)
            .then((detail) => {
                if (tok !== this.token.current) return;
                this.fill(detail);
            })
            .catch(() => {
                if (tok !== this.token.current) return;
                // Qonto has no item detail — show a summary-only content page instead of an error.
                this.fillSummaryOnly();
            });
    }

    private contentClamp(): { page: Gtk.Widget; box: Gtk.Box } {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 18 });
        const clamp = new Adw.Clamp({
            maximumSize: 900,
            marginTop: 18,
            marginBottom: 18,
            marginStart: 12,
            marginEnd: 12,
            child: box,
        });
        const scroller = new Gtk.ScrolledWindow({
            hscrollbarPolicy: Gtk.PolicyType.NEVER,
            vexpand: true,
            child: clamp,
        });
        return { page: scroller, box };
    }

    private fill(detail: OutgoingInvoiceDetail | null): void {
        if (!detail) return this.fillSummaryOnly();
        this.detail = detail;
        const { page, box } = this.contentClamp();

        // First, so a warning is not hidden below the fold of a long invoice.
        this.appendDoppelzahlung(box);

        // Positionen.
        const positions = new Adw.PreferencesGroup({ title: 'Positionen' });
        detail.items.forEach((it, i) => {
            const sub = [
                `${it.quantity.toLocaleString('de-DE')}${it.unit ? ` ${it.unit}` : ''} × ${eur(it.unitPrice)}`,
                `USt ${pct(it.vatRate)}`,
            ];
            const row = new Adw.ActionRow({
                title: markup(`${i + 1}. ${it.title}`),
                subtitle: markup(sub.join(' · ')),
            });
            row.add_suffix(amountLabel(eur(it.net)));
            positions.add(row);
        });
        box.append(positions);

        // Beträge.
        const amounts = new Adw.PreferencesGroup({ title: 'Beträge' });
        const amtRows = new GroupRows(amounts);
        this.kv(amtRows, 'Nettobetrag', eur(detail.totals.net));
        for (const r of detail.totals.byRate) this.kv(amtRows, `USt ${pct(r.rate)}`, eur(r.vat));
        this.kv(amtRows, 'Bruttobetrag', eur(detail.totals.gross), true);
        box.append(amounts);

        // Daten.
        const dates = new Adw.PreferencesGroup({ title: 'Daten' });
        const dRows = new GroupRows(dates);
        this.kv(dRows, 'Rechnungsdatum', deDate(detail.issueDate));
        if (detail.dueDate) this.kv(dRows, 'Fällig bis', deDate(detail.dueDate));
        if (detail.performanceStart && detail.performanceEnd)
            this.kv(
                dRows,
                'Leistungszeitraum',
                `${deDate(detail.performanceStart)} – ${deDate(detail.performanceEnd)}`,
            );
        if (detail.recipient?.name) this.kv(dRows, 'Empfänger', detail.recipient.name);
        box.append(dates);

        if (detail.kind !== 'storno') box.append(this.projektGroup(detail.id));

        // Zahlung / Storno.
        if (detail.paidOn || detail.cancelsId || detail.cancelledById) {
            const pay = new Adw.PreferencesGroup({ title: markup('Zahlung & Storno') });
            const pRows = new GroupRows(pay);
            if (detail.paidOn) this.kv(pRows, 'Bezahlt am', deDate(detail.paidOn));
            if (detail.paidTxId) this.kv(pRows, 'Transaktion', detail.paidTxId);
            if (detail.cancelsId) this.kv(pRows, 'Storniert Rechnung', detail.cancelsId);
            if (detail.cancelledById) this.kv(pRows, 'Storniert durch', detail.cancelledById);
            box.append(pay);
        }

        this.appendMailHistory(box);
        box.append(this.actions(detail.status));
        this.stack.add_named(page, 'content');
        this.stack.set_visible_child_name('content');
    }

    /** Rebuild the content from the detail already loaded (a local decision changed, nothing to refetch). */
    private reload(): void {
        const old = this.stack.get_child_by_name('content');
        if (old) this.stack.remove(old);
        this.fill(this.detail);
    }

    /** The invoice's project: where it comes from, set/change it, and take a direct assignment back with its „Danach gilt …". */
    private projektGroup(invoiceId: string): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({ title: 'Projekt' });
        const a = rechnungProjektAnsicht(this.entity.id, invoiceId);
        const projects = listProjects(this.entity.id);
        const shown = a.direkt
            ? `${a.direkt.name} · direkt zugeordnet`
            : a.ueberZeiten.length > 0
              ? `${a.ueberZeiten.map((p) => p.name).join(', ')} · über Zeiten`
              : 'Kein Projekt';
        const row = new Adw.ActionRow({ title: 'Projekt', subtitle: markup(shown) });
        const set = new Gtk.Button({
            label: a.direkt ? 'Ändern …' : 'Zuordnen …',
            valign: Gtk.Align.CENTER,
            cssClasses: ['flat'],
        });
        set.set_sensitive(projects.length > 0);
        set.connect('clicked', () =>
            pickDialog(this.dialog, {
                title: 'Projekt wählen',
                empty: 'Keine Projekte vorhanden.',
                items: projects.map((p) => ({
                    title: p.name,
                    sub: 'Die Rechnung zählt mit ihrem vollen Nettobetrag zu diesem Projekt.',
                })),
                onPick: (i) => {
                    try {
                        setRechnungProjekt(this.entity.id, invoiceId, projects[i].id, 'app');
                        showToast(`Rechnung gehört jetzt zu „${projects[i].name}“`);
                        this.onChanged?.();
                        this.reload();
                    } catch (err) {
                        void errorDialog(this.dialog, 'Konnte nicht zuordnen', msg(err));
                    }
                },
            }),
        );
        row.add_suffix(set);
        if (a.direkt) {
            const undo = new Gtk.Button({
                label: 'Zuordnung aufheben',
                valign: Gtk.Align.CENTER,
                cssClasses: ['flat'],
            });
            undo.set_tooltip_text(a.danach ?? '');
            undo.connect('clicked', () => {
                clearRechnungProjekt(this.entity.id, invoiceId, 'app');
                showToast(a.danach ?? 'Zuordnung aufgehoben');
                this.onChanged?.();
                this.reload();
            });
            row.add_suffix(undo);
        }
        group.add(row);
        return group;
    }

    /** Placeholder for the double-payment groups; filled (and refilled after a decision) asynchronously. */
    private appendDoppelzahlung(box: Gtk.Box): void {
        this.doppelBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 18, visible: false });
        box.append(this.doppelBox);
        this.reloadDoppelzahlung();
    }

    private reloadDoppelzahlung(): void {
        const holder = this.doppelBox;
        if (!holder) return;
        const tok = this.doppelToken.next();
        loadInvoiceDoppelzahlung(this.entity.id, this.summary.id)
            .then((state) => {
                if (tok !== this.doppelToken.current) return;
                let child = holder.get_first_child();
                while (child) {
                    const next = child.get_next_sibling();
                    holder.remove(child);
                    child = next;
                }
                for (const v of state.verdacht) holder.append(this.verdachtGroup(v));
                if (state.rueckzahlungOffen.length) holder.append(this.rueckzahlungGroup(state.rueckzahlungOffen));
                // An empty box would still add a gap between its neighbours.
                holder.set_visible(holder.get_first_child() !== null);
            })
            .catch(() => {
                /* a hint never blocks the detail */
            });
    }

    /** One suspicion: the headline, then each suspicious credit with the three ways to settle it. */
    private verdachtGroup(v: DoppelzahlungVerdachtDetail): Gtk.Widget {
        const group = new Adw.PreferencesGroup({ title: markup(verdachtTitel(v)) });
        for (const t of v.txs) {
            const z = zahlungZeile(t);
            const row = new Adw.ExpanderRow({ title: markup(z.title), subtitle: markup(z.sub) });
            row.add_prefix(
                new Gtk.Image({
                    iconName: 'dialog-warning-symbolic',
                    cssClasses: ['warning'],
                    valign: Gtk.Align.CENTER,
                }),
            );
            row.add_row(
                this.buttonRow(
                    'Ist eine Doppelzahlung',
                    () => void this.decide(t.id, { art: 'ist_doppelzahlung' }, 'Als Doppelzahlung erfasst'),
                ),
            );
            row.add_row(this.buttonRow('Gehört zu einer anderen Rechnung …', () => void this.pickAndereRechnung(t.id)));
            row.add_row(
                this.buttonRow(
                    'Ist in Ordnung',
                    () => void this.decide(t.id, { art: 'in_ordnung' }, 'Als in Ordnung erfasst'),
                ),
            );
            group.add(row);
        }
        return group;
    }

    /** Recorded double payments of this invoice that still wait for the refund to the customer. */
    private rueckzahlungGroup(open: OffeneRueckzahlung[]): Gtk.Widget {
        const group = new Adw.PreferencesGroup({
            title: 'Rückzahlung offen',
            description: 'Der zu viel erhaltene Betrag ist noch nicht an den Kunden zurückgezahlt.',
        });
        for (const r of open) {
            const z =
                r.bookingDate != null && r.amount != null
                    ? zahlungZeile({ bookingDate: r.bookingDate, amount: r.amount })
                    : { title: r.bezeichnung, sub: '' };
            const row = new Adw.ExpanderRow({ title: markup(z.title), subtitle: markup(z.sub) });
            row.add_prefix(
                new Gtk.Image({
                    iconName: 'dialog-warning-symbolic',
                    cssClasses: ['warning'],
                    valign: Gtk.Align.CENTER,
                }),
            );
            row.add_row(this.buttonRow('Rückzahlung verknüpfen …', () => this.pickRueckzahlung(r)));
            row.add_row(this.buttonRow('Außerhalb zurückgezahlt …', () => void this.rueckzahlungExtern(r.txId)));
            group.add(row);
        }
        return group;
    }

    /** Apply one decision; the core's German refusal (e.g. "only partly surplus") is shown as is. */
    private async decide(txId: string, entscheidung: DoppelzahlungEntscheidung, toast: string): Promise<void> {
        try {
            await entscheideDoppelzahlung(this.entity.id, txId, entscheidung);
            showToast(toast);
            this.reloadDoppelzahlung();
            this.onChanged?.();
        } catch (err) {
            await errorDialog(this.dialog, 'Entscheidung nicht gespeichert', msg(err));
        }
    }

    private async pickAndereRechnung(txId: string): Promise<void> {
        try {
            const open = await loadOpenInvoicesForPicker(this.entity.id, this.summary.id);
            pickDialog(this.dialog, {
                title: 'Gehört zu welcher Rechnung?',
                empty: 'Keine weitere offene Rechnung vorhanden.',
                items: open.map((i) => ({
                    title: `${i.number ? `Nr. ${i.number} · ` : ''}${i.customerName ?? ''}`,
                    sub: [i.issueDate ? deDate(i.issueDate) : '', i.total != null ? eur(i.total) : '']
                        .filter(Boolean)
                        .join(' · '),
                })),
                onPick: (n) =>
                    void this.decide(
                        txId,
                        { art: 'andere_rechnung', rechnungId: open[n].id },
                        'Der anderen Rechnung zugeordnet',
                    ),
            });
        } catch (err) {
            await errorDialog(this.dialog, 'Rechnungen nicht ladbar', msg(err));
        }
    }

    private pickRueckzahlung(r: OffeneRueckzahlung): void {
        try {
            const debits = loadRueckzahlungKandidaten(this.entity.id, r.amount ?? 0);
            pickDialog(this.dialog, {
                title: 'Welche Überweisung war die Rückzahlung?',
                empty: 'Keine Abbuchung gefunden. Lief die Rückzahlung außerhalb der Konten, „Außerhalb zurückgezahlt“ wählen.',
                items: debits.map((d) => {
                    const z = zahlungZeile(d);
                    return { title: `${z.title}`, sub: z.sub || d.accountKey };
                }),
                onPick: (n) =>
                    void this.decide(
                        r.txId,
                        { art: 'rueckzahlung', refundTxId: debits[n].id },
                        'Rückzahlung verknüpft',
                    ),
            });
        } catch (err) {
            void errorDialog(this.dialog, 'Abbuchungen nicht ladbar', msg(err));
        }
    }

    /** Ask for the date of a refund that ran outside the entity's accounts. */
    private async rueckzahlungExtern(txId: string): Promise<void> {
        const dlg = new Adw.AlertDialog({
            heading: 'Außerhalb zurückgezahlt',
            body: 'Datum der Rückzahlung (JJJJ-MM-TT), z. B. bei Zahlung aus privaten Mitteln.',
        });
        const entry = new Gtk.Entry({ text: new Date().toISOString().slice(0, 10) });
        dlg.set_extra_child(entry);
        dlg.add_response('cancel', 'Abbrechen');
        dlg.add_response('confirm', 'Speichern');
        dlg.set_response_appearance('confirm', Adw.ResponseAppearance.SUGGESTED);
        dlg.set_close_response('cancel');
        const answer = await new Promise<string>((resolve) =>
            dlg.choose(this.dialog, null, (_s, res) => resolve(dlg.choose_finish(res))),
        );
        if (answer !== 'confirm') return;
        await this.decide(txId, { art: 'rueckzahlung_extern', datum: entry.get_text().trim() }, 'Rückzahlung erfasst');
    }

    /** The send attempts of this invoice, newest first; nothing when it was never mailed. */
    private appendMailHistory(box: Gtk.Box): void {
        const group = this.buildMailHistory();
        if (!group) return;
        this.historyBox = box;
        this.historyGroup = group;
        box.append(group);
    }

    /** Rebuild the history in place after a send, so the open detail shows the new attempt. */
    private refreshMailHistory(): void {
        const box = this.historyBox;
        const old = this.historyGroup;
        const group = this.buildMailHistory();
        if (!box || !old || !group) return;
        box.insert_child_after(group, old);
        box.remove(old);
        this.historyGroup = group;
    }

    private buildMailHistory(): Adw.PreferencesGroup | null {
        let history: ReturnType<typeof loadInvoiceMailHistory> = [];
        try {
            history = loadInvoiceMailHistory(this.entity.id, this.summary.id);
            if (!history.length) {
                // Sent before the history table existed: only the schedule's lastInvoice remembers it.
                const legacy = withLegacySent(new Map(), loadRecurringInvoices(), this.entity.id, [this.summary]);
                const rec = legacy.get(this.summary.id);
                if (rec) history = [rec];
            }
        } catch {
            return null;
        }
        const group = new Adw.PreferencesGroup({ title: 'E-Mail-Verlauf' });
        if (!history.length) {
            group.set_description('Noch nicht per E-Mail gesendet.');
        }
        for (const h of history) {
            group.add(
                new Adw.ActionRow({
                    title: markup(`${deDateTime(h.at)} · ${h.result === 'sent' ? 'gesendet' : 'fehlgeschlagen'}`),
                    subtitle: markup(
                        h.result === 'sent'
                            ? [`an ${h.to.join(', ')}`, h.subject].filter(Boolean).join(' · ')
                            : (h.error ?? 'Fehler'),
                    ),
                }),
            );
        }
        return group;
    }

    private fillSummaryOnly(): void {
        const { page, box } = this.contentClamp();
        const group = new Adw.PreferencesGroup({ title: 'Übersicht' });
        const rows = new GroupRows(group);
        this.kv(rows, 'Rechnungsdatum', deDate(this.summary.issueDate));
        if (this.summary.dueDate) this.kv(rows, 'Fällig bis', deDate(this.summary.dueDate));
        if (this.summary.total != null) this.kv(rows, 'Betrag', eur(this.summary.total));
        box.append(group);
        this.appendDoppelzahlung(box);
        this.appendMailHistory(box);
        box.append(this.actions(this.summary.status));
        this.stack.add_named(page, 'content');
        this.stack.set_visible_child_name('content');
    }

    /** Action buttons group, gated by capabilities + status. */
    private actions(status: string): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({ title: 'Aktionen' });
        const isDraft = status === 'draft';
        const norm = normalizeInvoiceStatus(status);
        if (isDraft && this.caps.editDraft)
            group.add(this.buttonRow('Bearbeiten', () => this.edit(), 'suggested-action'));
        if (isDraft && this.caps.finalize)
            group.add(this.buttonRow('Festschreiben', () => void this.finalize(), 'suggested-action'));
        if (isDraft && this.caps.deleteDraft)
            group.add(this.buttonRow('Entwurf löschen', () => void this.deleteDraft(), 'destructive-action'));
        if (norm === 'open' && this.caps.markPaid)
            group.add(this.buttonRow('Als bezahlt markieren', () => this.openPaidDialog()));
        if ((norm === 'open' || norm === 'paid') && this.caps.cancelStorno)
            group.add(this.buttonRow('Stornieren', () => void this.storno(), 'destructive-action'));
        if (this.caps.pdf === 'local' && !isDraft)
            group.add(this.buttonRow('PDF öffnen', () => void this.openPdf(false)));
        if (this.caps.pdf === 'local' && !isDraft)
            group.add(this.buttonRow('Speichern unter …', () => void this.openPdf(true)));
        if (this.caps.pdf && !isDraft) group.add(this.buttonRow('Per E-Mail senden …', () => this.openVersand()));
        if (this.caps.pdf === 'hosted' && this.summary.url)
            group.add(this.buttonRow('In Qonto öffnen', () => this.openUri(this.summary.url as string)));
        if (this.caps.xml && !isDraft)
            group.add(this.buttonRow('XRechnung (XML) speichern', () => void this.saveXml()));
        return group;
    }

    private buttonRow(title: string, onActivate: () => void, css?: string): Adw.ButtonRow {
        const row = new Adw.ButtonRow({ title });
        if (css) row.add_css_class(css);
        row.connect('activated', onActivate);
        return row;
    }

    /** Open the create/edit form prefilled with this draft. */
    private edit(): void {
        const detail = this.detail;
        if (!detail) return;
        const form = new BhRechnungFormDialog();
        form.open(this.parent, this.entity, detail, () => {
            this.onChanged?.();
            this.dialog.close();
        });
    }

    /** Open the mail dialog: preview and confirmation happen there, nothing is sent from this button. */
    private openVersand(): void {
        const versand = new BhRechnungVersandDialog();
        versand.onSent = () => {
            this.refreshMailHistory();
            this.onChanged?.();
        };
        versand.open(this.parent, this.entity, this.summary, this.detail);
    }

    /** Festschreiben with an irreversible-action confirmation. */
    private async finalize(): Promise<void> {
        const ok = await confirmDialog(this.dialog, {
            heading: 'Rechnung festschreiben?',
            body: 'Die Rechnung erhält eine fortlaufende Nummer und kann danach nicht mehr bearbeitet werden. Dieser Schritt ist unwiderruflich.',
            confirmLabel: 'Festschreiben',
        });
        if (!ok) return;
        try {
            await finalizeOutgoingInvoice(this.entity.id, this.summary.id);
            showToast('Rechnung festgeschrieben');
            this.onChanged?.();
            this.dialog.close();
        } catch (err) {
            await errorDialog(
                this.dialog,
                'Festschreiben fehlgeschlagen',
                err instanceof Error ? err.message : String(err),
            );
        }
    }

    /** Delete the draft (destructive confirmation). */
    private async deleteDraft(): Promise<void> {
        const ok = await confirmDialog(this.dialog, {
            heading: 'Entwurf löschen?',
            body: 'Der Rechnungsentwurf wird endgültig entfernt.',
            confirmLabel: 'Löschen',
            destructive: true,
        });
        if (!ok) return;
        try {
            await deleteOutgoingInvoiceDraft(this.entity.id, this.summary.id);
            showToast('Entwurf gelöscht');
            this.onChanged?.();
            this.dialog.close();
        } catch (err) {
            await errorDialog(this.dialog, 'Löschen fehlgeschlagen', err instanceof Error ? err.message : String(err));
        }
    }

    /** A small dialog to mark the invoice paid: a date + an optional settling transaction. */
    private openPaidDialog(): void {
        const today = new Date().toISOString().slice(0, 10);
        const dlg = new Adw.Dialog();
        dlg.set_content_width(520);
        const header = new Adw.HeaderBar();
        header.set_title_widget(new Adw.WindowTitle({ title: 'Als bezahlt markieren', subtitle: '' }));
        const page = new Adw.PreferencesPage();

        const group = new Adw.PreferencesGroup();
        const dateRow = new Adw.EntryRow({ title: 'Bezahlt am (JJJJ-MM-TT)', text: today });
        group.add(dateRow);
        const txList = new Gtk.StringList();
        txList.append('Ohne Verknüpfung');
        const txRow = new Adw.ComboRow({ title: 'Transaktion', model: txList });
        group.add(txRow);
        page.add(group);

        const actions = new Adw.PreferencesGroup();
        const confirm = new Adw.ButtonRow({ title: 'Als bezahlt buchen' });
        confirm.add_css_class('suggested-action');
        actions.add(confirm);
        page.add(actions);

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(header);
        toolbar.set_content(page);
        dlg.set_child(toolbar);
        dlg.present(this.parent);

        // Load candidates into the ComboRow (index 0 = "no link").
        let candidateIds: (string | undefined)[] = [undefined];
        loadPaymentCandidates(this.entity.id, this.summary.id)
            .then((cands) => {
                for (const c of cands)
                    txList.append(`${deDate(c.bookingDate)} · ${eur(c.amount)} · ${c.counterparty || c.accountKey}`);
                candidateIds = [undefined, ...cands.map((c) => c.txId)];
            })
            .catch(() => {
                /* no candidates — the "ohne Verknüpfung" option remains */
            });

        confirm.connect('activated', () => {
            const paidOn = dateRow.get_text() || today;
            const txId = candidateIds[txRow.get_selected()];
            void markOutgoingInvoicePaid(this.entity.id, this.summary.id, { paidAt: paidOn, txId })
                .then(() => {
                    dlg.close();
                    showToast('Rechnung als bezahlt markiert');
                    this.onChanged?.();
                    this.dialog.close();
                })
                .catch(
                    (err: unknown) =>
                        void errorDialog(dlg, 'Fehlgeschlagen', err instanceof Error ? err.message : String(err)),
                );
        });
    }

    /** Cancel via storno (destructive confirmation). */
    private async storno(): Promise<void> {
        const ok = await confirmDialog(this.dialog, {
            heading: 'Rechnung stornieren?',
            body: 'Es wird eine Stornorechnung erstellt; die Rechnung gilt danach als aufgehoben. Dieser Schritt ist unwiderruflich.',
            confirmLabel: 'Stornieren',
            destructive: true,
        });
        if (!ok) return;
        try {
            await cancelOutgoingInvoice(this.entity.id, this.summary.id, {});
            showToast('Stornorechnung erstellt');
            this.onChanged?.();
            this.dialog.close();
        } catch (err) {
            await errorDialog(
                this.dialog,
                'Stornieren fehlgeschlagen',
                err instanceof Error ? err.message : String(err),
            );
        }
    }

    private kv(rows: GroupRows, key: string, value: string, heading = false): void {
        const row = new Adw.ActionRow({ title: key });
        row.add_suffix(
            heading
                ? amountLabel(value, { heading: true })
                : new Gtk.Label({ label: value, cssClasses: ['dim-label'], valign: Gtk.Align.CENTER }),
        );
        rows.add(row);
    }

    /** Fetch the PDF bytes, write to the cache dir, and open (or Save-As). */
    private async openPdf(saveAs: boolean): Promise<void> {
        try {
            const file = await loadInvoicePdf(this.entity.id, this.summary.id);
            if (!file) return;
            if (file.kind === 'url') return this.openUri(file.url);
            const path = this.writeCache(file.filename, file.bytes);
            if (saveAs) {
                const dialog = new Gtk.FileDialog({ initialName: file.filename });
                dialog.save(this.rootWindow(), null, (_s, res) => {
                    try {
                        const dest = dialog.save_finish(res);
                        if (dest) {
                            Gio.File.new_for_path(path).copy(dest, Gio.FileCopyFlags.OVERWRITE, null, null);
                            showToast('Rechnung gespeichert');
                        }
                    } catch {
                        /* user cancelled */
                    }
                });
            } else {
                new Gtk.FileLauncher({ file: Gio.File.new_for_path(path) }).launch(this.rootWindow(), null, () => {});
            }
        } catch (err) {
            await errorDialog(this.dialog, 'PDF nicht verfügbar', err instanceof Error ? err.message : String(err));
        }
    }

    private async saveXml(): Promise<void> {
        try {
            const file = await loadInvoiceXml(this.entity.id, this.summary.id);
            if (!file || file.kind !== 'bytes') return;
            const path = this.writeCache(file.filename, file.bytes);
            const dialog = new Gtk.FileDialog({ initialName: file.filename });
            dialog.save(this.rootWindow(), null, (_s, res) => {
                try {
                    const dest = dialog.save_finish(res);
                    if (dest) {
                        Gio.File.new_for_path(path).copy(dest, Gio.FileCopyFlags.OVERWRITE, null, null);
                        showToast('XRechnung gespeichert');
                    }
                } catch {
                    /* cancelled */
                }
            });
        } catch (err) {
            await errorDialog(
                this.dialog,
                'XRechnung nicht verfügbar',
                err instanceof Error ? err.message : String(err),
            );
        }
    }

    private openUri(uri: string): void {
        new Gtk.UriLauncher({ uri }).launch(this.rootWindow(), null, () => {});
    }

    /** Write bytes into ~/.cache/steuererklaerung/rechnungen and return the path. */
    private writeCache(filename: string, bytes: Uint8Array): string {
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'steuererklaerung', 'rechnungen']);
        GLib.mkdir_with_parents(dir, 0o755);
        const path = GLib.build_filenamev([dir, filename]);
        GLib.file_set_contents(path, bytes);
        return path;
    }

    private rootWindow(): Gtk.Window | null {
        const root = this.dialog.get_root();
        return root instanceof Gtk.Window ? root : null;
    }
}
