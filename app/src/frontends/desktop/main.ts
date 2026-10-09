/**
 * Native GNOME (GTK4 + libadwaita) front-end — entry point.
 *
 * A desktop sibling to the `steuer web` review UI: both read the same backend, but this one
 * renders with native Adwaita widgets (the first step toward a fully native GJS/Adwaita port).
 *
 *   build:  npm run build:app    (gjsify build → dist/steuer-app.gjs.mjs)
 *   run:    npm run start:app    (gjsify run dist/steuer-app.gjs.mjs)
 *
 * The shell is @gjsify/adwaita-app's runAdwaitaApp(): it owns the runAsync lifecycle (NOT the
 * synchronous run()), the app.quit/app.about actions and the env-gated @gjsify/devtools control
 * plane. runAsync is required, not cosmetic: under the synchronous run() the GJS promise-job queue
 * is not flushed for a purely synchronous load (one with no Gio/libsoup I/O in its chain), so a
 * store-only view load — e.g. a `privat` entity's Home model or ESt plan — would never run its
 * `.then` and would hang on its loading spinner. runAsync drives the loop the way GJS integrates the
 * promise-job dispatcher, so async/await works throughout the app; we then exit via process.exit()
 * (gjsify schedules the GLib teardown) — the same teardown discipline the CLI uses. The rich
 * MainWindow (sidebar nav, per-entity views) stays app-specific; adwaita-app never hides Adw/GTK.
 */

// FIRST: binds the catalogue before any other module evaluates (see i18n-init.ts).
import './i18n-init.ts';
import 'dotenv/config';
import Gtk from '@girs/gtk-4.0';
import { runAdwaitaApp } from '@gjsify/adwaita-app';
import { installMigrationBackup } from '../../core/actions/backup.ts';
import { applyDemoEnv } from '../../core/config/demo.ts';
import { setFinTSInteraction } from '../../core/clients/fints/interaction.ts';
import { applyPathEnv } from '../../core/paths.ts';
import { ensureDemoSeeded } from '../cli/demo.ts';
import { APP_ID, APP_NAME, APP_VERSION } from './constants.ts';
import { dialogFinTSInteraction } from './fints-interaction.ts';
import { APP_ICON } from './icons.ts';
import { MainWindow } from './window.ts';

// Pin GTK 4 before libadwaita pulls it in; keep the import referenced.
void Gtk;

// Demo mode (STEUER_DEMO=1): run against the isolated app/demo workspace before any config/store read.
applyDemoEnv();
installMigrationBackup();
// Then give a FRESH installation a home: without this, an app launched from the GNOME overview has
// cwd `/` or `$HOME` and finds no manifest at all. Strictly additive — an existing installation
// (a manifest in cwd, an override, a store beside the module) is left exactly as it was.
applyPathEnv();
// The bank asks for a TAN through a dialog here, not through stdin — without this the app can add a
// FinTS account and never complete one sync, because the terminal prompt has nobody typing into it.
setFinTSInteraction(dialogFinTSInteraction);
// Populate the demo workspace (invoices/contacts/Belege) on first run so the app
// isn't empty out of the box. No-op outside demo mode and when already seeded.
await ensureDemoSeeded();

const status = await runAdwaitaApp({
    applicationId: APP_ID,
    about: {
        applicationName: APP_NAME,
        applicationIcon: APP_ICON,
        // Keep in sync with the web About dialog (frontends/web/client/components/bh-app.ts):
        // one project, one vendor line. "Art+Code Studio" was the dissolved GbR.
        developerName: 'JumpLink',
        version: APP_VERSION,
        website: 'https://github.com/JumpLink',
        copyright: '© 2026 Pascal Garber',
        comments:
            'Native Adwaita-Oberfläche für die Steuererklärung — parallel zur Web-Oberfläche, ' +
            'auf demselben Backend (Store, EÜR/Steuer-Reports, Belege, Kontakte).',
    },
    createWindow: (app) => new MainWindow(app),
});
process.exit(status);
