# Android spike — the real window on a real GObject runtime

Phase P1 of the Android roadmap. Question: does the app's own Blueprint (`window.blp`,
`assistent-panel.blp`, `year-switcher.blp`) build through `@gjsify/adwaita-nativescript` on
Android, and does the breakpoint ladder switch? Input list for the work: [target-gap.md](target-gap.md).

## What was built

`app-android/` is a standalone NativeScript project (not part of the workspaces yet; that
decision falls in P4). It compiles the three `.blp` files with the Vite blueprint plugin and
builds them at runtime with `build()` / `buildInto()`. Packages `^0.64.40`; no GTK payload,
because route D renders through NativeScript views. `BhEntitySwitcher` is an empty `Adw.Bin`
stub; the window has no data.

## Measured (emulator `NsGi_API_36`, x86_64, API 36)

| | |
|---|---|
| Bundle | `bundle.mjs` 2.8 MB, 686 modules, `ns build` about 30 s |
| Native | `libnode_gi.so` for `arm64-v8a` and `x86_64` in the APK |
| Cold start | `am start -W` TotalTime 1.0 to 1.4 s |
| Log | no `no member`, no `FATAL`, no `TNS.Native: Error` after the cuts below |
| Breakpoints | phone portrait 1080x2400@420: content + menu button; landscape 2400x1080: menu + assistant star; tablet 2560x1600: both sidebars + assistant panel with real text |

The Samsung S9 was not used: installing the spike there is a new action, and the emulator
covers the question. A device run stays a gate for the route-D PRs (ADR 0134).

## Gaps the builder refuses

The builder throws on anything that "reaches nothing" instead of dropping it silently. Each
gap below was measured one at a time; the spike cuts it in `app-android/app/views/main.ts`
(`KNOWN_GAPS`, logged as `SPIKE gaps cut: …`).

| # | Gap | Where | Owner |
|---|---|---|---|
| 1 | `Gtk.DropDown:enable-search` is absent in the port (the action sheet has no search field) | `year-switcher.blp` | Line removed; GTK default is `false`, desktop unchanged |
| 2 | `Gtk.MenuButton.child` (context chip with its own popover) | `window.blp` ~188 | P3, gjsify widget |
| 3 | `Adw.ToastOverlay.child`: the class has a `child` setter but no `builderSlots` | `window.blp` ~264 | P3 quick fix in gjsify: `builderSlotsOf(['child'], 'child')` as `AdwBin` does, with a test |
| 4 | `Gtk.Image` takes no style classes (`styles ["accent"]`) | `assistent-panel.blp:25` | P3, gjsify widget |
| 5 | `bind … bidirectional` needs a template instance (`build({ template })`) | `window.blp:250` | P4: the window must be a class, not a bare tree |
| 6 | Handler bindings (`clicked => $_onCloseClicked()`) need `scope` | `assistent-panel.blp:44,111,121` | App code in P4 |
| 7 | A placeholder image next to the star, probably a missing icon in the bundled icon set (not verified) | assistant panel | P3, check icons |

## Consequences for the roadmap

- P3 starts with the two quick fixes (3, then 2 and 4), then enum export (`Gtk.Align`,
  `Gtk.Orientation`, `Adw.ResponseAppearance`), then `Adw.BreakpointBin`.
- P4 builds the window as a template class (5, 6) and decides the workspace layout.
- Before the first enum PR: spike whether a numeric enum and the port's string value agree on
  route D.

## P4 step 1: emulator findings and their causes

Measured on `NsGi_API_36` (2560x1600, 2 dp = 1 px scale 2.0), screenshots before/after in `/tmp`.

| Finding | Cause | Fix |
|---|---|---|
| Flat buttons, sidebar rows without padding, icons over text | The app never loaded the Adwaita stylesheet (no `app.css`) | `app/app.css` imports `~/adwaita.css`; `sync:theme` copies it out of `@gjsify/adwaita-nativescript` before `build`/`start` (the copy is gitignored). Commit `bca932ed` |
| `Adw.EntryRow` titles missing | gjsify core: the large placeholder title (`empty_title`) was never given the row's title; `_applyLabels` filled only the small label | gjsify PR #2679 (auto-merge) |
| Popover top-left over the status bar | gjsify core, two defects: the card sat in a star cell and measured 1484 dp wide (child 184 dp), and its margins, written after the first layout pass, were ignored on Android | gjsify PR #2680 (auto-merge): auto cells + `translateX/Y`. Anchor rect was correct (130, 79, 34x34) |

Re-measured on the emulator with both core fixes merged locally into `gjsify-dev`: titles
"Paperless address" / "API token" show, and the entity popover opens centred below the avatar.
Until #2679/#2680 are released the app depends on the `gjsify-dev` link; the pins stay 0.64.44.
