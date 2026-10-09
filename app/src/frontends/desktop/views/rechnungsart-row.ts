/**
 * The "E-Rechnung" / "sonstige Rechnung" badge of an incoming invoice, with its one-line reason.
 *
 * The classification is read from the file itself (core/invoices/e-rechnung), never by AI, so the
 * row can say plainly what it is: a structured data set the app read exactly, or an invoice whose
 * fields still have to come from a person or the AI. Outgoing invoices carry no badge — the
 * distinction is about what the issuer sent US.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import { INVOICE_KIND_LABEL } from '../../../core/invoices/e-rechnung/index.ts';
import type { DmsDocument } from '../../../core/presenters/belege.ts';
import { BhGlossaryHelp, lernmodusOn } from '../widgets/glossary-help.ts';
import { markup } from './util.ts';

/** The badge row for a classified, non-outgoing document; null when there is nothing to say. */
export function rechnungsartRow(
    doc: Pick<DmsDocument, 'invoiceKind' | 'invoiceKindReason' | 'direction'>,
): Adw.ActionRow | null {
    if (!doc.invoiceKind || doc.direction === 'outgoing') return null;
    const eRechnung = doc.invoiceKind === 'e-rechnung';
    const row = new Adw.ActionRow({
        title: INVOICE_KIND_LABEL[doc.invoiceKind],
        subtitle: markup(doc.invoiceKindReason ?? ''),
    });
    row.set_subtitle_lines(0);
    row.add_prefix(
        new Gtk.Image({
            iconName: eRechnung ? 'emblem-ok-symbolic' : 'text-x-generic-symbolic',
            cssClasses: eRechnung ? ['success'] : ['dim-label'],
        }),
    );
    const help = new BhGlossaryHelp(doc.invoiceKind, lernmodusOn());
    if (help.get_visible()) row.add_suffix(help);
    return row;
}

/** Short label for a list row's subtitle, or null. */
export function rechnungsartLabel(doc: Pick<DmsDocument, 'invoiceKind' | 'direction'>): string | null {
    if (!doc.invoiceKind || doc.direction === 'outgoing') return null;
    return INVOICE_KIND_LABEL[doc.invoiceKind];
}
