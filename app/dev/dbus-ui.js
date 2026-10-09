// Read and drive the widgets of a running, devtools-enabled Steuererklärung over D-Bus.
//
//   gjs -m dbus-ui.js <dest> <object-path> texts
//   gjs -m dbus-ui.js <dest> <object-path> has   <text>      exit 0 when a mapped widget shows <text>
//   gjs -m dbus-ui.js <dest> <object-path> click <text> [Type]   activate the first mapped widget whose
//                                                         title/label contains <text> (optionally of
//                                                         that GTK type, e.g. AdwButtonRow)
//   gjs -m dbus-ui.js <dest> <object-path> click-tip <text>  activate the first mapped button (or check box) whose
//                                                         TOOLTIP contains <text> — for a row of equal
//                                                         labels („Als in Ordnung markieren" on every
//                                                         Hinweis card) that only the tooltip tells apart
//
// `texts` prints one line per mapped widget that carries a title or label — the assertion surface of
// dev/doppelzahlung-e2e.sh, which has to prove a dialog says what it should, not that pixels exist.
// dbus-find.js is the single-selector sibling (Type[:css-class][@title]); this one matches on text
// alone, because a button row's label is the only thing that tells "Ist in Ordnung" from its siblings.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import system from 'system';

const [dest, path, command, needle = '', wantType = ''] = ARGV;
const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);

function call(method, args, outType) {
    const reply = bus.call_sync(
        dest,
        path,
        'org.gjsify.Devtools',
        method,
        GLib.Variant.new_tuple(args),
        GLib.VariantType.new(outType),
        Gio.DBusCallFlags.NONE,
        12000,
        null,
    );
    return reply.get_child_value(0);
}

const TEXT_PROP = {
    AdwPreferencesGroup: ['title', 'description'],
    AdwActionRow: ['title', 'subtitle'],
    AdwExpanderRow: ['title', 'subtitle'],
    AdwButtonRow: ['title'],
    AdwSwitchRow: ['title', 'subtitle'],
    AdwBanner: ['title'],
    AdwStatusPage: ['title'],
    AdwWindowTitle: ['title', 'subtitle'],
    AdwAlertDialog: ['heading', 'body'],
    GtkLabel: ['label'],
    GtkButton: ['label'],
    GtkCheckButton: ['label'],
};

function prop(widgetPath, name) {
    try {
        const raw = call(
            'GetProperty',
            [GLib.Variant.new_string(widgetPath), GLib.Variant.new_string(name)],
            '(s)',
        ).get_string()[0];
        const value = JSON.parse(raw);
        return typeof value === 'string' ? value : '';
    } catch {
        return '';
    }
}

// Depth 64: DumpTree silently truncates, and the dialogs sit ~15 levels down (see dbus-find.js).
const tree = JSON.parse(
    call('DumpTree', [GLib.Variant.new_string('window'), GLib.Variant.new_int32(64)], '(s)').get_string()[0],
);

/** Every mapped widget with text: { path, type, text }. Markup is stripped to what the eye reads. */
function collect(node, out) {
    const props = TEXT_PROP[node.type];
    if (props && node.mapped !== false && node.visible !== false) {
        let text = props
            .map((p) => prop(node.path, p))
            .filter(Boolean)
            .join(' | ');
        // A card-button (the Übersicht's Frei-verfügbar card) has a child instead of a label — its
        // tooltip is then the only text that names it.
        // A check box in a list row has no label of its own either — same fallback.
        const tipped = node.type === 'GtkButton' || node.type === 'GtkCheckButton';
        if (!text && tipped) text = prop(node.path, 'tooltip-text');
        text = text.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
        const tip = tipped ? prop(node.path, 'tooltip-text') : '';
        if (text) out.push({ path: node.path, type: node.type, text, tip });
    }
    for (const child of node.children ?? []) collect(child, out);
    return out;
}

const items = collect(tree, []);

if (command === 'texts') {
    for (const i of items) print(`${i.type}\t${i.text}`);
} else if (command === 'has') {
    system.exit(items.some((i) => i.text.includes(needle)) ? 0 : 1);
} else if (command === 'click' || command === 'click-tip') {
    const hit = items.find((i) =>
        command === 'click-tip'
            ? i.tip?.includes(needle)
            : i.text.includes(needle) && (!wantType || i.type === wantType),
    );
    if (!hit) {
        printerr(`dbus-ui: no mapped ${wantType || 'widget'} shows "${needle}"`);
        system.exit(1);
    }
    const ok = call('ActivateWidget', [GLib.Variant.new_string(hit.path)], '(b)').get_boolean();
    print(`${ok ? 'activated' : 'refused'} ${hit.type} "${hit.text}" at ${hit.path}`);
    system.exit(ok ? 0 : 1);
} else {
    printerr('usage: dbus-ui.js <dest> <object-path> texts | has <text> | click <text> [Type] | click-tip <text>');
    system.exit(1);
}
