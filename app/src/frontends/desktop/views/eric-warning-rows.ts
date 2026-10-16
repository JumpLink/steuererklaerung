/**
 * Rows that say an ERiC may be too old for what is about to be sent. They are hints: nothing here
 * blocks a send, ELSTER and ERiC decide that. An official build points at the app update (it
 * carries ERiC), a self-provided runtime at ELSTER's download page.
 */

import Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';

import { ERIC_DOWNLOAD_URL, ericWarningText, type EricWarning } from '../../../core/actions/elster/eric-warnings.ts';
import { _ } from '../i18n.ts';
import { markup } from './util.ts';

/** The text of one warning, with where to get a current ERiC. */
export function ericWarningMessage(w: EricWarning, bundled: boolean): string {
    return bundled ? `${ericWarningText(w)} ${_('Update the app to get the current ERiC.')}` : ericWarningText(w);
}

/** One warning row for a preferences group. */
export function ericWarningRow(w: EricWarning, bundled: boolean): Adw.ActionRow {
    const row = new Adw.ActionRow({
        title: w.kind === 'outdated' ? _('ERiC is out of date') : _('Check plugin missing'),
        subtitle: markup(ericWarningMessage(w, bundled)),
    });
    row.set_subtitle_lines(0);
    row.add_prefix(
        new Gtk.Image({ iconName: 'dialog-warning-symbolic', cssClasses: ['warning'], valign: Gtk.Align.CENTER }),
    );
    if (!bundled) {
        row.add_suffix(new Gtk.LinkButton({ uri: ERIC_DOWNLOAD_URL, label: 'elster.de', valign: Gtk.Align.CENTER }));
    }
    return row;
}
