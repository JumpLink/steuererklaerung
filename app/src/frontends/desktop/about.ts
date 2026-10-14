/**
 * The About dialog, with a "Support" link where the distribution channel allows one.
 *
 * `runAdwaitaApp({ about })` wires `app.about` itself but has no field for extra links, so this
 * replaces that action with one that builds the same dialog plus the link — a gjsify core gap, to
 * be closed with an `AboutInfo.links` field (`links: donationsAllowed() ? [...] : []`); delete the
 * override when it lands.
 *
 * The label is "Support", never "Donate": this is business income, and nothing here may imply a
 * tax deduction. A store channel (Microsoft, Apple) shows no donation UI at all: `donationsAllowed()`
 * is false there, and an unset channel counts as such.
 */
import Adw from '@girs/adw-1';
import Gio from '@girs/gio-2.0';
import type { AboutInfo } from '@gjsify/adwaita-app';
import { donationsAllowed } from '@gjsify/distribution';
import { _ } from './i18n.ts';

export const SUPPORT_URL = 'https://jumplink.eu/steuererklaerung/en/support/';

export function installAboutAction(app: Adw.Application, info: AboutInfo): void {
    const action = new Gio.SimpleAction({ name: 'about' });
    action.connect('activate', () => {
        const dialog = new Adw.AboutDialog({
            application_name: info.applicationName,
            application_icon: info.applicationIcon ?? app.get_application_id() ?? '',
            version: info.version ?? '',
            developer_name: info.developerName ?? '',
            website: info.website ?? '',
            copyright: info.copyright ?? '',
            comments: info.comments ?? '',
        });
        if (donationsAllowed()) dialog.add_link(_('Support'), SUPPORT_URL);
        dialog.present(app.get_active_window());
    });
    app.add_action(action);
}
