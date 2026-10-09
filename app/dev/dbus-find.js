// Find ONE widget in a running, devtools-enabled Steuererklärung and print its path.
//
//   gjs -m dbus-find.js <dest> <object-path> <selector>
//
//   selector := Type[:css-class]      e.g. "GtkButton" · "GtkButton:suggested-action"
//
// Companion to dbus-shot.js, used by screenshot.sh's STEUER_SHOT_ACTIVATE: ActivateWidget takes a
// `toplevel:N/child:M` path, and those paths are positional — writing one into a script by hand
// makes the script wrong the moment a widget is inserted above it. So the path is looked up by what
// the widget IS, every run.
//
// Prints the path and exits 0 on exactly one first match; exits 1 with a message on no match. The
// tree comes back as JSON from DumpTree with a generous depth — the interesting widgets in this app
// sit ~15 levels down, and DumpTree's depth argument SILENTLY truncates, so a too-small depth looks
// exactly like "the widget is not there".
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import system from 'system';

const [dest, path, selector] = ARGV;
if (!selector) {
    printerr('usage: dbus-find.js <dest> <object-path> <Type[:css-class][@title-substring]>');
    system.exit(1);
}
// `@` selects by the widget's `title` property — the only way to tell twelve AdwPreferencesGroups
// apart, since a title is not in the tree dump (it needs a GetProperty per candidate).
const atIndex = selector.indexOf('@');
const wantTitle = atIndex >= 0 ? selector.slice(atIndex + 1) : '';
const [wantType, wantClass] = (atIndex >= 0 ? selector.slice(0, atIndex) : selector).split(':');

const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
const reply = bus.call_sync(
    dest,
    path,
    'org.gjsify.Devtools',
    'DumpTree',
    GLib.Variant.new_tuple([GLib.Variant.new_string('window'), GLib.Variant.new_int32(64)]),
    GLib.VariantType.new('(s)'),
    Gio.DBusCallFlags.NONE,
    12000,
    null,
);

const tree = JSON.parse(reply.get_child_value(0).get_string()[0]);

/** Read one widget's `title`, or '' when it has none. */
function titleOf(widgetPath) {
    try {
        const reply = bus.call_sync(
            dest,
            path,
            'org.gjsify.Devtools',
            'GetProperty',
            GLib.Variant.new_tuple([GLib.Variant.new_string(widgetPath), GLib.Variant.new_string('title')]),
            GLib.VariantType.new('(s)'),
            Gio.DBusCallFlags.NONE,
            12000,
            null,
        );
        return JSON.parse(reply.get_child_value(0).get_string()[0]) ?? '';
    } catch {
        // A widget without the property is simply not a title match — not an error.
        return '';
    }
}

/** Depth-first, so the first hit is the topmost one in reading order. */
function find(node) {
    const typeOk = !wantType || node.type === wantType;
    const classOk = !wantClass || (node.cssClasses ?? []).includes(wantClass);
    // Invisible widgets are still in the tree — activating one proves nothing about what a user sees.
    if (typeOk && classOk && node.mapped !== false && node.visible !== false) {
        // The title check runs LAST: it costs a round-trip per candidate, so it must not be paid
        // for every widget in the tree, only for the handful the cheap checks already accepted.
        if (!wantTitle || String(titleOf(node.path)).includes(wantTitle)) return node.path;
    }
    for (const child of node.children ?? []) {
        const hit = find(child);
        if (hit) return hit;
    }
    return null;
}

const hit = find(tree);
if (!hit) {
    printerr(`no visible widget matches "${selector}"`);
    system.exit(1);
}
print(hit);
