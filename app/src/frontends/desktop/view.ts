/**
 * The contract every ported native view satisfies.
 *
 * A ported view IS a GTK widget (it goes straight into the content stack) that knows how to
 * (re)load itself for a given entity + reporting year. The window calls `reload()` when the view
 * becomes visible and whenever the entity/year switchers change. Views that aren't ported yet fall
 * back to a placeholder status page (see window.ts) and simply don't appear in the registry.
 */

import type Gtk from '@girs/gtk-4.0';
import type { AppEntity } from './entities.ts';

export type PortedView = Gtk.Widget & {
    reload(entity: AppEntity, year: number): void;
};

/** Builds a fresh instance of a ported view. */
export type ViewFactory = () => PortedView;
