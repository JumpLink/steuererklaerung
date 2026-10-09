/**
 * Shared helpers for the native views (loading/stack handling, row tracking, label formatting).
 *
 * Every ported view follows the same shape: a `Gtk.Stack` with loading / error / content pages,
 * filled by clearing-and-re-adding rows into `Adw.PreferencesGroup`s on each `reload`. These
 * helpers capture that so the view classes stay about their data.
 */

import type Adw from '@girs/adw-1';
import Gtk from '@girs/gtk-4.0';
import Gio from '@girs/gio-2.0';
import GLib from '@girs/glib-2.0';
import { showToast } from '../toast.ts';
import { isDmsUnsupported, isManifestMissing, isPaperlessSetupRequired } from '../../../core/lib/errors.ts';
import { navigateTo } from '../nav.ts';
import { BhGlossaryHelp, lernmodusOn } from '../widgets/glossary-help.ts';

/** Escape a plain string for the Pango-markup labels Adwaita rows / status pages use. */
export function markup(text: string): string {
    return GLib.markup_escape_text(text, -1);
}

/**
 * Who is operating this app — recorded as the author of a decision that the store keeps forever
 * (a sign-off's `signedBy`, a manual reclassification's `decidedBy`).
 *
 * A desktop app has exactly one person in front of it, so the desktop session IS the answer; the
 * CLI asks for it explicitly (`--by`) because a script has no such person. It used to be a
 * compiled-in first name, which stamped one developer's name onto every user's audit trail.
 */
export function currentOperator(): string {
    return GLib.get_real_name() || GLib.get_user_name() || 'unbekannt';
}

/**
 * Save already-rendered bytes (PDF Prüf-Datenblatt or USt-VA XML) via a native Save-As dialog:
 * write to the app cache, then copy to the chosen destination and toast. Shared by the Steuer,
 * Steuererklärungs-Assistent + USt-VA views so the export glue lives in one place. `widget`
 * provides the toplevel window for the dialog.
 */
export function saveFileViaDialog(widget: Gtk.Widget, filename: string, bytes: Uint8Array, toastLabel: string): void {
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'steuererklaerung', 'steuer']);
    GLib.mkdir_with_parents(dir, 0o755);
    const path = GLib.build_filenamev([dir, filename]);
    GLib.file_set_contents(path, bytes);
    const dialog = new Gtk.FileDialog({ initialName: filename });
    dialog.save(widget.get_root() as Gtk.Window | null, null, (_s, res) => {
        try {
            const dest = dialog.save_finish(res);
            if (dest) {
                Gio.File.new_for_path(path).copy(dest, Gio.FileCopyFlags.OVERWRITE, null, null);
                showToast(`${toastLabel} gespeichert`);
            }
        } catch {
            /* user cancelled the save dialog */
        }
    });
}

/** Month abbreviations, 1-based (index 0 unused) — shared kernel constant. */
export { MONTHS } from '../../../core/lib/format.ts';

/** A right-aligned, tabular amount label, optionally accented (success/error) + emphasised. */
export function amountLabel(value: string, opts: { accent?: 'success' | 'error'; heading?: boolean } = {}): Gtk.Label {
    const classes = ['numeric'];
    if (opts.accent) classes.push(opts.accent);
    if (opts.heading) classes.push('heading');
    return new Gtk.Label({ label: value, cssClasses: classes, valign: Gtk.Align.CENTER });
}

/** One KPI card's data (a headline metric the design shows as a card, not a list row). */
export interface Kpi {
    label: string;
    value: string;
    accent?: 'success' | 'error';
    sub?: string;
    /**
     * Glossary term explained by a "?" beside the label, when Lernmodus is on.
     *
     * A KPI label IS the technical term — "Rohertrag", "Betriebsergebnis" — so this is where a
     * stranger needs the explanation, not in a manual they would have to know to look for.
     */
    help?: string;
}

/** A single Adwaita `.card` KPI tile: dim label · big tabular value (optionally accented) · sub. */
export function kpiCard(k: Kpi): Gtk.Widget {
    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 4,
        marginTop: 14,
        marginBottom: 14,
        marginStart: 16,
        marginEnd: 16,
    });
    const label = new Gtk.Label({ label: k.label, xalign: 0, cssClasses: ['dim-label', 'caption'] });
    if (k.help) {
        const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4 });
        row.append(label);
        row.append(new BhGlossaryHelp(k.help, lernmodusOn()));
        content.append(row);
    } else {
        content.append(label);
    }
    content.append(
        new Gtk.Label({
            label: k.value,
            xalign: 0,
            halign: Gtk.Align.START,
            cssClasses: ['title-2', 'numeric', ...(k.accent ? [k.accent] : [])],
        }),
    );
    if (k.sub) content.append(new Gtk.Label({ label: k.sub, xalign: 0, cssClasses: ['dim-label', 'caption'] }));
    const card = new Gtk.Box({ cssClasses: ['card'] });
    card.append(content);
    return card;
}

/** A responsive row of KPI cards (design's leading metric row) — 1-up narrow, up to `max`-up wide. */
export function kpiFlow(kpis: Kpi[], max = 4): Gtk.Widget {
    const fb = new Gtk.FlowBox({
        selectionMode: Gtk.SelectionMode.NONE,
        homogeneous: true,
        minChildrenPerLine: 1,
        maxChildrenPerLine: max,
        columnSpacing: 12,
        rowSpacing: 12,
        activateOnSingleClick: false,
    });
    for (const k of kpis) fb.append(kpiCard(k));
    return fb;
}

/**
 * Tracks the rows appended to an `Adw.PreferencesGroup` so a reload can clear them
 * (PreferencesGroup has no "remove all"). `add` returns the row for convenience.
 */
export class GroupRows {
    private rows: Gtk.Widget[] = [];

    constructor(private readonly group: Adw.PreferencesGroup) {}

    add<T extends Gtk.Widget>(row: T): T {
        this.group.add(row);
        this.rows.push(row);
        return row;
    }

    clear(): void {
        for (const row of this.rows) this.group.remove(row);
        this.rows = [];
    }
}

/**
 * The "there is nothing here" state — with the thing to do about it.
 *
 * Every list in the app answered emptiness with one grey row: `Keine Buchungen in dieser Ansicht`.
 * That is accurate and useless. It reads the same on the first launch, when the answer is "connect
 * an account", as it does under a filter that matched nothing, when the answer is "widen the
 * filter" — and on a fresh install the app is ALL empty lists, so a stranger meets a wall of grey
 * rows telling them nothing is there and nothing else.
 *
 * Deliberately not an `Adw.StatusPage`: inside a PreferencesGroup that renders as a full-height
 * hero where a list row is expected. This is the compact form — icon, headline, one sentence, at
 * most one button.
 */
export function emptyState(opts: {
    icon: string;
    title: string;
    description: string;
    action?: { label: string; run: () => void };
}): Gtk.Widget {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        marginTop: 28,
        marginBottom: 28,
        marginStart: 12,
        marginEnd: 12,
        halign: Gtk.Align.CENTER,
    });
    const image = new Gtk.Image({ iconName: opts.icon, pixelSize: 40 });
    image.add_css_class('dim-label');
    box.append(image);
    box.append(
        new Gtk.Label({
            label: markup(opts.title),
            cssClasses: ['title-4'],
            wrap: true,
            justify: Gtk.Justification.CENTER,
        }),
    );
    box.append(
        new Gtk.Label({
            label: markup(opts.description),
            cssClasses: ['dim-label'],
            wrap: true,
            justify: Gtk.Justification.CENTER,
            maxWidthChars: 44,
        }),
    );
    if (opts.action) {
        const button = new Gtk.Button({ label: opts.action.label, halign: Gtk.Align.CENTER, marginTop: 6 });
        button.add_css_class('pill');
        button.add_css_class('suggested-action');
        button.connect('clicked', opts.action.run);
        box.append(button);
    }
    return box;
}

/**
 * `STEUER_APP_SCROLL=end|0..1` (dev/testing hook): scroll a view after it is built.
 *
 * Views in this app are routinely taller than any window a headless compositor grants, so their
 * lower half is not screenshottable at all otherwise — and "capture one widget" is unavailable
 * until the @gjsify/devtools pin catches up with the scope-reading fix.
 *
 * On idle, because the content has just been appended and the adjustment's upper bound is only
 * correct once it has been allocated.
 */
export function applyScrollHook(scroller: Gtk.ScrolledWindow): void {
    const raw = process.env.STEUER_APP_SCROLL;
    if (!raw) return;
    const fraction = raw === 'end' ? 1 : Number.parseFloat(raw);
    if (!Number.isFinite(fraction)) {
        console.error(`[app] STEUER_APP_SCROLL="${raw}" ist weder "end" noch eine Zahl zwischen 0 und 1.`);
        return;
    }
    GLib.idle_add(GLib.PRIORITY_LOW, () => {
        const adj = scroller.get_vadjustment();
        adj.set_value(Math.max(0, Math.min(1, fraction)) * (adj.get_upper() - adj.get_page_size()));
        return GLib.SOURCE_REMOVE;
    });
}

/**
 * `STEUER_APP_SCROLL=<name>` (dev/testing hook): scroll the nearest scroller so `widget` sits at its top —
 * for a section that loads after its view, where `end` or a fraction lands somewhere else. A short delay
 * rather than idle: the section is appended after an async load and needs its allocation first.
 */
export function applyScrollToHook(widget: Gtk.Widget, name: string): void {
    if (process.env.STEUER_APP_SCROLL !== name) return;
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        const scroller = widget.get_ancestor(Gtk.ScrolledWindow.$gtype) as Gtk.ScrolledWindow | null;
        const content = scroller?.get_child();
        if (scroller && content) {
            const [ok, rect] = widget.compute_bounds(content);
            if (ok) scroller.get_vadjustment().set_value(Math.max(0, rect.get_y() - 12));
        }
        return GLib.SOURCE_REMOVE;
    });
}

/** Monotonic token so a slow load that resolves after the entity/year changed is ignored. */
export class LoadToken {
    private n = 0;
    next(): number {
        return ++this.n;
    }
    get current(): number {
        return this.n;
    }
}

/**
 * Drive a view's loading → content/error transition for one `reload`.
 *
 * Shows the `loading` page, runs `load` (sync or async — sync throws are caught too), and on
 * success fills + shows `content`. A stale result (a newer reload bumped the token) is dropped.
 * On failure it logs `[app] <errorContext>: …`, shows the `error` page with the message, and keeps
 * the app running.
 *
 * Requires the app's main loop to be driven by `Adw.Application.runAsync()` (see app/main.ts): under
 * the synchronous `run()` the GJS promise-job queue isn't flushed for a purely synchronous load, so
 * the `.then` below would never fire and the view would hang on its spinner.
 */
export function loadIntoStack<T>(opts: {
    stack: Gtk.Stack;
    errorPage: Adw.StatusPage;
    token: LoadToken;
    errorContext: string;
    load: () => Promise<T> | T;
    fill: (data: T) => void;
}): void {
    opts.stack.set_visible_child_name('loading');
    const token = opts.token.next();
    Promise.resolve()
        .then(opts.load)
        .then((data) => {
            if (token !== opts.token.current) return; // superseded by a newer reload
            opts.fill(data);
            opts.stack.set_visible_child_name('content');
        })
        .catch((err: unknown) => {
            if (token !== opts.token.current) return;
            console.error(`[app] ${opts.errorContext}: ${err instanceof Error ? err.message : err}`);
            // The retry re-runs THIS call with the same opts, so the button is available on every
            // failure without a single view having to wire one. Most failures here are a timed-out
            // Paperless fetch or a network blip; the answer to those is "try again", and an error
            // page whose only option is to navigate away makes the user rebuild their context to
            // ask the same question a second time.
            applyRemedy(opts.errorPage, err, () => loadIntoStack(opts));
            opts.stack.set_visible_child_name('error');
        });
}

/**
 * A failure the user can actually do something about, and the door that does it.
 *
 * Error text used to reach the status page verbatim — including messages written for a terminal,
 * which is how "Run \"paperless setup-fields\" to create and register IDs" ended up as the whole
 * answer the app gave on its USt-VA tab. A GUI naming a command line is a dead end: the remedy
 * exists, it just has no door.
 *
 * Sitting in {@link loadIntoStack} rather than in one view, because all 19 loading views route
 * their failures through it — a condition recognised here is answered everywhere at once.
 */
interface ErrorRemedy {
    title: string;
    description: string;
    action?: { label: string; run: (from: Gtk.Widget) => void };
}

/** Map a thrown value to what the status page should say and offer. */
function remedyFor(err: unknown): ErrorRemedy | null {
    if (isManifestMissing(err)) {
        return {
            title: 'Noch nicht eingerichtet',
            description:
                'Es gibt noch keine Konfiguration. Der Assistent legt sie an — Entität, Steuernummer ' +
                'und wo die Daten liegen sollen.',
            action: { label: 'Einrichtung starten', run: (from) => from.activate_action('win.setup', null) },
        };
    }
    if (isDmsUnsupported(err)) {
        return {
            title: `${err.capability} braucht Paperless`,
            description: `${err.message} Die Beleg-Verwaltung lässt sich in den Einstellungen umstellen.`,
            action: { label: 'Zu den Einstellungen', run: (from) => navigateTo(from, 'settings') },
        };
    }
    if (isPaperlessSetupRequired(err)) {
        return {
            title: 'Paperless ist noch nicht eingerichtet',
            description:
                'In Paperless fehlen die Dokumenttypen und Zusatzfelder, aus denen die Zahlen gelesen werden. ' +
                'Sie lassen sich in den Einstellungen anlegen.',
            action: { label: 'Zu den Einstellungen', run: (from) => navigateTo(from, 'settings') },
        };
    }
    return null;
}

/**
 * The status page's own title, kept so a remedy can borrow the headline and give it back.
 *
 * Views word their error page themselves ("Fristen konnten nicht geladen werden"); a remedy that
 * overwrote that with a fixed string would make every later, unrelated failure wear the wrong
 * headline. Captured on first use, restored whenever no remedy applies.
 */
const originalTitle = new WeakMap<Adw.StatusPage, string>();

/**
 * Put the failure on the status page — with its door when there is one.
 *
 * The title and the child are RESET on every call, not only set: a status page is reused across
 * reloads, so a leftover "Zu den Einstellungen" button under an unrelated network error would send
 * the user somewhere that cannot help.
 */
export function applyRemedy(page: Adw.StatusPage, err: unknown, retry?: () => void): void {
    const message = err instanceof Error ? err.message : String(err);
    const remedy = remedyFor(err);
    if (!originalTitle.has(page)) originalTitle.set(page, page.get_title() ?? 'Konnte nicht laden');
    // StatusPage.description is parsed as Pango markup (no use-markup toggle) — escape it.
    page.set_description(markup(remedy ? remedy.description : message));
    page.set_title(remedy ? remedy.title : (originalTitle.get(page) ?? 'Konnte nicht laden'));

    const buttons: Gtk.Button[] = [];
    if (remedy?.action) {
        const { label, run } = remedy.action;
        const button = new Gtk.Button({ label });
        button.add_css_class('pill');
        button.add_css_class('suggested-action');
        button.connect('clicked', () => run(page));
        buttons.push(button);
    }
    // Not offered next to a remedy that FIXES the cause: retrying a Paperless setup that has not
    // happened yet just reproduces the same error, and two buttons of which one is known useless
    // is worse than one.
    if (retry && !remedy?.action) {
        const again = new Gtk.Button({ label: 'Erneut versuchen' });
        again.add_css_class('pill');
        again.add_css_class('suggested-action');
        again.connect('clicked', retry);
        buttons.push(again);
    }
    if (buttons.length === 0) {
        page.set_child(null);
        return;
    }
    const row = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 12, halign: Gtk.Align.CENTER });
    for (const b of buttons) row.append(b);
    page.set_child(row);
}
