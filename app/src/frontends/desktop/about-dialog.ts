import Adw from '@girs/adw-1';
import Gio from '@girs/gio-2.0';
import Gtk from '@girs/gtk-4.0';
import { purchased } from '@gjsify/distribution';
import { editionBadges } from '../../core/lib/edition-badges.ts';

/**
 * Brand pill for the edition badges: the app's two greens as ONE fixed pair, so the contrast does
 * not depend on the light/dark theme — a theme-tinted pill goes pale on dark.
 */
export const EDITION_BADGE_CSS = `
.edition-badge {
    padding: 2px 12px;
    border-radius: 999px;
    font-size: 0.8em;
    font-weight: bold;
    color: #2f5238;
    background-color: #cfe5c8;
}
`;

/** The first descendant carrying `cssClass`, depth first — null if the tree has none. */
function findByCssClass(widget: Gtk.Widget, cssClass: string): Gtk.Widget | null {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        if (child.has_css_class(cssClass)) return child;
        const found = findByCssClass(child, cssClass);
        if (found) return found;
    }
    return null;
}

/** One badge: the name as a pill, the sentence that explains it underneath. */
function buildBadges(): Gtk.Box {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, marginTop: 6 });
    for (const badge of editionBadges(purchased())) {
        const group = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 3 });
        group.append(new Gtk.Label({ label: badge.title, halign: Gtk.Align.CENTER, cssClasses: ['edition-badge'] }));
        group.append(
            new Gtk.Label({
                label: badge.detail,
                halign: Gtk.Align.CENTER,
                justify: Gtk.Justification.CENTER,
                wrap: true,
                maxWidthChars: 30,
                cssClasses: ['caption', 'dim-label'],
            }),
        );
        box.append(group);
    }
    return box;
}

/**
 * Put the badges on the main page, directly under the version pill.
 *
 * `Adw.AboutDialog` has no API for this: `comments` and `add_link()` both land on the Details
 * subpage, and a badge nobody sees without clicking "Details" is not a badge. So the pill is found
 * by its `.app-version` class in libadwaita's template. Should the template change, nothing is
 * found and the caller falls back to the comments, where the same text stays readable.
 */
function addBadges(dialog: Adw.AboutDialog): boolean {
    const version = findByCssClass(dialog, 'app-version');
    const page = version?.get_parent();
    if (!version || !(page instanceof Gtk.Box)) return false;
    page.insert_child_after(buildBadges(), version);
    return true;
}

export interface AboutOptions {
    applicationName: string;
    applicationIcon: string;
    developerName: string;
    version: string;
    website: string;
    copyright: string;
    links: { title: string; url: string }[];
    comments: string;
}

export function createAboutDialog(o: AboutOptions): Adw.AboutDialog {
    const dialog = new Adw.AboutDialog({
        applicationName: o.applicationName,
        applicationIcon: o.applicationIcon,
        developerName: o.developerName,
        version: o.version,
        website: o.website,
        copyright: o.copyright,
        comments: o.comments,
    });
    for (const link of o.links) dialog.add_link(link.title, link.url);
    // An Adw.Dialog has no widget tree until it is mapped, so the badges go in on the first map.
    const mapped = dialog.connect('map', () => {
        dialog.disconnect(mapped);
        if (!addBadges(dialog)) {
            const notice = editionBadges(purchased())
                .map((b) => `${b.title} · ${b.detail}`)
                .join('\n');
            dialog.comments = `${notice}\n\n${dialog.comments}`;
        }
    });
    return dialog;
}

/** Wire `app.about`, replacing the plain one `runAdwaitaApp` would add. */
export function installAbout(app: Adw.Application, o: AboutOptions): void {
    const action = new Gio.SimpleAction({ name: 'about' });
    action.connect('activate', () => createAboutDialog(o).present(app.get_active_window()));
    app.add_action(action);
}
