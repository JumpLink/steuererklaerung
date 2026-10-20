/**
 * Native GNOME (GTK4 + libadwaita) front-end — entry point.
 *
 * A desktop sibling to the `steuer web` review UI: both read the same backend, but this one
 * renders with native Adwaita widgets (the first step toward a fully native GJS/Adwaita port).
 *
 *   build:  npm run build:app    (gjsify build → dist/steuer-app.gjs.mjs)
 *   run:    npm run start:app    (gjsify run dist/steuer-app.gjs.mjs)
 *
 * The shell is @gjsify/adwaita-app's AdwaitaApp + runApplication() — what runAdwaitaApp() wraps,
 * minus its fixed command line (see guiArgv in launch-mode.ts). It owns the runAsync lifecycle (NOT
 * the synchronous run()), the app.quit/app.about actions and the env-gated @gjsify/devtools control
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
import { AdwaitaApp, runApplication } from '@gjsify/adwaita-app';
import { donationsAllowed } from '@gjsify/distribution';
import { installMigrationBackup, runConfiguredBackup } from '../../core/actions/backup.ts';
import { applyDemoEnv } from '../../core/config/demo.ts';
import { loadUserSettings } from '../../core/config/user-settings.ts';
import { setFinTSInteraction } from '../../core/clients/fints/interaction.ts';
import { applyPathEnv } from '../../core/paths.ts';
import { ensureDemoSeeded } from '../cli/demo.ts';
import { runCli } from '../cli/main.ts';
import { BACKUP_RESULT_PREFIX } from './background-backup.ts';
import { APP_ID, APP_NAME, APP_VERSION } from './constants.ts';
import { EDITION_BADGE_CSS, installAbout } from './about-dialog.ts';
import { dialogFinTSInteraction } from './fints-interaction.ts';
import { _ } from './i18n.ts';
import { APP_ICON } from './icons.ts';
import { guiArgv, launchMode } from './launch-mode.ts';
import { relaunchIfRequested, snapshotLaunchEnv } from './restart.ts';
import { localizedSupportUrl } from './views/support-dialog.ts';
import { MainWindow } from './window.ts';

// Pin GTK 4 before libadwaita pulls it in; keep the import referenced.
void Gtk;

// The installed app is the one binary a package or Flatpak ships, so it is also the CLI and the
// MCP server an external agent starts. Only an argument-free launch opens a window — see
// launch-mode.ts for why anything else must not.
const mode = launchMode(process.argv.slice(2));

// The environment as launched, for a restart into the other data mode — before anything rewrites it.
snapshotLaunchEnv();
// Someone who picked the demo (welcome or Settings) gets it again, unless the launch says otherwise.
// Only for the window: a CLI invocation must never silently read demo data because of a GUI setting.
if (
    mode === 'gui' &&
    process.env.STEUER_DEMO === undefined &&
    process.env.BH_DEMO === undefined &&
    !process.argv.includes('--demo') &&
    loadUserSettings().preferredMode === 'demo'
) {
    process.env.STEUER_DEMO = '1';
}
// Demo mode (STEUER_DEMO=1): run against the isolated app/demo workspace before any config/store read.
applyDemoEnv();
installMigrationBackup();
// Then give a FRESH installation a home: without this, an app launched from the GNOME overview has
// cwd `/` or `$HOME` and finds no manifest at all. Strictly additive — an existing installation
// (a manifest in cwd, an override, a store beside the module) is left exactly as it was.
applyPathEnv();
if (mode === 'cli') {
    // `steuererklaerung --help`, `… --version`, `… elster plan 2025`, `… backup list`: the whole
    // `steuer` CLI, headless, from the packaged binary. Called from this SYNCHRONOUS stack on
    // purpose — on GJS runCli() ends in `loop.run()`, and a main loop entered from the
    // continuation of a top-level await never flushes the promise jobs (the same trap the `mcp`
    // branch below documents). runCli() repeats the idempotent env setup above; it has to, because
    // the standalone `steuer` bundle calls it with none of it done.
    runCli();
} else if (mode === 'mcp') {
    // Awaited, not driven by a nested GLib.MainLoop: this module already sits in a top-level await,
    // and a nested loop.run() inside it never flushes the promise jobs — the server would hang
    // before answering `initialize`. GJS spins its own loop until this settles; the server parks
    // until its client closes stdin and then calls process.exit().
    const { startMcpServer } = await import('../mcp/server.ts');
    try {
        await startMcpServer({ transport: 'stdio' });
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
} else if (mode === 'backup-child') {
    // The child the window starts for "Back up now" (background-backup.ts), so the copy runs off
    // the GLib loop. Not a user command — that is the CLI's `steuer backup create`.
    // The parent passed its resolved environment, so this backs up exactly what the window shows.
    // One result line on stdout; the lock in createBackup keeps it from overlapping any other run.
    let line: string;
    try {
        const r = runConfiguredBackup({ reason: process.argv[3] || 'manual' });
        line = JSON.stringify({ ok: true, path: r.path });
    } catch (err) {
        const detail = (err as { detail?: unknown }).detail; // language-neutral twin of the message, see error-text.ts
        line = JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err), detail });
    }
    console.log(BACKUP_RESULT_PREFIX + line);
    process.exit(0);
} else {
    // The bank asks for a TAN through a dialog here, not through stdin — without this the app can add a
    // FinTS account and never complete one sync, because the terminal prompt has nobody typing into it.
    setFinTSInteraction(dialogFinTSInteraction);
    // Populate the demo workspace (invoices/contacts/Belege) on first run so the app
    // isn't empty out of the box. No-op outside demo mode and when already seeded.
    await ensureDemoSeeded();

    const about = {
        applicationName: APP_NAME,
        applicationIcon: APP_ICON,
        // Keep in sync with the web About dialog (frontends/web/client/components/bh-app.ts):
        // one project, one vendor line. "Art+Code Studio" was the dissolved GbR.
        developerName: 'JumpLink',
        version: APP_VERSION,
        website: 'https://github.com/JumpLink',
        copyright: '© 2026 Pascal Garber',
        // "Support", never "Donate": business income, nothing here implies a tax deduction. A store
        // channel shows no donation UI at all.
        links: donationsAllowed() ? [{ title: _('Support'), url: localizedSupportUrl() }] : [],
        comments: _(
            'Native Adwaita interface for the tax return — alongside the web interface, ' +
                'on the same backend (store, EÜR/tax reports, receipts, contacts).',
        ),
    };
    const guiApp = new AdwaitaApp({
        applicationId: APP_ID,
        css: EDITION_BADGE_CSS,
        // Not the `about` option: the plain dialog has no room for the edition badges.
        onStartup: (app) => installAbout(app, about),
        createWindow: (app) => {
            return new MainWindow(app);
        },
    });
    // runApplication, not runAdwaitaApp: that convenience wrapper hands the raw command line to
    // GApplication, which rejects the app's own `--demo` (see guiArgv). Same lifecycle otherwise.
    const status = await runApplication(guiApp, [process.argv[1] ?? APP_NAME, ...guiArgv(process.argv.slice(2))]);
    relaunchIfRequested();
    process.exit(status);
}
