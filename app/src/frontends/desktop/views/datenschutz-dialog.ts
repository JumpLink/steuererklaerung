/**
 * The privacy notice the ERiC licence prescribes before the software is used (§ 5): the short
 * Datenschutzhinweis, the full Datenschutzschreiben of the tax administration (Anhang 2 of the
 * licence, in the `lizenz.pdf` that ships with ERiC), and a confirmation. It also carries the note
 * about ERiC's local log files (§ 15).
 *
 * {@link ensurePrivacyAck} is called right before the first send, test or live. It resolves true
 * at once when this version of the notice was confirmed on this machine, else shows the dialog and
 * records the confirmation.
 */

import Adw from '@girs/adw-1';
import Gio from '@girs/gio-2.0';
import Gtk from '@girs/gtk-4.0';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getEricStatus } from '../../../core/actions/elster/eric-status.ts';
import {
    acknowledgePrivacy,
    backupNoticeText,
    isPrivacyAcknowledged,
    logFileNoticeText,
    privacyNoticeText,
} from '../../../core/actions/elster/privacy-ack.ts';
import { fmt } from '../../../core/lib/i18n.ts';
import { displayPath } from '../../../core/paths.ts';
import { _ } from '../i18n.ts';

/** The official page the same letter is published on (fallback when no `lizenz.pdf` is on disk). */
const ELSTER_DEVELOPER_URL = 'https://www.elster.de/elsterweb/entwickler';

/** True when the notice is (now) confirmed; false when the person cancelled. */
export async function ensurePrivacyAck(parent: Gtk.Widget): Promise<boolean> {
    if (isPrivacyAcknowledged()) return true;
    const status = await getEricStatus();
    const letter = join(status.ericHome, 'lizenz.pdf');
    const hasLetter = existsSync(letter);

    const dlg = new Adw.AlertDialog({
        heading: _('Privacy notice for ELSTER transmissions'),
        body: privacyNoticeText(),
    });
    // The notice is long; AlertDialog scrolls its body, but the extra child sits below it, so keep
    // that part compact.
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 6 });

    const logNote = new Gtk.Label({
        label: fmt(logFileNoticeText(), { path: displayPath(status.logPath) }),
        wrap: true,
        xalign: 0,
        selectable: true,
    });
    logNote.add_css_class('dim-label');
    box.append(logNote);

    const backupNote = new Gtk.Label({ label: backupNoticeText(), wrap: true, xalign: 0 });
    box.append(backupNote);

    const open = new Gtk.Button({
        label: hasLetter ? _('Open the full privacy letter (PDF)') : _('Open the privacy letter on elster.de'),
        halign: Gtk.Align.START,
    });
    open.connect('clicked', () => {
        const root = parent.get_root() as Gtk.Window | null;
        if (hasLetter) {
            new Gtk.FileLauncher({ file: Gio.File.new_for_path(letter) }).launch(root, null, () => {});
        } else {
            new Gtk.UriLauncher({ uri: ELSTER_DEVELOPER_URL }).launch(root, null, () => {});
        }
    });
    box.append(open);

    const check = new Gtk.CheckButton({ label: _('I have read the privacy notice and the privacy letter.') });
    box.append(check);
    dlg.set_extra_child(box);

    dlg.add_response('cancel', _('Cancel'));
    dlg.add_response('confirm', _('Confirm'));
    dlg.set_response_appearance('confirm', Adw.ResponseAppearance.SUGGESTED);
    dlg.set_response_enabled('confirm', false);
    dlg.set_close_response('cancel');
    dlg.set_default_response('cancel');
    check.connect('toggled', () => dlg.set_response_enabled('confirm', check.get_active()));

    return new Promise((resolve) => {
        dlg.choose(parent, null, (_src, res) => {
            const confirmed = dlg.choose_finish(res) === 'confirm';
            if (confirmed) acknowledgePrivacy();
            resolve(confirmed);
        });
    });
}
