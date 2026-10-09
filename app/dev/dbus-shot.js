// Pull a PNG screenshot from a running, devtools-enabled Steuererklärung over D-Bus.
//
//   gjs -m dbus-shot.js <dest> <object-path> <out.png>
//
// The app must run with GJSIFY_DEVTOOLS=1 (see screenshot.sh). `@gjsify/devtools`
// renders the top-level window in-process via the GSK renderer — no compositor
// portal — and returns the PNG bytes as a D-Bus `ay`; gdbus alone can't save the
// binary, so this tiny caller unpacks the variant and writes the file.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import system from 'system';

const [dest, path, out, scope] = ARGV;
// `scope` is the devtools widget vocabulary: '' / 'window' for the active window, or a
// `toplevel:N/child:M` path for ONE widget — capturing a single group beats growing the window,
// since a settings page is taller than any window a headless compositor grants.
//
// NOT wired into screenshot.sh yet: @gjsify/devtools 0.38.1 (this project's pin) accepts the
// argument and ignores it, returning the whole window — a hook that quietly does something else is
// worse than no hook. The fix is in gjsify main; wire it up when the pin catches up.
const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);

function shoot() {
    const reply = bus.call_sync(
        dest,
        path,
        'org.gjsify.Devtools',
        'Screenshot',
        GLib.Variant.new_tuple([GLib.Variant.new_string(scope || 'window')]),
        GLib.VariantType.new('(ay)'),
        Gio.DBusCallFlags.NONE,
        12000,
        null,
    );
    return reply.get_child_value(0).get_data_as_bytes();
}

// EMPTY BYTES ARE THE FAILURE SIGNAL, not an empty picture: the devtools service
// answers `ay[0]` when there is no active window or the window was never
// realized. Writing that produced a 0-byte "PNG", printed "wrote … (0 bytes)"
// and exited 0 — a screenshot workflow that reports success while the file it
// hands on is unopenable. Retry (the window may still be mid-layout), then fail
// loudly.
let bytes = shoot();
for (let attempt = 0; attempt < 8 && bytes.get_size() === 0; attempt++) {
    GLib.usleep(250_000);
    bytes = shoot();
}
if (bytes.get_size() === 0) {
    printerr(`dbus-shot: ${dest} returned no image — window absent or never realized`);
    system.exit(1);
}

Gio.File.new_for_path(out).replace_contents(
    bytes.get_data(),
    null,
    false,
    Gio.FileCreateFlags.REPLACE_DESTINATION,
    null,
);
// Report the PIXEL SIZE, read out of the PNG's own header.
//
// It is the one number about a screenshot that cannot be faked. The window's `default-width`
// property reads back whatever was last ASKED FOR, so a resize the compositor ignored still looks
// applied — that is how captures came out at 1100×760 while every check said 1280. A caller that
// wants a size can now compare against what is actually in the file.
const data = bytes.get_data();
const width = (data[16] << 24) | (data[17] << 16) | (data[18] << 8) | data[19];
const height = (data[20] << 24) | (data[21] << 16) | (data[22] << 8) | data[23];
print(`wrote ${out} (${bytes.get_size()} bytes, ${width}×${height})`);
