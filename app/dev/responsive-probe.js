// Judge ONE state of a running, devtools-enabled Steuererklärung at the window size it was started with.
//
//   gjs -m responsive-probe.js <dest> <object-path> <width> <height> <case> <out.png> [allow.json]
//
// Called by responsive-check.sh after every navigation. Prints one `problem: …` line per failure and a
// final `stats: {...}` line; exits 1 when there is any problem.
//
// What is asserted (the reasons are in responsive-check.sh):
//   1. the window really HAS the requested width — read from the window's own allocation and from the
//      PNG header, because `ResizeWindow` answers with what was asked for, not what the compositor gave
//   2. `ResizeWindow(w, h)` answers w (the control plane is alive and agrees)
//   3. no mapped widget is allocated less WIDTH than its minimum (`geometry.short`; viewports of
//      sideways-scrolling scrollers are meant to be narrower than their content and are skipped) and the dump is not cut
//      short (`truncated`) — a truncated dump would hide exactly the deep widgets this is looking for
//   4. phone (≤ 480 px): every row-action button and the overflow button is at least TOUCH_TARGET square
//      wide (≥ 481 px): there is no overflow button at all
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import system from 'system';

const [dest, path, widthArg, heightArg, caseId, out, allowPath] = ARGV;
const width = Number(widthArg);
const height = Number(heightArg);
const IFACE = 'org.gjsify.Devtools';
// Keep in step with TOUCH_TARGET in src/frontends/desktop/widgets/phone-rules.ts.
const TOUCH_TARGET = 48;
// Keep in step with the `max-width: 480px` rung of the window's `narrow` breakpoint.
const PHONE_MAX_WIDTH = 480;
// DumpTree truncates SILENTLY past its depth; the app's deepest widgets sit ~25 levels down.
const DEPTH = 80;

const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
const call = (method, args, replyType) =>
    bus.call_sync(
        dest,
        path,
        IFACE,
        method,
        GLib.Variant.new_tuple(args),
        GLib.VariantType.new(replyType),
        Gio.DBusCallFlags.NONE,
        150000,
        null,
    );

const problems = [];
const problem = (text) => problems.push(text);

/** Allowlist: [{ case?: regex, size?: "WxH", type, cssClass?, why }] — `why` is mandatory. */
let allow = [];
if (allowPath) {
    const [ok, bytes] = GLib.file_get_contents(allowPath);
    if (ok) allow = JSON.parse(new TextDecoder().decode(bytes));
    for (const entry of allow) {
        if (!entry.why || !entry.type) {
            printerr(`${allowPath}: every entry needs "type" and a one-line "why"`);
            system.exit(2);
        }
    }
}
const allowed = (node) =>
    allow.some(
        (e) =>
            e.type === node.type &&
            (!e.cssClass || (node.cssClasses ?? []).includes(e.cssClass)) &&
            (!e.size || e.size === `${width}x${height}`) &&
            (!e.case || new RegExp(e.case).test(caseId)),
    );

// 1+2: the size
const [resultWidth] = call(
    'ResizeWindow',
    [GLib.Variant.new_int32(width), GLib.Variant.new_int32(height)],
    '(ii)',
).deepUnpack();
if (resultWidth !== width) problem(`ResizeWindow answered width ${resultWidth}, asked for ${width}`);

const tree = JSON.parse(
    call('DumpTree', [GLib.Variant.new_string('window'), GLib.Variant.new_int32(DEPTH)], '(s)')
        .get_child_value(0)
        .get_string()[0],
);
const windowWidth = tree.geometry?.width;
if (windowWidth !== width)
    problem(`the window is ${windowWidth} px wide, asked for ${width} (its minimum width is above the request)`);

// 3+4: walk the tree
const phone = width <= PHONE_MAX_WIDTH;
const stats = { nodes: 0, rowActions: 0, overflow: 0, allowedShort: 0, scrollers: 0 };
let truncated = 0;
/** Does this viewport's scroller scroll SIDEWAYS (chip rows, tab strips)? Then a narrow viewport is the point. */
const scrollsSideways = (viewportPath) => {
    try {
        const parent = viewportPath.slice(0, viewportPath.lastIndexOf('/'));
        const reply = call(
            'GetProperty',
            [GLib.Variant.new_string(parent), GLib.Variant.new_string('hscrollbar-policy')],
            '(s)',
        );
        const policy = JSON.parse(reply.get_child_value(0).get_string()[0]);
        // Gtk.PolicyType: ALWAYS 0, AUTOMATIC 1, NEVER 2, EXTERNAL 3 — the name or the number, whichever the service sends.
        return !(policy === 2 || String(policy).toLowerCase() === 'never');
    } catch {
        return false;
    }
};
const walk = (node) => {
    stats.nodes++;
    if (node.truncated) truncated++;
    const mapped = node.mapped !== false && node.geometry;
    if (mapped) {
        // WIDTH only: a scroller's viewport is allocated less height than its content asks for by
        // design (that is what scrolling is). Less WIDTH than the minimum is the clipping we look for.
        if (node.geometry.short && node.geometry.width < node.geometry.widthRequest[0]) {
            if (node.type === 'GtkViewport' && scrollsSideways(node.path)) stats.scrollers++;
            else if (allowed(node)) stats.allowedShort++;
            else {
                const [minW, natW] = node.geometry.widthRequest;
                const [minH] = node.geometry.heightRequest;
                problem(
                    `short: ${node.type}${node.cssClasses?.length ? `.${node.cssClasses.join('.')}` : ''} at ${node.path} allocated ${node.geometry.width}×${node.geometry.height}, needs ≥ ${minW}×${minH} (nat ${natW})`,
                );
            }
        }
        const classes = node.cssClasses ?? [];
        const rowAction = classes.includes('row-action');
        const overflow = classes.includes('row-overflow');
        if (rowAction) stats.rowActions++;
        if (overflow) stats.overflow++;
        if (
            phone &&
            (rowAction || overflow) &&
            (node.geometry.width < TOUCH_TARGET || node.geometry.height < TOUCH_TARGET)
        )
            problem(
                `touch target: ${node.type}.${classes.join('.')} at ${node.path} is ${node.geometry.width}×${node.geometry.height}, under ${TOUCH_TARGET}`,
            );
        if (!phone && overflow)
            problem(`overflow menu button at ${node.path} on a ${width} px window — it belongs on phones only`);
    }
    for (const child of node.children ?? []) walk(child);
};
walk(tree);
if (truncated > 0) problem(`DumpTree is truncated at ${truncated} node(s) — raise DEPTH in responsive-probe.js`);

// the picture, and the width the PNG itself reports
const shoot = () =>
    call('Screenshot', [GLib.Variant.new_string('window')], '(ay)')
        .get_child_value(0)
        .get_data_as_bytes();
let bytes = shoot();
for (let attempt = 0; attempt < 8 && bytes.get_size() === 0; attempt++) {
    GLib.usleep(250_000);
    bytes = shoot();
}
if (bytes.get_size() === 0) problem('Screenshot returned no image');
else {
    Gio.File.new_for_path(out).replace_contents(
        bytes.get_data(),
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
    );
    const d = bytes.get_data();
    const pngWidth = (d[16] << 24) | (d[17] << 16) | (d[18] << 8) | d[19];
    if (pngWidth !== width) problem(`the screenshot is ${pngWidth} px wide, asked for ${width}`);
}

for (const p of problems) print(`problem: ${p}`);
print(`stats: ${JSON.stringify(stats)}`);
system.exit(problems.length > 0 ? 1 : 0);
