/**
 * <BhBelegLinkDialog> — attach a receipt to an unlinked expense from the "Offene Belege" worklist.
 *
 * Given one gap booking (a Vorsteuer expense with no linked invoice) it presents the heuristically
 * ranked candidate documents (core scorer → data/link-candidates), each row showing amount · date ·
 * correspondent, the German match reasons and a confidence badge. Tapping a candidate writes the link
 * through the entity's DMS provider (the field the reconciliation reads), toasts, closes, and asks the
 * caller to reload so the booking leaves "offen". Errors surface in an errorDialog; nothing crashes.
 *
 * An Adw.Dialog with the shared loading/error/content Stack idiom (mirrors the invoice detail dialog).
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import { loadLinkCandidates, linkDocument, searchDocuments, type LinkCandidate } from '../data/link-candidates.ts';
import type { DmsDocument } from '../../../core/presenters/belege.ts';
import type { BelegGapRow } from '../../../core/presenters/belege.ts';
import type { AppEntity } from '../entities.ts';
import { deDate, eur } from '../../../core/lib/format.ts';
import { errorDialog } from './dialogs.ts';
import { showToast } from '../toast.ts';
import { LoadToken, amountLabel, loadIntoStack, markup } from './util.ts';
import { _, fmt } from '../i18n.ts';

/** A small confidence badge: percent + a colour class by band (strong / plausible / weak). */
export function scoreBadge(score: number): Gtk.Label {
    const pct = Math.round(score * 100);
    const css = score >= 0.66 ? 'success' : score >= 0.4 ? 'accent' : 'warning';
    return new Gtk.Label({ label: `${pct} %`, cssClasses: ['caption', css], valign: Gtk.Align.CENTER });
}

export class BhBelegLinkDialog {
    private readonly dialog = new Adw.Dialog();
    private readonly stack = new Gtk.Stack();
    private readonly errorPage = new Adw.StatusPage({
        iconName: 'dialog-error-symbolic',
        title: _('Could not load'),
    });
    private readonly token = new LoadToken();
    private entity!: AppEntity;
    private row!: BelegGapRow;
    private searchRows: Adw.ActionRow[] = [];
    /** Called after a successful link so the worklist reloads (the item leaves "offen"). */
    onLinked: (() => void) | null = null;
    /** The free-text search group, rebuilt on every query. Null before the first content build. */
    private searchGroup: Adw.PreferencesGroup | null = null;
    private searchToken = 0;

    constructor() {
        this.dialog.set_title(_('Link receipt'));
        this.dialog.set_content_width(560);
        this.dialog.set_content_height(600);

        const loading = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            spacing: 12,
        });
        loading.append(new Adw.Spinner({ widthRequest: 32, heightRequest: 32 }));
        loading.append(new Gtk.Label({ label: _('Looking for matching receipts …'), cssClasses: ['dim-label'] }));
        this.stack.add_named(loading, 'loading');
        this.stack.add_named(this.errorPage, 'error');

        const header = new Adw.HeaderBar();
        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(header);
        toolbar.set_content(this.stack);
        this.dialog.set_child(toolbar);
    }

    /** Present the picker for one gap booking on `parent` and load its candidates. */
    open(parent: Gtk.Widget, entity: AppEntity, row: BelegGapRow): void {
        this.entity = entity;
        this.row = row;
        this.dialog.present(parent);
        this.reload();
    }

    private reload(): void {
        loadIntoStack({
            stack: this.stack,
            errorPage: this.errorPage,
            token: this.token,
            errorContext: _('Could not determine receipt candidates'),
            load: () => loadLinkCandidates(this.entity, { transactionId: this.row.id }),
            fill: (cands) => {
                const content = this.buildContent(cands);
                const existing = this.stack.get_child_by_name('content');
                if (existing) this.stack.remove(existing);
                this.stack.add_named(content, 'content');
            },
        });
    }

    /** Scrollable body: the booking being covered, then the ranked candidate receipts. */
    private buildContent(cands: LinkCandidate[]): Gtk.Widget {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 18 });
        box.append(this.bookingGroup());
        box.append(this.candidatesGroup(cands));
        this.searchGroup = new Adw.PreferencesGroup({
            title: _('Find another receipt'),
            description: _(
                'The suggestions above come from ±92 days around the transaction. Here any ' +
                    'unlinked receipt can be found — by title, correspondent, invoice number or full text.',
            ),
        });
        this.searchGroup.add(this.searchRow());
        box.append(this.searchGroup);
        const clamp = new Adw.Clamp({
            maximumSize: 900,
            marginTop: 18,
            marginBottom: 18,
            marginStart: 12,
            marginEnd: 12,
            child: box,
        });
        return new Gtk.ScrolledWindow({ hscrollbarPolicy: Gtk.PolicyType.NEVER, vexpand: true, child: clamp });
    }

    /** The expense we are attaching a receipt to (read-only summary). */
    private bookingGroup(): Adw.PreferencesGroup {
        const r = this.row;
        const group = new Adw.PreferencesGroup({ title: _('Transaction without receipt') });
        const sub = [deDate(r.bookingDate), fmt(_('net {amount}'), { amount: eur(Math.abs(r.net)) })];
        if (r.purpose && r.counterparty) sub.push(r.purpose.trim());
        const row = new Adw.ActionRow({
            title: markup(r.counterparty?.trim() || r.purpose?.trim() || '—'),
            subtitle: markup(sub.join('  ·  ')),
        });
        row.add_suffix(amountLabel(eur(Math.abs(r.vat)), { accent: 'error' }));
        group.add(row);
        return group;
    }

    /** The ranked candidate receipts (or a hint when none match). */
    private candidatesGroup(cands: LinkCandidate[]): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({
            title: _('Matching receipts'),
            description: _('Tap to link the receipt to this transaction.'),
        });
        if (cands.length === 0) {
            group.add(
                new Adw.ActionRow({
                    title: _('No matching receipt found'),
                    subtitle: _('No unlinked receipt matches amount, date and correspondent.'),
                    cssClasses: ['dim-label'],
                }),
            );
            return group;
        }
        for (const c of cands) group.add(this.candidateRow(c));
        return group;
    }

    /**
     * The free-text escape hatch.
     *
     * The ranked list above is a heuristic over a ±92-day window; when it comes up empty the user
     * is the one who knows which receipt it is, and until now had no way to say so. Results are
     * rebuilt per keystroke behind a token, so a slow provider (Paperless) cannot let an older
     * query overwrite a newer one's results.
     */
    private searchRow(): Adw.EntryRow {
        const entry = new Adw.EntryRow({ title: _('Search …') });
        entry.connect('changed', () => {
            const query = (entry.get_text() ?? '').trim();
            const token = ++this.searchToken;
            this.clearSearchResults();
            if (query.length < 2) return; // one character matches nearly everything
            void searchDocuments(this.entity, query)
                .then((docs) => {
                    if (token !== this.searchToken) return; // a newer query already ran
                    this.showSearchResults(docs);
                })
                .catch((err) => {
                    if (token !== this.searchToken) return;
                    this.showSearchError(err instanceof Error ? err.message : String(err));
                });
        });
        return entry;
    }

    /** Drop every row of the search group except the entry itself. */
    private clearSearchResults(): void {
        const group = this.searchGroup;
        if (!group) return;
        for (const row of this.searchRows) group.remove(row);
        this.searchRows = [];
    }

    private showSearchResults(docs: DmsDocument[]): void {
        const group = this.searchGroup;
        if (!group) return;
        if (docs.length === 0) {
            this.addSearchRow(
                new Adw.ActionRow({
                    title: _('No unlinked receipt found'),
                    subtitle: _('Receipts already attached to a transaction are not shown.'),
                    cssClasses: ['dim-label'],
                }),
            );
            return;
        }
        for (const d of docs.slice(0, 12)) this.addSearchRow(this.searchResultRow(d));
    }

    private showSearchError(message: string): void {
        this.addSearchRow(
            new Adw.ActionRow({ title: _('Search failed'), subtitle: markup(message), cssClasses: ['dim-label'] }),
        );
    }

    private addSearchRow(row: Adw.ActionRow): void {
        this.searchGroup?.add(row);
        this.searchRows.push(row);
    }

    /** One search hit. No confidence badge — this is the user's judgement, not the heuristic's. */
    private searchResultRow(d: DmsDocument): Adw.ActionRow {
        const sub = [
            d.correspondent,
            d.created ? deDate(d.created) : null,
            d.invoiceNumber ? fmt(_('No. {number}'), { number: d.invoiceNumber }) : null,
        ]
            .filter(Boolean)
            .join('  ·  ');
        const row = new Adw.ActionRow({
            title: markup(d.title?.trim() || fmt(_('Receipt #{id}'), { id: d.id })),
            subtitle: markup(sub),
        });
        const amount = d.gross ?? d.net;
        if (amount != null) row.add_suffix(amountLabel(eur(amount)));
        row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
        row.set_activatable(true);
        row.connect('activated', () => void this.commitDocument(d.id));
        return row;
    }

    /** One candidate: correspondent/title · date · reasons, with amount + a confidence badge. Tap → link. */
    private candidateRow(c: LinkCandidate): Adw.ActionRow {
        const subParts = [deDate(c.date), ...c.reasons];
        const row = new Adw.ActionRow({
            title: markup(
                c.title?.trim() || c.counterparty?.trim() || fmt(_('Receipt #{id}'), { id: String(c.documentId) }),
            ),
            subtitle: markup(subParts.join('  ·  ')),
        });
        row.set_subtitle_lines(0);
        row.add_suffix(scoreBadge(c.score));
        row.add_suffix(amountLabel(eur(c.amount)));
        row.set_activatable(true);
        row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
        row.connect('activated', () => void this.commit(c));
        return row;
    }

    /** Write the link, toast, close and let the worklist reload. Never crashes the app. */
    private async commit(c: LinkCandidate): Promise<void> {
        if (!c.documentId) return;
        await this.commitDocument(c.documentId);
    }

    /** The one write path, shared by the ranked candidates and the search results. */
    private async commitDocument(documentId: string): Promise<void> {
        try {
            await linkDocument(this.entity, documentId, this.row.id);
            showToast(_('Receipt linked'));
            this.dialog.close();
            this.onLinked?.();
        } catch (err) {
            await errorDialog(this.dialog, _('Linking failed'), err instanceof Error ? err.message : String(err));
        }
    }
}
