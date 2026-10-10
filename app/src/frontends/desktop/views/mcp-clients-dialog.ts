/**
 * "Connect an external agent" — the config snippet each MCP client wants for THIS installation,
 * ready to copy. The formats live in core/actions/mcp-clients.ts; here only the installation facts
 * (Flatpak, launcher on PATH, the bundle we run from) are looked up and shown.
 */

import Adw from '@girs/adw-1';
import Gdk from '@girs/gdk-4.0';
import GLib from '@girs/glib-2.0';
import Gtk from '@girs/gtk-4.0';
import Pango from '@girs/pango-1.0';

import { mcpClientSnippets, resolveMcpLaunch, type McpClientSnippet } from '../../../core/actions/mcp-clients.ts';
import { isDemoMode } from '../../../core/config/demo.ts';
import { getManifestPath } from '../../../core/config/manifest.ts';
import { bundlePath, checkoutGjsify } from '../self-launch.ts';
import { showToast } from '../toast.ts';
import { _, fmt } from '../i18n.ts';

export function currentMcpSnippets(): McpClientSnippet[] {
    return mcpClientSnippets(
        resolveMcpLaunch({
            flatpakId: process.env.FLATPAK_ID || undefined,
            installedBinary: GLib.find_program_in_path('steuererklaerung') ?? undefined,
            bundlePath: bundlePath(),
            gjsifyBin: checkoutGjsify(bundlePath()),
            manifestPath: getManifestPath(),
            demo: isDemoMode(),
        }),
    );
}

function snippetGroup(s: McpClientSnippet): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
        title: s.name,
        description: s.kind === 'shell' ? _('Run in a terminal') : fmt(_('Add to {file}'), { file: s.target }),
    });
    const copy = new Gtk.Button({ iconName: 'edit-copy-symbolic', tooltipText: _('Copy'), valign: Gtk.Align.CENTER });
    copy.add_css_class('flat');
    copy.connect('clicked', () => {
        copy.get_clipboard().set_content(Gdk.ContentProvider.new_for_value(s.text));
        showToast(fmt(_('Copied for {client}'), { client: s.name }));
    });
    const docs = new Gtk.LinkButton({ uri: s.docsUrl, label: _('Docs'), valign: Gtk.Align.CENTER });
    const suffix = new Gtk.Box({ spacing: 4 });
    suffix.append(docs);
    suffix.append(copy);
    group.set_header_suffix(suffix);

    const label = new Gtk.Label({
        label: s.text,
        xalign: 0,
        selectable: true,
        wrap: true,
        wrapMode: Pango.WrapMode.WORD_CHAR,
        cssClasses: ['monospace'],
        marginTop: 12,
        marginBottom: 12,
        marginStart: 12,
        marginEnd: 12,
    });
    const card = new Gtk.Box({ cssClasses: ['card'] });
    card.append(label);
    group.add(card);
    return group;
}

export function openMcpClientsDialog(parent: Gtk.Widget): void {
    const dialog = new Adw.Dialog({ title: _('Connect an external agent'), contentWidth: 680, contentHeight: 760 });
    const page = new Adw.PreferencesPage();
    const intro = new Adw.PreferencesGroup({
        description: _(
            'The agent starts the MCP server itself. Turn on “MCP server for external agents” first; ' +
                'writing tools stay off unless you allow them. Restart the agent after changing its config.',
        ),
    });
    page.add(intro);
    for (const s of currentMcpSnippets()) page.add(snippetGroup(s));

    const toolbar = new Adw.ToolbarView();
    toolbar.add_top_bar(new Adw.HeaderBar());
    toolbar.set_content(page);
    dialog.set_child(toolbar);
    dialog.present(parent);
}
