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

import { configuredBackupRoot, runConfiguredBackup } from '../../../../core/actions/backup.ts';
import { isDemoMode } from '../../../../core/config/demo.ts';
import { loadUserSettings, updateUserSettings } from '../../../../core/config/user-settings.ts';
import { _, fmt } from '../../i18n.ts';
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
    mode.add_suffix(switchButton);
    group.add(mode);

    const welcome = new Adw.ButtonRow({ title: _('Show welcome again') });
    welcome.connect('activated', () => welcome.activate_action('win.welcome', null));
    group.add(welcome);

    const ai = new Adw.SwitchRow({
        title: _('Show the AI assistant'),
        subtitle: _('Questions and the data needed to answer them go to the configured AI provider'),
    });
    ai.set_active(loadUserSettings().aiAssistant !== false);
    ai.connect('notify::active', () => {
        updateUserSettings((s) => {
            s.aiAssistant = ai.get_active();
        });
        ai.activate_action('win.assistant-preference', null);
    });
    group.add(ai);
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

    const now = new Adw.ButtonRow({ title: _('Back up now'), startIconName: 'document-save-symbolic' });
    now.add_css_class('suggested-action');
    now.connect('activated', () => {
        try {
            const result = runConfiguredBackup({ reason: 'manual' });
            showToast(fmt(_('Backup saved: {path}'), { path: result.path }));
        } catch (err) {
            showToast(fmt(_('Backup failed: {error}'), { error: err instanceof Error ? err.message : String(err) }));
        }
        refresh();
    });

    const choose = new Gtk.Button({
        iconName: 'folder-open-symbolic',
        tooltipText: _('Choose folder'),
        valign: Gtk.Align.CENTER,
    });
    choose.add_css_class('flat');
    choose.connect('clicked', () => {
        const dialog = new Gtk.FileDialog({ title: _('Backup folder'), modal: true });
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
