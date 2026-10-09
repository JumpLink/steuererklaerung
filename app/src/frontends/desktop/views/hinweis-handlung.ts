/**
 * What a Hinweis looks like and does in the native app — shared by the Auswertungen „Einblicke" cards
 * and the Übersicht „Als Nächstes" list, so both open the same dialogs for the same action.
 *
 * The core describes an action frontend-agnostically ({@link HinweisZiel}: a view, a dialog for one
 * subject, or the „in Ordnung" core action); this module maps it onto the app's navigation and the
 * dialogs that already exist — the booking sheet, the Beleg picker, Umbuchen with „Als Regel merken",
 * the invoice detail, the import dialog and the pre-filled „Wirtschaftsgut erfassen". A hint never changes anything by itself: every write is
 * the click on one of these.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import Pango from '@girs/pango-1.0';

import type {
    HinweisAnsicht,
    HinweisBetroffen,
    HinweisHandlung,
    HinweisStatus,
} from '../../../core/elster/hinweise.ts';
import type { YearHinweis } from '../../../core/presenters/hinweise.ts';
import { markHinweisInOrdnung } from '../../../core/presenters/hinweise.ts';
import { loadEnrichedTransactions, type EnrichedTxRow } from '../../../core/presenters/buchungen.ts';
import { loadCapabilities, loadOutgoingInvoices } from '../../../core/presenters/rechnungen.ts';
import { appSession } from '../data/session.ts';
import { loadDms } from '../data/settings.ts';
import { navigateTo, type NavViewId } from '../nav.ts';
import { showToast } from '../toast.ts';
import type { AppEntity } from '../entities.ts';
import { BhTxDetailDialog } from './tx-detail-dialog.ts';
import { BhBelegLinkDialog } from './beleg-link-dialog.ts';
import { BhUmbuchenDialog } from './umbuchen-dialog.ts';
import { BhRechnungDetailDialog } from './rechnung-detail-dialog.ts';
import { BhAddAccountDialog } from './konto-hinzufuegen-dialog.ts';
import { BhBelegMetadatenDialog } from './beleg-metadaten-dialog.ts';
import { openAnlagegutErfassen } from './anlagen-view.ts';
import { loadDocuments } from '../../../core/presenters/belege.ts';
import { prefillRecordOf } from '../../../core/invoices/e-rechnung/index.ts';
import { errorDialog } from './dialogs.ts';
import { BhGlossaryHelp } from '../widgets/glossary-help.ts';
import { loadAppSettings } from '../../../core/config/index.ts';
import { markup } from './util.ts';

/** The entity-year a hint belongs to, and what to do once an action changed something. */
export interface HinweisKontext {
    entity: AppEntity;
    year: number;
    onChanged: () => void;
}

/** Affected rows a card shows; the rest is a count — the full list is one click away (the action). */
const ZEILEN_MAX = 5;

const ANSICHT: Record<HinweisAnsicht, { view: NavViewId; tab?: string }> = {
    buchungen: { view: 'transactions' },
    'beleg-eingang': { view: 'review' },
    konten: { view: 'konten' },
    rechnungen: { view: 'rechnungen' },
    anlagen: { view: 'steuer', tab: 'anlagen' },
};

/** The line under a hint that says what the check did when it found nothing (or could not run). */
export function statusZeile(h: { status?: HinweisStatus; geprueft?: string; weil?: string }): string | null {
    if (h.status === 'ohne_befund') return `Geprüft, ohne Befund${h.geprueft ? `: ${h.geprueft}` : ''}`;
    if (h.status === 'nicht_pruefbar') return `Nicht prüfbar${h.weil ? `, weil ${h.weil}` : ''}`;
    return null;
}

/** One booking of the entity-year as the booking sheet needs it. */
async function findTx(ctx: HinweisKontext, id: string): Promise<EnrichedTxRow> {
    const { rows } = await loadEnrichedTransactions(appSession(), ctx.entity, ctx.year);
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error('Die Buchung wurde in diesem Jahr nicht gefunden.');
    return row;
}

function changed(ctx: HinweisKontext): () => void {
    return () => {
        // Every action here changes what the EÜR or the Hinweise are computed from.
        appSession().invalidate(ctx.entity.id, ctx.year);
        ctx.onChanged();
    };
}

async function openTx(parent: Gtk.Widget, ctx: HinweisKontext, id: string): Promise<void> {
    const row = await findTx(ctx, id);
    let paperlessBase: string | null = null;
    try {
        paperlessBase = loadDms(ctx.entity).paperlessUrl ?? null;
    } catch {
        paperlessBase = null;
    }
    new BhTxDetailDialog().open(parent, row, paperlessBase, {
        entity: ctx.entity,
        year: ctx.year,
        onChanged: changed(ctx),
    });
}

async function openInvoice(parent: Gtk.Widget, ctx: HinweisKontext, id: string): Promise<void> {
    const invoice = (await loadOutgoingInvoices(ctx.entity.id)).find((i) => i.id === id);
    if (!invoice) throw new Error('Die Rechnung wurde nicht gefunden.');
    const dialog = new BhRechnungDetailDialog();
    dialog.onChanged = changed(ctx);
    dialog.open(parent, ctx.entity, invoice, loadCapabilities(ctx.entity.id));
}

/** One document of the entity-year in its metadata editor — the Beleg's own detail in the app. */
async function openBeleg(parent: Gtk.Widget, ctx: HinweisKontext, id: string): Promise<void> {
    const { docs } = await loadDocuments(appSession(), ctx.entity, ctx.year);
    const doc = docs.find((d) => d.id === id);
    if (!doc) throw new Error('Der Beleg wurde in diesem Jahr nicht gefunden.');
    const done = changed(ctx);
    new BhBelegMetadatenDialog(doc, ctx.entity, docs.map(prefillRecordOf), (message, didChange) => {
        showToast(message);
        if (didChange) done();
    }).present(parent);
}

async function dispatch(
    parent: Gtk.Widget,
    ctx: HinweisKontext,
    key: string,
    handlung: HinweisHandlung,
): Promise<void> {
    const target = handlung.target;
    if (target.art === 'ansicht') {
        const ziel = ANSICHT[target.ansicht];
        // Forderungen are a tab of the Rechnungen hub, not the invoice list itself.
        navigateTo(parent, ziel.view, target.filter === 'forderungen' ? 'forderungen' : ziel.tab);
        return;
    }
    if (target.art === 'aktion') {
        await markHinweisInOrdnung(appSession(), ctx.entity, ctx.year, key);
        showToast('Als in Ordnung markiert');
        ctx.onChanged();
        return;
    }
    const ref = target.ref ?? '';
    switch (target.dialog) {
        case 'buchung':
            await openTx(parent, ctx, ref);
            return;
        case 'beleg':
            await openBeleg(parent, ctx, ref);
            return;
        case 'beleg-zuordnen': {
            const r = await findTx(ctx, ref);
            const dialog = new BhBelegLinkDialog();
            dialog.onLinked = changed(ctx);
            dialog.open(parent, ctx.entity, {
                id: r.id,
                bookingDate: r.bookingDate,
                counterparty: r.counterparty,
                purpose: r.purpose,
                net: r.net,
                vat: r.vat,
            });
            return;
        }
        case 'regel-anlegen': {
            const r = await findTx(ctx, ref);
            const done = changed(ctx);
            new BhUmbuchenDialog(
                ctx.entity,
                ctx.year,
                {
                    transactionId: r.id,
                    category: r.category,
                    source: r.source,
                    counterparty: r.counterparty,
                    purpose: r.purpose,
                    note: r.note,
                },
                (message, didChange) => {
                    showToast(message);
                    if (didChange) done();
                },
            ).present(parent);
            return;
        }
        case 'rechnung':
            await openInvoice(parent, ctx, ref);
            return;
        case 'kontoauszug-import': {
            const done = changed(ctx);
            const dialog = new BhAddAccountDialog((message, didChange) => {
                showToast(message);
                if (didChange) {
                    appSession().invalidate();
                    done();
                }
            });
            dialog.openPage('file');
            dialog.present(parent);
            return;
        }
        case 'anlagegut-erfassen': {
            const done = changed(ctx);
            openAnlagegutErfassen(parent, ctx.entity, target.vorbelegung, () => done());
            return;
        }
    }
}

/** Run one action of hint `key`; a failure lands in an error dialog, never in a crash. */
export function runHinweisHandlung(
    parent: Gtk.Widget,
    ctx: HinweisKontext,
    key: string,
    handlung: HinweisHandlung,
): void {
    dispatch(parent, ctx, key, handlung).catch((err: unknown) =>
        errorDialog(parent, handlung.label, err instanceof Error ? err.message : String(err)),
    );
}

/** Open one affected booking, invoice or Beleg. */
function openBetroffen(parent: Gtk.Widget, ctx: HinweisKontext, b: HinweisBetroffen): void {
    const run =
        b.art === 'rechnung'
            ? openInvoice(parent, ctx, b.id)
            : b.art === 'beleg'
              ? openBeleg(parent, ctx, b.id)
              : openTx(parent, ctx, b.id);
    run.catch((err: unknown) => errorDialog(parent, 'Nicht ladbar', err instanceof Error ? err.message : String(err)));
}

/**
 * The part of a hint card below its text: the „ohne Befund" / „nicht prüfbar" line, the affected
 * bookings as activatable rows, and one button per action.
 */
export function hinweisDetails(parent: Gtk.Widget, ctx: HinweisKontext, h: YearHinweis): Gtk.Widget | null {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    // STEUER_APP_LERNMODUS (dev/testing hook) forces the "?" on, like the Übersicht.
    const lernmodus = !!process.env.STEUER_APP_LERNMODUS || loadAppSettings().lernmodus;
    // The term a hint is named after gets its "?" (only shown in Lernmodus, like everywhere else).
    if (h.begriff && lernmodus) {
        const line = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4, halign: Gtk.Align.START });
        line.append(new Gtk.Label({ label: 'Was heißt das?', cssClasses: ['caption', 'dim-label'] }));
        line.append(new BhGlossaryHelp(h.begriff, lernmodus));
        box.append(line);
    }
    const zeile = statusZeile(h);
    if (zeile) {
        const line = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4 });
        line.append(
            new Gtk.Label({
                label: markup(zeile),
                useMarkup: true,
                xalign: 0,
                wrap: true,
                hexpand: true,
                cssClasses: ['caption', h.status === 'ohne_befund' ? 'success' : 'dim-label'],
            }),
        );
        line.append(new BhGlossaryHelp('ohne-befund', lernmodus));
        box.append(line);
    }
    if (h.betroffen?.length) {
        const list = new Gtk.ListBox({ selectionMode: Gtk.SelectionMode.NONE, cssClasses: ['boxed-list'] });
        for (const b of h.betroffen.slice(0, ZEILEN_MAX)) {
            const row = new Adw.ActionRow({ title: markup(b.zeile), activatable: true });
            row.set_title_lines(1);
            row.add_prefix(
                new Gtk.Image({
                    iconName:
                        b.art === 'rechnung'
                            ? 'document-send-symbolic'
                            : b.art === 'beleg'
                              ? 'text-x-generic-symbolic'
                              : 'view-list-symbolic',
                    cssClasses: ['dim-label'],
                }),
            );
            row.add_suffix(new Gtk.Image({ iconName: 'go-next-symbolic', cssClasses: ['dim-label'] }));
            row.connect('activated', () => openBetroffen(parent, ctx, b));
            list.append(row);
        }
        box.append(list);
        const weitere = h.betroffen.length - Math.min(h.betroffen.length, ZEILEN_MAX) + (h.betroffenWeitere ?? 0);
        if (weitere > 0) {
            box.append(
                new Gtk.Label({
                    label: `und ${weitere} weitere`,
                    xalign: 0,
                    cssClasses: ['caption', 'dim-label'],
                }),
            );
        }
    }
    if (h.handlungen?.length && !h.erledigt) {
        const buttons = new Gtk.FlowBox({
            selectionMode: Gtk.SelectionMode.NONE,
            columnSpacing: 6,
            rowSpacing: 6,
            maxChildrenPerLine: 3,
            halign: Gtk.Align.START,
        });
        h.handlungen.forEach((a, n) => {
            const button = new Gtk.Button({
                label: a.label,
                tooltipText: `${a.label}: ${h.title}`,
                cssClasses: n === 0 && a.target.art !== 'aktion' ? ['suggested-action', 'pill'] : ['pill'],
            });
            (button.get_child() as Gtk.Label | null)?.set_ellipsize(Pango.EllipsizeMode.END);
            button.connect('clicked', () => runHinweisHandlung(parent, ctx, h.key, a));
            buttons.append(button);
        });
        box.append(buttons);
    }
    return box.get_first_child() ? box : null;
}
