// Guard: the test bundle must not require a GUI typelib.
//
//   gjs -m check-test-bundle.js [dist/test.gjs.mjs]
//
// The tests run headless in CI, in a container with no libadwaita and no GTK. A test that imports
// a pure helper out of a GUI module drags `gi://Adw` into the bundle with it, and then the ENTIRE
// suite dies at load time with
//
//     JS ERROR: Error: Requiring Adw, version 1: Typelib file for namespace 'Adw' not found
//
// — before a single test runs. Locally it passes, because a developer machine has libadwaita; the
// first sign of trouble is a red CI three minutes later with a stack trace instead of a diagnosis.
// Measured once (the setup-assistant slug helper); this makes the next one fail here, by name.
//
// The fix is never to stub the typelib — it is to move the pure thing out of the GUI module, which
// is where it belonged anyway.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/** Namespaces that only exist on a machine with a desktop stack installed. */
const GUI_NAMESPACES = ['Adw', 'Gtk', 'Gdk', 'Gsk', 'GdkPixbuf', 'Pango', 'PangoCairo', 'Gwebgl'];

const here = GLib.path_get_dirname(import.meta.url.replace('file://', ''));
const bundle = ARGV[0] ?? GLib.build_filenamev([here, '..', 'dist', 'test.gjs.mjs']);

const file = Gio.File.new_for_path(bundle);
if (!file.query_exists(null)) {
    printerr(`check-test-bundle: ${bundle} fehlt — erst bauen.`);
    imports.system.exit(1);
}
const [, bytes] = file.load_contents(null);
const text = new TextDecoder().decode(bytes);

// Match the STATIC import, not the bare string: a comment, a test fixture, or a lazy `import()`
// (@gjsify/unit's GL probe since 0.53.0) is not a load-time dependency, and flagging it would train
// everyone to ignore this check.
const found = [];
for (const ns of GUI_NAMESPACES) {
    const pattern = new RegExp(`(?:^|[^\\w])(?:import|from)\\s*['"\`]gi://${ns}(?:\\?|['"\`])`, 'm');
    if (pattern.test(text)) found.push(ns);
}

if (found.length > 0) {
    printerr(`check-test-bundle: Das Test-Bundle importiert GUI-Typelibs: ${found.join(', ')}`);
    printerr('  In CI gibt es die nicht — die GESAMTE Suite stirbt beim Laden, bevor ein Test läuft.');
    printerr('  Ursache ist fast immer ein Test, der eine reine Funktion aus einem GTK-Modul importiert.');
    printerr('  Lösung: die reine Funktion in den Kern verschieben, nicht die Typelib stubben.');
    imports.system.exit(1);
}
print(`check-test-bundle: keine GUI-Typelibs im Test-Bundle (${GUI_NAMESPACES.length} geprüft).`);
