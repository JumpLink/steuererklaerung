/**
 * Settings → „General" and „Backup": the per-user groups.
 *
 * Both read and write the per-user settings file, never the manifest — which is also why they are
 * built apart from the manifest-backed global rows. Those give up when no manifest loads, and a
 * person on a first run, or in the demo, must still be able to switch modes and make a backup.
 *
 * Switching modes and reopening the welcome go through window actions (`win.switch-mode`,
 * `win.welcome`): the window owns the confirm dialog and the restart.
 */

import Adw from '@girs/adw-1';
import type Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';

import {
    type AgentSource,
    type AiEngine,
    agentSourceLockedToBundled,
    resolveAgentSource,
    resolveAiEngine,
} from '../../../../core/actions/assistant/lotse-embed.ts';
import { configuredBackupRoot } from '../../../../core/actions/backup.ts';
import { assistantOffered } from '../../../../core/config/assistant-offered.ts';
import { isAssistantEnabled } from '../../../../core/config/assistant-preference.ts';
import { demoAvailable, isDemoMode } from '../../../../core/config/demo.ts';
import { loadUserSettings, updateUserSettings } from '../../../../core/config/user-settings.ts';
import { _, fmt } from '../../i18n.ts';
import { errorText } from '../../error-text.ts';
import { isBackupRunning, runBackupInBackground } from '../../background-backup.ts';
import { showToast } from '../../toast.ts';
import { markup } from '../util.ts';

/** Demo/own switch, „Show welcome again", AI opt-in. */
export function buildGeneralGroup(group: Adw.PreferencesGroup): void {
    const demo = isDemoMode();
    const mode = new Adw.ActionRow({
        title: _('Data'),
        subtitle: demo ? _('Demo data — fictional examples') : _('Your own data'),
    });
    const switchButton = new Gtk.Button({
        label: demo ? _('Use my own data') : _('Try the demo'),
        valign: Gtk.Align.CENTER,
    });
    switchButton.connect('clicked', () =>
        switchButton.activate_action('win.switch-mode', GLib.Variant.new_string(demo ? 'own' : 'demo')),
    );
    if (!demo && !demoAvailable()) {
        switchButton.set_sensitive(false);
        mode.set_subtitle(_('Your own data — this installation ships no demo data'));
    }
    mode.add_suffix(switchButton);
    group.add(mode);

    const welcome = new Adw.ButtonRow({ title: _('Show welcome again') });
    welcome.connect('activated', () => welcome.activate_action('win.welcome', null));
    group.add(welcome);

    // A build without the assistant offers no switch for it: an off switch is still an offer, and
    // the engine rows below it would promise two assistants that cannot run.
    if (!assistantOffered()) return;

    const ai = new Adw.SwitchRow({
        title: _('AI assistant'),
        subtitle: _(
            'Questions and the data needed to answer them go to the configured AI provider. ' +
                'Independent of the MCP server.',
        ),
    });
    ai.set_active(isAssistantEnabled());
    const engine = buildEngineRow();
    const source = buildAgentSourceRow();
    engine.set_sensitive(ai.get_active());
    source.set_sensitive(ai.get_active());
    ai.connect('notify::active', () => {
        updateUserSettings((s) => {
            s.aiAssistant = ai.get_active();
        });
        engine.set_sensitive(ai.get_active());
        source.set_sensitive(ai.get_active());
        ai.activate_action('win.assistant-preference', null);
    });
    group.add(ai);
    group.add(engine);
    group.add(source);
}

/**
 * Which opencode the coding agent runs: the one shipped with the app (own isolated config) or the
 * person's own. The model policy that blocks free hosted models applies to both.
 */
function buildAgentSourceRow(): Adw.ComboRow {
    const sources: AgentSource[] = ['bundled', 'host'];
    const row = new Adw.ComboRow({
        title: _('Coding agent'),
        subtitle: _(
            'Your own opencode uses your login and models from its global configuration. ' +
                'Takes effect the next time the app starts.',
        ),
        model: Gtk.StringList.new([_('Bundled opencode (recommended)'), _('Own opencode (global configuration)')]),
    });
    row.set_selected(Math.max(0, sources.indexOf(resolveAgentSource())));
    if (agentSourceLockedToBundled()) {
        row.set_subtitle(_('The Flatpak sandbox cannot reach your own opencode, so the bundled one is always used.'));
        row.set_sensitive(false);
    }
    row.connect('notify::selected', () => {
        const chosen = sources[row.get_selected()];
        if (!chosen) return;
        updateUserSettings((s) => {
            s.aiAgentSource = chosen;
        });
    });
    return row;
}

/**
 * Which assistant the switch above turns on. Insensitive while AI is off, because the choice is
 * meaningless then — neither pane is built and no agent is started either way.
 *
 * A restart, not a live swap: the coding agent is a subprocess with a session file of its own, and
 * rebuilding the pane under a running turn would be a second way for it to end.
 */
function buildEngineRow(): Adw.ComboRow {
    const engines: AiEngine[] = ['builtin', 'lotse'];
    const row = new Adw.ComboRow({
        title: _('Assistant engine'),
        subtitle: _('Takes effect the next time the app starts.'),
        model: Gtk.StringList.new([
            // TRANSLATORS: The assistant that is part of the app and answers in-process
            _('Built in'),
            // TRANSLATORS: lotse is a program name — it starts a coding agent as a separate process
            _('Coding agent (lotse)'),
        ]),
    });
    row.set_selected(Math.max(0, engines.indexOf(resolveAiEngine())));
    row.connect('notify::selected', () => {
        const chosen = engines[row.get_selected()];
        if (!chosen) return;
        updateUserSettings((s) => {
            s.aiEngine = chosen;
        });
    });
    return row;
}

/** „Back up now", the last backup, the folder and how many to keep. Restore is manual (docs/app/backup.md). */
export function buildBackupGroup(group: Adw.PreferencesGroup): void {
    const last = new Adw.ActionRow({ title: _('Last backup') });
    last.add_css_class('property');
    const folder = new Adw.ActionRow({ title: _('Backup folder') });
    folder.add_css_class('property');

    const refresh = () => {
        const s = loadUserSettings();
        last.set_subtitle(
            s.backup.lastAt
                ? markup(
                      fmt(_('{time} in {path}'), {
                          time: new Date(s.backup.lastAt).toLocaleString(),
                          path: s.backup.lastPath ?? '',
                      }),
                  )
                : _('Never'),
        );
        folder.set_subtitle(markup(configuredBackupRoot(s)));
    };

    const now = new Adw.ButtonRow({
        title: _('Back up now'),
        startIconName: 'document-save-symbolic',
    });
    now.add_css_class('suggested-action');
    const spinner = new Adw.Spinner({ visible: false, valign: Gtk.Align.CENTER });
    last.add_suffix(spinner);
    const setBusy = (busy: boolean) => {
        now.set_sensitive(!busy);
        now.set_title(busy ? _('Backing up …') : _('Back up now'));
        spinner.set_visible(busy);
    };
    // The child process does the copying; the window only waits, so it keeps drawing. Reopening
    // Settings mid-run picks up the same run instead of offering a second one.
    const start = () => {
        setBusy(true);
        runBackupInBackground('manual')
            .then((result) => showToast(fmt(_('Backup saved: {path}'), { path: result.path })))
            .catch((err: unknown) =>
                showToast(
                    fmt(_('Backup failed: {error}'), {
                        error: errorText(err),
                    }),
                ),
            )
            .finally(() => {
                setBusy(false);
                refresh();
            });
    };
    now.connect('activated', start);
    if (isBackupRunning()) start();

    const choose = new Gtk.Button({
        iconName: 'folder-open-symbolic',
        tooltipText: _('Choose folder'),
        valign: Gtk.Align.CENTER,
    });
    choose.add_css_class('flat');
    choose.connect('clicked', () => {
        const dialog = new Gtk.FileDialog({
            title: _('Backup folder'),
            modal: true,
        });
        const root = choose.get_root();
        dialog.select_folder(root instanceof Gtk.Window ? root : null, null, (_source, res) => {
            let file: Gio.File | null = null;
            try {
                file = dialog.select_folder_finish(res);
            } catch {
                return; // cancelled
            }
            const path = file?.get_path();
            if (!path) return;
            updateUserSettings((s) => {
                s.backup.dir = path;
            });
            refresh();
        });
    });
    folder.add_suffix(choose);

    const keep = new Adw.SpinRow({
        title: _('Keep backups'),
        subtitle: _('Older ones are deleted after each new backup'),
        adjustment: new Gtk.Adjustment({
            lower: 1,
            upper: 100,
            stepIncrement: 1,
            pageIncrement: 5,
            value: loadUserSettings().backup.keep,
        }),
    });
    keep.connect('notify::value', () => {
        updateUserSettings((s) => {
            s.backup.keep = Math.round(keep.get_value());
        });
    });

    group.add(now);
    group.add(last);
    group.add(folder);
    group.add(keep);
    refresh();
}
