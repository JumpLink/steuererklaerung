/**
 * <BhOffeneBelegeView> — the Offene Belege view.
 *
 * Mirrors the web "Offene Belege" (bh-belege-view): the audit-relevant gap — expenses that claim
 * Vorsteuer but have no linked invoice — grouped by month, with the Vorsteuer at stake highlighted.
 * A reassuring all-clear when there's nothing open. Loaded async off the aggregate + DMS docs
 * (see data/offene-belege.ts).
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import GObject from '@girs/gobject-2.0';

import Template from './offene-belege-view.blp';
import { loadOffeneBelege, type BelegGapRow, type OffeneBelegeData } from '../../../core/presenters/belege.ts';
import { appSession } from '../data/session.ts';
import { runAutoLink, undoAutoLink } from '../data/beleg-review.ts';
import type { AppEntity } from '../entities.ts';
import { deDate, eur } from '../../../core/lib/format.ts';
import { LoadToken, MONTHS, amountLabel, loadIntoStack, markup } from './util.ts';
import { BhBelegLinkDialog } from './beleg-link-dialog.ts';
import { confirmDialog, errorDialog } from './dialogs.ts';
import { showToast, showUndoToast } from '../toast.ts';

export class BhOffeneBelegeView extends Adw.Bin {
    declare private _stack: Gtk.Stack;
    declare private _error_page: Adw.StatusPage;
    declare private _gap_banner: Adw.Banner;
    declare private _months_box: Gtk.Box;

    static {
        GObject.registerClass(
            {
                GTypeName: 'BhOffeneBelegeView',
                Template,
                InternalChildren: ['stack', 'error_page', 'gap_banner', 'months_box'],
            },
            this,
        );
    }

    private readonly token = new LoadToken();
    /** Kept so a candidate link can reload the worklist for the same entity/year. */
    private entity?: AppEntity;
    private year = 0;
    /** The current gap bookings — what "Automatisch zuordnen" tries to resolve. */
    private gapTxIds: string[] = [];
    private autoLinkBusy = false;

    constructor() {
        super();
        this._gap_banner.set_button_label('Automatisch zuordnen');
        this._gap_banner.connect('button-clicked', () => void this.autoLink());
    }

    reload(entity: AppEntity, year: number): void {
        this.entity = entity;
        this.year = year;
        loadIntoStack({
            stack: this._stack,
            errorPage: this._error_page,
            token: this.token,
            errorContext: 'Offene Belege konnten nicht ermittelt werden',
            load: () => loadOffeneBelege(appSession(), entity, year),
            fill: (data) => this.fill(data, year),
        });
    }

    private fill(data: OffeneBelegeData, year: number): void {
        if (data.totalCount > 0) {
            this._gap_banner.set_title(
                `${data.totalCount} Buchung${data.totalCount === 1 ? '' : 'en'} mit Vorsteuer ohne Beleg · ` +
                    `${eur(data.totalVat)} betroffen`,
            );
            this._gap_banner.set_revealed(true);
        } else {
            this._gap_banner.set_revealed(false);
        }

        this.gapTxIds = data.months.flatMap((m) => m.rows.map((r) => r.id));
        this.clearMonths();
        if (data.months.length === 0) {
            this._months_box.append(this.allClearGroup(year));
        } else {
            for (const m of data.months) this._months_box.append(this.monthGroup(m, year));
        }
        // Counts only — never a euro figure (privacy: no financial figures in logs).
        if (process.env.STEUER_APP_DEBUG) console.error(`[app] Offene Belege ${year} ok: ${data.totalCount} offen`);
        // STEUER_APP_LINK_DIALOG=1 (dev/testing hook): open the picker on the first gap booking, so
        // the dialog can be captured. An Adw.Dialog renders inside the window and shows up in the
        // devtools screenshot.
        if (process.env.STEUER_APP_LINK_DIALOG === '1') {
            const first = data.months.flatMap((m) => m.rows)[0];
            if (first) this.openLinkDialog(first);
        }
    }

    private allClearGroup(year: number): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup();
        const row = new Adw.ActionRow({
            title: 'Keine fehlenden Belege',
            subtitle: `Alle Vorsteuer-Ausgaben in ${year} sind mit einem Beleg verknüpft.`,
        });
        row.add_prefix(new Gtk.Image({ iconName: 'object-select-symbolic', cssClasses: ['success'] }));
        group.add(row);
        return group;
    }

    private monthGroup(m: { month: number; rows: BelegGapRow[]; vat: number }, year: number): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({
            title: `${MONTHS[m.month] ?? m.month} ${year}`,
            description: `${m.rows.length} offen · ${eur(m.vat)} Vorsteuer`,
        });
        for (const r of m.rows) group.add(this.buildRow(r));
        return group;
    }

    /**
     * One gap row: counterparty/purpose + date·netto, with the Vorsteuer at stake as suffix.
     * ACTIVATABLE — tapping it opens the "Verknüpfen" picker to attach the receipt this expense
     * is missing; on a successful link the worklist reloads and the item leaves "offen".
     */
    private buildRow(r: BelegGapRow): Adw.ActionRow {
        const sub = [deDate(r.bookingDate), `netto ${eur(Math.abs(r.net))}`];
        if (r.purpose && r.counterparty) sub.push(r.purpose.trim());
        const row = new Adw.ActionRow({
            title: markup(r.counterparty?.trim() || r.purpose?.trim() || '—'),
            subtitle: markup(sub.join('  ·  ')),
        });
        row.add_suffix(amountLabel(eur(Math.abs(r.vat)), { accent: 'error' }));
        row.set_activatable(true);
        row.set_tooltip_text('Beleg verknüpfen');
        row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
        row.connect('activated', () => this.openLinkDialog(r));
        return row;
    }

    /**
     * "Automatisch zuordnen": dry-run first (plan the unambiguous hits — pickBestMatch's rule, one
     * receipt backs one booking), show the plan for confirmation, then execute exactly it and reload.
     * Ambiguous/unmatched bookings stay for the per-row manual picker.
     */
    private async autoLink(): Promise<void> {
        if (!this.entity || this.autoLinkBusy || this.gapTxIds.length === 0) return;
        const entity = this.entity;
        const year = this.year;
        // Snapshot the worklist NOW — a reload during the dry-run/dialog awaits must not let the
        // execute run against a different set than the one previewed.
        const txIds = [...this.gapTxIds];
        this.autoLinkBusy = true;
        try {
            showToast('Suche eindeutige Treffer …');
            const plan = await runAutoLink(entity, txIds, true);
            if (plan.planned.length === 0) {
                showToast('Keine eindeutigen Treffer — bitte manuell zuordnen.');
                return;
            }
            const rest = plan.ambiguous.length + plan.unmatched.length;
            const pairs = plan.planned
                .slice(0, 6)
                .map(
                    (p) =>
                        `• ${deDate(p.bookingDate)} ${p.counterparty ?? '—'} ⇄ ${p.docTitle ?? p.docCorrespondent ?? p.documentId}`,
                )
                .join('\n');
            const more = plan.planned.length > 6 ? `\n… und ${plan.planned.length - 6} weitere` : '';
            const ok = await confirmDialog(this, {
                heading: 'Automatisch zuordnen',
                body:
                    `${plan.planned.length} eindeutige${plan.planned.length === 1 ? 'r' : ''} Treffer ` +
                    `${plan.planned.length === 1 ? 'wird' : 'werden'} verknüpft:\n\n${pairs}${more}` +
                    (rest > 0
                        ? `\n\n${rest} Buchung${rest === 1 ? '' : 'en'} bleib${rest === 1 ? 't' : 'en'} zur Handprüfung.`
                        : ''),
                confirmLabel: 'Verknüpfen',
            });
            if (!ok) return;
            const result = await runAutoLink(entity, txIds, false);
            if (result.errors.length > 0) {
                await errorDialog(
                    this,
                    'Nicht alle Verknüpfungen gelangen',
                    result.errors.map((e) => e.message).join('\n'),
                );
            }
            const writtenPairs = result.planned.filter(
                (p) => !result.errors.some((e) => e.txId === p.txId && e.documentId === p.documentId),
            );
            showUndoToast(`${result.linked} Beleg${result.linked === 1 ? '' : 'e'} verknüpft`, () => {
                void (async () => {
                    const failed = await undoAutoLink(entity, writtenPairs);
                    if (failed.length > 0) {
                        await errorDialog(this, 'Rückgängig unvollständig', failed.map((f) => f.message).join('\n'));
                    } else {
                        showToast('Rückgängig gemacht');
                    }
                    // Reload only when the view still shows this entity/year — otherwise the
                    // cache drop in undoAutoLink is enough and the current view state stands.
                    if (this.entity?.id === entity.id && this.year === year) this.reload(entity, year);
                })();
            });
            if (this.entity?.id === entity.id && this.year === year) this.reload(entity, year);
        } catch (err) {
            await errorDialog(this, 'Abgleich fehlgeschlagen', err instanceof Error ? err.message : String(err));
        } finally {
            this.autoLinkBusy = false;
        }
    }

    /** Open the candidate picker for one gap booking; reload the worklist after a successful link. */
    private openLinkDialog(r: BelegGapRow): void {
        if (!this.entity) return;
        const entity = this.entity;
        const year = this.year;
        const dialog = new BhBelegLinkDialog();
        dialog.onLinked = () => this.reload(entity, year);
        dialog.open(this, entity, r);
    }

    private clearMonths(): void {
        let child = this._months_box.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._months_box.remove(child);
            child = next;
        }
    }
}
