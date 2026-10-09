/**
 * The application icon, without a packaging step.
 *
 * The app ships `data/icons/hicolor/scalable/apps/<APP_ICON>.svg` and, at startup, adds that
 * tree to the display's icon theme search path. That is enough for everything GTK resolves by
 * icon NAME in-process — the About dialog above all. It is deliberately not enough for the
 * shell's taskbar/overview entry: under Wayland the compositor matches the surface's app-id
 * against an INSTALLED `.desktop` file, so that one only appears once `data/*.desktop` plus the
 * icon are installed into an XDG data dir (see `data/README.md`). Running straight from the
 * repo, the About dialog is where you see it.
 *
 * The icon name is the CANONICAL app id, not {@link APP_ID}: `STEUER_APP_ID` exists to run a
 * second, differently-named instance for screenshots/devtools, and that instance should still
 * show the product's icon rather than silently falling back to the missing-image placeholder.
 */

import Gtk from '@girs/gtk-4.0';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Icon-theme name of the application icon (matches the SVG basename under data/icons). */
export const APP_ICON = 'eu.jumplink.Steuererklaerung';

/**
 * The shipped icon-theme root (`<app>/data/icons`), resolved relative to THIS module so it is
 * correct from any cwd and in both the source and the bundled form — same trick as
 * {@link demoDir} in core/config/demo.ts.
 */
function iconsDir(): string {
    const fileUrl = import.meta.url;
    const dir = dirname(fileURLToPath(fileUrl));
    // source: <app>/src/frontends/desktop/icons.ts → up 3 = <app>; bundled: <app>/dist/<bundle> → up 1.
    const appRoot = fileUrl.includes('/dist/') ? join(dir, '..') : join(dir, '..', '..', '..');
    return join(appRoot, 'data', 'icons');
}

/**
 * Register the shipped icon theme on the widget's display. Safe to call more than once
 * (`add_search_path` de-duplicates), and a no-op if the display is not up yet.
 */
export function registerAppIcons(widget: Gtk.Widget): void {
    const display = widget.get_display();
    if (!display) return;
    Gtk.IconTheme.get_for_display(display).add_search_path(iconsDir());
}
