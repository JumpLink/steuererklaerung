/**
 * The native app's first confirmation / error dialogs, built on Adw.AlertDialog (mirrors the web
 * lib/dialogs.ts). Used by the invoice lifecycle actions (festschreiben, storno) and error
 * surfacing. Kept tiny and promise-based so views can `await` a yes/no.
 */

import Adw from '@girs/adw-1';
import type Gtk from '@girs/gtk-4.0';
import { _ } from '../i18n.ts';

export interface ConfirmOptions {
    heading: string;
    body: string;
    confirmLabel: string;
    cancelLabel?: string;
    /** Style the confirm button as a red destructive action. */
    destructive?: boolean;
}

/** Yes/no confirmation. Resolves true iff the confirm button was chosen. */
export function confirmDialog(parent: Gtk.Widget, opts: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
        const dlg = new Adw.AlertDialog({ heading: opts.heading, body: opts.body });
        dlg.add_response('cancel', opts.cancelLabel ?? _('Cancel'));
        dlg.add_response('confirm', opts.confirmLabel);
        dlg.set_response_appearance(
            'confirm',
            opts.destructive ? Adw.ResponseAppearance.DESTRUCTIVE : Adw.ResponseAppearance.SUGGESTED,
        );
        dlg.set_close_response('cancel');
        dlg.set_default_response('cancel');
        dlg.choose(parent, null, (_src, res) => {
            resolve(dlg.choose_finish(res) === 'confirm');
        });
    });
}

/** A simple error dialog with a single OK button. */
export function errorDialog(parent: Gtk.Widget, heading: string, message: string): Promise<void> {
    return new Promise((resolve) => {
        const dlg = new Adw.AlertDialog({ heading, body: message });
        dlg.add_response('ok', _('OK'));
        dlg.set_default_response('ok');
        dlg.set_close_response('ok');
        dlg.choose(parent, null, () => resolve());
    });
}
