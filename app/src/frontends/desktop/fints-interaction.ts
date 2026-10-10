/**
 * The window's answer to a bank's questions — the app half of the {@link FinTSInteraction} seam.
 *
 * Before this, the app could add a FinTS bank in "Konto hinzufügen" and then never sync it once:
 * the first TAN challenge blocked on stdin, and the eventual error told the user to run
 * `fints sync --account …` in a terminal. The dialog is the missing half of a flow the app already
 * offered.
 *
 * An `Adw.AlertDialog`, not a modal window: it renders inside the app window (and is therefore
 * visible to the screenshot rig), and its response closes the promise the FinTS session is
 * awaiting. Cancelling REJECTS — an empty TAN sent to the bank would burn one of the user's
 * attempts against a lock counter.
 */

import Adw from '@girs/adw-1';
import Gio from '@girs/gio-2.0';
import Gtk from '@girs/gtk-4.0';

import type { FinTSInteraction, PinRequest, TanRequest } from '../../core/clients/fints/interaction.ts';
import { showToast } from './toast.ts';
import { _, fmt } from './i18n.ts';

/**
 * The window a dialog should attach to — the app's active window, resolved at ask time.
 *
 * `Gio.Application.get_default()` types as the Gio base class, which has no window accessor; the
 * running instance IS a Gtk.Application, so the cast is what the type system is missing, not a
 * guess about the object.
 */
function activeWindow(): Gtk.Window | null {
    const app = Gio.Application.get_default() as Gtk.Application | null;
    return app?.get_active_window() ?? null;
}

/**
 * One question, one answer. Resolves with the entered text, rejects when the user cancels or when
 * there is no window to ask in — never resolves with an empty string, which the bank would count
 * as a wrong TAN.
 */
function ask(opts: { heading: string; body: string; placeholder: string; secret: boolean }): Promise<string> {
    return new Promise((resolve, reject) => {
        const parent = activeWindow();
        if (!parent) {
            reject(new Error(_('No window is open in which the bank could ask.')));
            return;
        }
        const dialog = new Adw.AlertDialog({ heading: opts.heading, body: opts.body });
        const entry = opts.secret
            ? new Gtk.PasswordEntry({ showPeekIcon: true })
            : new Gtk.Entry({ inputPurpose: Gtk.InputPurpose.DIGITS });
        entry.set_margin_top(8);
        entry.set_margin_bottom(8);
        entry.set_margin_start(8);
        entry.set_margin_end(8);
        if (entry instanceof Gtk.Entry) entry.set_placeholder_text(opts.placeholder);
        dialog.set_extra_child(entry);

        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('ok', _('Send'));
        dialog.set_default_response('ok');
        dialog.set_close_response('cancel');
        dialog.set_response_appearance('ok', Adw.ResponseAppearance.SUGGESTED);

        // Enter in the field is the same as pressing Senden — a TAN is typed and confirmed in one go.
        const send = () => dialog.choose(parent, null, null);
        if (entry instanceof Gtk.Entry) entry.connect('activate', send);
        else entry.connect('activate', send);

        dialog.connect('response', (_d: Adw.AlertDialog, response: string) => {
            if (response !== 'ok') {
                reject(new Error(_('Cancelled — the bank received no answer.')));
                return;
            }
            const text = (entry.get_text() ?? '').trim();
            if (text === '') {
                reject(new Error(_('Nothing entered — the bank received no answer.')));
                return;
            }
            resolve(text);
        });
        dialog.present(parent);
    });
}

export const dialogFinTSInteraction: FinTSInteraction = {
    requestTan(request: TanRequest): Promise<string> {
        const method = request.method ? ` (${request.method})` : '';
        return ask({
            heading: fmt(_('TAN for “{account}”{method}'), { account: request.accountName, method }),
            // The bank's own challenge text carries the essentials (amount, recipient, which card),
            // so it is shown verbatim rather than summarised.
            body: request.challenge ?? _('The bank requires a TAN for this access.'),
            placeholder: 'TAN',
            secret: false,
        });
    },
    requestPin(request: PinRequest): Promise<string> {
        return ask({
            heading: fmt(_('PIN for “{account}”'), { account: request.accountName }),
            body: fmt(_('Online banking PIN of bank {blz}. It is used for this session only.'), { blz: request.blz }),
            placeholder: 'PIN',
            secret: true,
        });
    },
    notify(message: string): void {
        // Decoupled confirmation can take minutes; the toast is what keeps the app from looking hung.
        showToast(message, 8);
    },
};
