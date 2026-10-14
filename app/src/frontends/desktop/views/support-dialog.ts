/**
 * The support prompt shown once per tax year after a successful filing (see `support-prompt.ts` for
 * the rules). An Adw.AlertDialog with two equal-weight answers, "Not now" being the default: it
 * thanks, offers a link and goes away — nothing waits on it and nothing is lost by closing it.
 *
 * The wording stays clear of "donation" and of anything tax-related, by design: support is business
 * income for the maker, not a deductible gift.
 */

import Adw from '@girs/adw-1';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';
import { supportLang, supportUrl } from '../../../core/config/support-prompt.ts';
import { _ } from '../i18n.ts';

/** The support page in the language of the running session. */
export function localizedSupportUrl(): string {
    return supportUrl(supportLang(GLib.get_language_names()));
}

/** Present the prompt over `parent`; resolves once it is closed. Opens the page on "Support". */
export function showSupportPrompt(parent: Gtk.Widget): Promise<void> {
    return new Promise((resolve) => {
        const dlg = new Adw.AlertDialog({
            heading: _('Thank you for using Steuererklärung'),
            body: _(
                'Steuererklärung is built and maintained by one person. If it saved you time this year, ' +
                    'you can support its development — entirely optional, and the app works the same either way.',
            ),
        });
        dlg.add_response('later', _('Not Now'));
        dlg.add_response('support', _('Support'));
        dlg.set_response_appearance('support', Adw.ResponseAppearance.SUGGESTED);
        dlg.set_default_response('later');
        dlg.set_close_response('later');
        dlg.choose(parent, null, (_src, res) => {
            if (dlg.choose_finish(res) === 'support') {
                new Gtk.UriLauncher({ uri: localizedSupportUrl() }).launch(
                    parent.get_root() as Gtk.Window | null,
                    null,
                    () => {},
                );
            }
            resolve();
        });
    });
}
