// Capture the compositor's monitor at its PHYSICAL resolution, through mutter's ScreenCast API.
//
//   gjs -m screencast-shot.js <out.png>
//
// Why not dbus-shot.js: @gjsify/devtools renders a widget at its LOGICAL size, so a headless-run
// --scale 2 session still yields a 1x picture. The monitor stream carries what a HiDPI screen shows.
// Needs the session bus of the headless-run session (mutter owns org.gnome.Mutter.ScreenCast there),
// a running pipewire and gst-launch-1.0 with pipewiresrc + pngenc.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const [out] = ARGV;
if (!out) {
    printerr('usage: screencast-shot.js <out.png>');
    imports.system.exit(2);
}

const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
const call = (path, iface, method, params, type) =>
    bus.call_sync('org.gnome.Mutter.ScreenCast', path, iface, method, params, GLib.VariantType.new(type), Gio.DBusCallFlags.NONE, 10000, null);

const session = call('/org/gnome/Mutter/ScreenCast', 'org.gnome.Mutter.ScreenCast', 'CreateSession', new GLib.Variant('(a{sv})', [{}]), '(o)').deepUnpack()[0];
const stream = call(session, 'org.gnome.Mutter.ScreenCast.Session', 'RecordMonitor', new GLib.Variant('(sa{sv})', ['Meta-0', {}]), '(o)').deepUnpack()[0];

const loop = GLib.MainLoop.new(null, false);
let node = null;
bus.signal_subscribe('org.gnome.Mutter.ScreenCast', 'org.gnome.Mutter.ScreenCast.Stream', 'PipeWireStreamAdded', stream, null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _n, params) => {
    node = params.deepUnpack()[0];
    loop.quit();
});
call(session, 'org.gnome.Mutter.ScreenCast.Session', 'Start', null, '()');
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => (loop.quit(), GLib.SOURCE_REMOVE));
loop.run();
if (node === null) {
    printerr('screencast-shot: no PipeWire stream appeared');
    imports.system.exit(1);
}

const gst = Gio.Subprocess.new(
    ['timeout', '15', 'gst-launch-1.0', '-q', 'pipewiresrc', `path=${node}`, 'num-buffers=15', '!', 'videoconvert', '!', 'pngenc', 'snapshot=false', '!', 'multifilesink', `location=${out}.%d.png`],
    Gio.SubprocessFlags.NONE,
);
gst.wait(null);
call(session, 'org.gnome.Mutter.ScreenCast.Session', 'Stop', null, '()');

// Keep the LAST frame: the first ones can predate the window's final paint.
let last = -1;
for (let i = 0; i < 15 && GLib.file_test(`${out}.${i}.png`, GLib.FileTest.EXISTS); i++) last = i;
if (last < 0) {
    printerr('screencast-shot: gstreamer wrote no frame');
    imports.system.exit(1);
}
Gio.File.new_for_path(`${out}.${last}.png`).move(Gio.File.new_for_path(out), Gio.FileCopyFlags.OVERWRITE, null, null);
for (let i = 0; i < 15; i++) GLib.unlink(`${out}.${i}.png`);
print(out);
