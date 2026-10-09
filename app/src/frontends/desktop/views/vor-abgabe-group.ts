/**
 * „Vor der Abgabe klären" — the findings to look at before a USt-VA or the annual returns go out
 * (Idee 10), shared by the Absenden section and the USt-VA view.
 *
 * The open double-payment cases come as plain warning lines (their decision lives at the invoice); the
 * Prüfungen vor der Abgabe and the Geld-Prüfungen' warnings come as hint cards with the affected
 * bookings and their actions — the same {@link hinweisDetails} the Einblicke use. A warning, never a
 * block: the submission buttons below stay as they are.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import type { YearHinweis } from '../../../core/presenters/hinweise.ts';
import { hinweisDetails, type HinweisKontext } from './hinweis-handlung.ts';
import { markup } from './util.ts';

const ICON: Record<YearHinweis['level'], { icon: string; css: string }> = {
    warnung: { icon: 'dialog-warning-symbolic', css: 'warning' },
    tipp: { icon: 'starred-symbolic', css: 'accent' },
    info: { icon: 'dialog-information-symbolic', css: 'dim-label' },
};

function hinweisKarte(parent: Gtk.Widget, ctx: HinweisKontext, h: YearHinweis): Gtk.Widget {
    const body = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        marginTop: 12,
        marginBottom: 12,
        marginStart: 14,
        marginEnd: 14,
    });
    const head = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    const meta = ICON[h.level];
    head.append(new Gtk.Image({ iconName: meta.icon, cssClasses: [meta.css], valign: Gtk.Align.START }));
    head.append(
        new Gtk.Label({
            label: markup(h.title),
            useMarkup: true,
            xalign: 0,
            hexpand: true,
            wrap: true,
            cssClasses: ['heading'],
        }),
    );
    if (h.ref)
        head.append(new Gtk.Label({ label: h.ref, cssClasses: ['caption', 'dim-label'], valign: Gtk.Align.START }));
    body.append(head);
    body.append(
        new Gtk.Label({ label: markup(h.text), useMarkup: true, xalign: 0, wrap: true, cssClasses: ['dim-label'] }),
    );
    const details = hinweisDetails(parent, ctx, h);
    if (details) body.append(details);
    const card = new Gtk.Box({ cssClasses: ['card'], marginTop: 6 });
    card.append(body);
    return card;
}

/** The group, or null when there is nothing to clear. */
export function vorAbgabeGroup(
    parent: Gtk.Widget,
    ctx: HinweisKontext,
    hinweise: readonly YearHinweis[],
    warnungen: readonly string[] = [],
): Gtk.Widget | null {
    if (hinweise.length === 0 && warnungen.length === 0) return null;
    const group = new Adw.PreferencesGroup({
        title: 'Vor der Abgabe klären',
        description: 'Hinweise, keine Sperre — geändert wird erst mit einer Handlung.',
    });
    for (const text of warnungen) {
        const row = new Adw.ActionRow({ title: markup(text) });
        row.set_title_lines(0);
        row.add_prefix(
            new Gtk.Image({ iconName: 'dialog-warning-symbolic', cssClasses: ['warning'], valign: Gtk.Align.CENTER }),
        );
        group.add(row);
    }
    for (const h of hinweise) group.add(hinweisKarte(parent, ctx, h));
    return group;
}
