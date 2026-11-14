# Android port — what the NativeScript target does not cover yet

Measured, not estimated: `report-target-gap` from gjsify (commit `3b4b476b0d`) run against
`app/` on 2026-11-14. It holds the app's Blueprint templates and every `gi://` use in the
sources against the **pure-JS NativeScript barrel** (`@gjsify/adwaita-nativescript`,
`src/namespace/{adw,gtk,…}.ts`). This is the Android port's input list; the order of work is the
roadmap in the werkstatt hub (phases P1–P4).

Reproduce (from a gjsify checkout):

```sh
node scripts/report-target-gap.mjs <path-to>/steuererklaerung/app --json
```

**Read this caveat first.** The barrel is the pure-JS twin. On Android the default engine is real
GObject/Gio/GLib (gjsify ADR 0110), so the `GLib.*` and `Gio.*` rows below may already be satisfied
by the real engine. That is **unverified** until a device run; treat them as "check", not "missing".
The widget and enum rows are real gaps of the barrel itself.

## Totals

| | |
|---|---|
| Blueprints | 32, all project onto both targets; **20 build on NativeScript, 12 do not** |
| Source files with `gi://` | 116, of which 26 are clean on NativeScript |
| Namespaces without any NativeScript renderer | `Pango` (`EllipsizeMode` ×10, `WrapMode` ×2) |

## Blueprints that do not build on NativeScript

Each lists the tag the target lacks. Nothing is *refused* and nothing is *lost*; every failure is a
missing widget.

| Blueprint | Missing tag |
|---|---|
| `views/beleg-eingang-view.blp` | `AdwBreakpointBin`, `GtkProgressBar` |
| `views/zu-pruefen-view.blp` | `AdwBreakpointBin`, `GtkProgressBar` |
| `views/kontakte-view.blp` | `AdwBreakpointBin` |
| `views/laufende-kosten-view.blp` | `AdwBreakpointBin` |
| `views/rechnungen-view.blp` | `AdwBreakpointBin` |
| `views/vertraege-view.blp` | `AdwBreakpointBin` |
| `views/zeiten-view.blp` | `AdwBreakpointBin` |
| `views/auswertungen-view.blp` | `GtkFlowBox` |
| `views/transactions-view.blp` | `GtkSearchEntry` |
| `lotsman-panel.blp` | `GtkLinkButton` |
| `widgets/entity-switcher.blp` | `GtkPopover` |
| `widgets/glossary-help.blp` | `GtkPopover` |

Per widget: `AdwBreakpointBin` ×7 · `GtkPopover` ×2 · `GtkProgressBar` ×2 · `GtkFlowBox` ×1 ·
`GtkLinkButton` ×1 · `GtkSearchEntry` ×1.

`AdwBreakpointBin` is the expensive one: it has no NativeScript widget at all. gjsify's
`status/open-todos/adwaita-ports.md` names the missing pieces (a size source bound to the bin's own
allocation, and the tree surgery). The phone layout of seven views depends on it.

## Source uses the barrel does not export

Uses / files. **Enums come first because they are the largest block.**

**Enums, exported by the barrel as values: none of these.** The widgets take their string forms
(`'horizontal'`), so app code that writes `Gtk.Orientation.VERTICAL` gets `undefined`.

| Member | Uses / files |
|---|---|
| `Gtk.Align` | 240 / 61 |
| `Gtk.Orientation` | 112 / 42 |
| `Adw.ResponseAppearance` | 15 / 12 |
| `Gtk.SelectionMode` | 9 / 5 |
| `Gtk.Justification` | 7 / 4 |
| `Gtk.WrapMode` | 4 / 4 |
| `Adw.JustifyMode`, `Gtk.InputPurpose` | 2 / 2 each |
| `Gtk.StackTransitionType`, `Gtk.NaturalWrapMode`, `Gtk.SizeGroupMode`, `GObject.BindingFlags` | 1 each |

**Widgets and controllers**

`Gtk.FlowBox` (6/4) · `Gtk.UriLauncher` (5/5) · `Gtk.FileLauncher` (4/4) · `Gtk.ListBoxRow` (4/3) ·
`Gtk.LinkButton` (3/3) · `Gtk.Popover` (3/3) · `Gtk.EventControllerFocus` (3/2) · `Gtk.Text` (2/2) ·
`Adw.ShortcutsSection` (2/1) · `Adw.ShortcutsItem` (2/1) · `Adw.ShortcutsDialog` (1/1) ·
`Gtk.LevelBar` · `Gtk.PasswordEntry` · `Gtk.SizeGroup` · `Gtk.Spinner` (1 each). Type-only:
`Gtk.Widget`, `Adw.Breakpoint`, `Adw.BreakpointBin`, `Gtk.ProgressBar`, `Gtk.SearchEntry`.

**Key constants:** `Gdk.KEY_KP_Enter` (2/2).

**Platform (`Gio` / `GLib`; check against the real engine)**

- D-Bus: `Gio.bus_get_sync` (6/6), `Gio.BusType` (6/6), `Gio.DBusCallFlags` (7/6),
  `Gio.DBusSignalFlags`, `GLib.VariantType` (9/7)
- Processes: `Gio.Subprocess`, `Gio.SubprocessLauncher`, `Gio.SubprocessFlags`
- Files: `GLib.file_set_contents` (3), `GLib.file_get_contents`, `GLib.file_test` +
  `GLib.FileTest`, `GLib.mkdir_with_parents`, `GLib.unlink`, `GLib.get_user_cache_dir`,
  `GLib.path_get_dirname`, `Gio.FileCopyFlags`
- Sockets and streams: `Gio.SocketClient`, `Gio.InputStream`
- Main loop and time: `GLib.timeout_add_seconds` (3), `GLib.Source`, `GLib.MainLoop`, `GLib.usleep`,
  `GLib.get_monotonic_time`
- Other: `GLib.find_program_in_path`, `GLib.get_home_dir`, `GLib.get_real_name`,
  `GLib.get_user_name`, `Gio.SettingsSchemaSource`

The D-Bus and subprocess rows belong to desktop-only features (assistant, MCP, self-restart) that
the v1 Android build does not carry; they decide *which files* the `.android.ts` split has to cover,
not which APIs gjsify has to add.

## What this means for the phases

1. **P1 spike** needs a window whose Blueprint builds: `assistent-panel.blp` already does.
2. **P3** closes, in this order: enum values (`Align`, `Orientation`, …: one export, 350+ uses),
   `AdwBreakpointBin` (seven views), then `GtkPopover`, `GtkProgressBar`, `GtkFlowBox`,
   `GtkSearchEntry`, `GtkLinkButton`.
3. **P4** splits the desktop-only files with `.android.ts` suffixes; the D-Bus / subprocess rows
   above are the list.
