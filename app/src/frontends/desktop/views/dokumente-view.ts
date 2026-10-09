/**
 * <BhDokumenteView> — the Belege / Dokumente view (read-only list).
 *
 * Mirrors the document list of the web "Belege" (bh-documents-view): a searchable card grid in the
 * web, here a boxed list — title, correspondent · date, invoice number, linked-booking count, and
 * the amount. The data comes from the entity's DmsProvider (builtin = local, Paperless = outbound),
 * loaded async (see data/documents.ts). File preview / thumbnails / upload / link come later.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import Template from './dokumente-view.blp';
import { loadDocuments, type DmsDocument } from '../../../core/presenters/belege.ts';
import { appSession } from '../data/session.ts';
import { showToast } from '../toast.ts';
import { BhBelegMetadatenDialog } from './beleg-metadaten-dialog.ts';
import { pickAndStoreReceipts, presentUploadFailures, summarizeUpload } from './beleg-upload.ts';
import { humanizeKey } from '../../../core/lib/qonto-categories.ts';
import type { AppEntity } from '../entities.ts';
import { deDate, eur } from '../../../core/lib/format.ts';
import { prefillRecordOf } from '../../../core/invoices/e-rechnung/index.ts';
import { rechnungsartLabel } from './rechnungsart-row.ts';
import { GroupRows, LoadToken, amountLabel, emptyState, loadIntoStack, markup } from './util.ts';
import { _, _n, fmt } from '../i18n.ts';

/** Cap the rendered rows — a non-virtualised boxed list stays snappy up to a few hundred. */
const MAX_ROWS = 400;

const DMS_LABEL: Record<string, string> = { builtin: _('built-in DMS'), paperless: 'Paperless' };

export class BhDokumenteView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _summary_group: Adw.PreferencesGroup;
    declare private _list_group: Adw.PreferencesGroup;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhDokumenteView',
                Template,
                InternalChildren: ['stack', 'error_page', 'summary_group', 'list_group'],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    private readonly summary: GroupRows;
    private readonly list: GroupRows;

    constructor() {
        super();
        this.summary = new GroupRows(this._summary_group);
        this.list = new GroupRows(this._list_group);
    }

    private entity: AppEntity | null = null;
    private year = 0;
    /** The list as last rendered — the dialog suggests values from the sender's earlier invoices. */
    private docs: DmsDocument[] = [];

    reload(entity: AppEntity, year: number): void {
        this.entity = entity;
        this.year = year;
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: _('Could not load the receipts'),
            load: () => loadDocuments(appSession(), entity, year),
            fill: ({ docs, kind }) => this.fill(docs, kind, year),
        });
    }

    private fill(docs: DmsDocument[], kind: 'builtin' | 'paperless', year: number): void {
        const sorted = [...docs].sort((a, b) => ((a.created ?? '') < (b.created ?? '') ? 1 : -1));
        this.docs = sorted;
        this.fillSummary(sorted, kind, year);
        this.fillList(sorted);
        if (process.env.STEUER_APP_DEBUG) console.error(`[app] Belege ${year} ok: ${docs.length} (${kind})`);
    }

    private fillSummary(docs: DmsDocument[], kind: 'builtin' | 'paperless', year: number): void {
        this.summary.clear();
        this._summary_group.set_title(fmt(_('Receipts {year}'), { year }));
        const linked = docs.filter((d) => d.linkedTxIds.length > 0).length;
        const row = new Adw.ActionRow({
            title: fmt(_n('{n} receipt', '{n} receipts', docs.length), { n: docs.length }),
            subtitle: `${DMS_LABEL[kind] ?? humanizeKey(kind)} · ${fmt(_('{n} linked to a transaction'), { n: linked })}`,
        });

        // The way IN. There was no file upload anywhere in the desktop tree, so this list could
        // only ever review what the web UI or a file manager had put there — in an app whose
        // central promise is linking receipts to bookings.
        //
        // Paperless has its own ingestion (mail rules, consume folder) and no store() in this
        // provider, so offering the button there would only ever produce an error.
        if (kind === 'builtin') {
            const add = new Gtk.Button({ label: _('Add receipt'), valign: Gtk.Align.CENTER });
            add.add_css_class('suggested-action');
            add.connect('clicked', () => void this.onAddReceipts());
            row.add_suffix(add);
        }
        this.summary.add(row);
    }

    /** Open the metadata editor for one document; reload when it saved. */
    private onEditDocument(doc: DmsDocument): void {
        const entity = this.entity;
        if (!entity) return;
        const dialog = new BhBelegMetadatenDialog(doc, entity, this.docs.map(prefillRecordOf), (message, changed) => {
            showToast(message);
            if (!changed) return;
            // The amounts and the date are what the EÜR joins on, so the shared aggregate is stale.
            appSession().invalidate(entity.id, this.year);
            this.reload(entity, this.year);
        });
        dialog.present(this);
    }

    /** Pick receipts, store them, report what failed by name, then reload the list. */
    private async onAddReceipts(): Promise<void> {
        const entity = this.entity;
        const root = this.get_root() as Gtk.Window | null;
        if (!entity || !root) return;

        const outcome = await pickAndStoreReceipts(root, entity, this.year);
        if (!outcome) return; // cancelled

        showToast(summarizeUpload(outcome));
        presentUploadFailures(this, outcome);
        if (outcome.stored > 0) {
            // New documents change the EÜR join, not just this list.
            appSession().invalidate(entity.id, this.year);
            this.reload(entity, this.year);
        }
    }

    private fillList(docs: DmsDocument[]): void {
        this.list.clear();
        const shown = docs.slice(0, MAX_ROWS);
        this._list_group.set_description(
            docs.length > shown.length
                ? fmt(_('{shown} of {total} shown'), { shown: shown.length, total: docs.length })
                : fmt(_('{total} total'), { total: docs.length }),
        );
        if (shown.length === 0) {
            this.list.add(
                emptyState({
                    icon: 'document-open-symbolic',
                    title: _('No receipts this year'),
                    description: _(
                        'Invoices and receipts belong here — they are what input VAT and ' +
                            'business expenses are read from.',
                    ),
                    action: { label: _('Add receipts'), run: () => void this.onAddReceipts() },
                }),
            );
            return;
        }
        for (const d of shown) this.list.add(this.buildRow(d));

        // STEUER_APP_EDIT_DOC=1 (dev/testing hook): open the metadata editor on the first document,
        // so the form can be captured. An Adw.Dialog renders inside the window and shows up in the
        // devtools screenshot — unlike a popover.
        if (process.env.STEUER_APP_EDIT_DOC === '1' && shown[0]) this.onEditDocument(shown[0]);
    }

    private buildRow(d: DmsDocument): Adw.ActionRow {
        const linked =
            d.linkedTxIds.length > 0
                ? `⇄ ${fmt(_n('{n} transaction', '{n} transactions', d.linkedTxIds.length), { n: d.linkedTxIds.length })}`
                : _('no transaction');
        const sub = [
            d.correspondent,
            d.created ? deDate(d.created) : null,
            d.invoiceNumber ? fmt(_('No. {number}'), { number: d.invoiceNumber }) : null,
            rechnungsartLabel(d),
            d.ruleOrigin ? fmt(_('via rule {rule}'), { rule: d.ruleOrigin.label }) : null,
            linked,
        ].filter(Boolean);
        const row = new Adw.ActionRow({
            title: markup(d.title?.trim() || _('(untitled)')),
            subtitle: markup(sub.join(' · ')),
        });
        row.add_prefix(new Gtk.Image({ iconName: 'mail-attachment-symbolic' }));
        const amount = d.gross ?? d.net;
        if (amount != null) row.add_suffix(amountLabel(eur(amount)));

        // Editing by hand is the KI-free path: without a model, everything past the filename —
        // amounts, date, correspondent, invoice number — is simply absent, and the EÜR joins on
        // exactly those fields. Paperless has its own editor and no setMetadata here.
        if (d.dms === 'builtin') {
            row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic' }));
            row.set_activatable(true);
            row.connect('activated', () => this.onEditDocument(d));
        }
        return row;
    }
}
