# Native GNOME app (`src/frontends/desktop`)

A native **GTK 4 + libadwaita** desktop front-end for the steuererklaerung review UI, built with the
[gjsify](https://github.com/gjsify) toolchain. It is a **sibling to the web review UI**
(`src/frontends/web`): both read the *same* backend, but this one renders with native Adwaita widgets
instead of `@gjsify/adwaita-web` web components. It is the first step toward a fully native
GJS/Adwaita port — see the memory note `adwaita-web-port` and `buchhaltung-gjs-port-status` (written before the rename).

The two front-ends **co-exist**: `gjsify run start` (CLI), `steuer web` (browser UI) and this
app are independent entry points over one store/services layer.

## Run

gjsify ships the whole toolchain (build · run · tsc · format · lint), so **no `npm`/Node is needed**
to build or run the app — `gjsify run <script>` executes the package.json scripts directly on GJS:

```bash
gjsify run build       # ALL bundles: CLI + native app + web client (stale-dist-safe)
gjsify run build:app   # only dist/steuer-app.gjs.mjs
gjsify run start:app   # gjsify run dist/steuer-app.gjs.mjs
gjsify run dev:app     # build:app + start:app
```

The same scripts exist at the **workspace root** (`gjsify run build` / `start:app` / `dev:app` /
`storybook` there delegate via `gjsify workspace steuererklaerung-cli …`), so every app variant starts
from the repo root too. In-workspace runs happen from the `app/` directory so the store,
`steuererklaerung.json` and `.env` resolve (same cwd contract as `steuer web`). Requires a desktop
session (Wayland/X) and the system GTK 4 / libadwaita typelibs — nothing is bundled.

## Architecture

```
main.ts          entry — dotenv + demo seed, then runAdwaitaApp (@gjsify/adwaita-app): runAsync
                 lifecycle + quit/about actions + env-gated devtools, createWindow → MainWindow
window.ts        Adw.ApplicationWindow — NavigationSplitView (sidebar nav + content stack),
                 entity card + year segments in the sidebar (widgets/); hosts ported views
                 (registry) + placeholders
widgets/         reusable custom widgets (BhToggleTabs, BhEntitySwitcher, BhYearSwitcher, chart) —
                 each ships a *.story.ts; `gjsify run storybook` opens the component browser
nav.ts           NAV_ITEMS + visibleNavItems() — same information architecture as the web UI
                 (src/frontends/web/client/components/bh-app.ts), with real Adwaita symbolic icons
entities.ts      thin re-export of the shared probe (src/core/presenters/workspace.ts):
                 AppEntity/AppWorkspace/loadAppWorkspace = EntityModel/WorkspaceModel/loadWorkspaceModel
data/session.ts  the one long-lived PresenterSession (workspace + per-entity config/DMS + memos)
view.ts          PortedView contract — a widget that reload(entity, year)s itself
views/registry.ts  view id → factory; views not listed fall back to a placeholder StatusPage
views/*.blp + *.ts native views (Blueprint chrome + programmatic data rows)
data/*.ts        per-view data loaders that call the backend actions directly (no HTTP)
constants.ts     app id (eu.jumplink.Steuererklaerung), name, version
blp.d.ts         ambient type for `import Template from './x.blp'`
```

### Backend reuse, not duplication

The web server (`src/frontends/web/server.ts`) is a thin HTTP shell over pure functions
(`@steuererklaerung/store`, `src/core/actions/elster/*`, `src/core/config/workspace.ts`, `src/core/presenters/year-snapshot.ts`,
`@steuererklaerung/dms`). The native app imports those **in-process** — the entity/year switchers
already run the same `resolveWorkspace` + year-probe the server runs at startup. Per-view data
(EÜR, transactions, documents, …) gets wired the same way, one view at a time; outbound fetches
(Paperless/Qonto) follow the server's deferral discipline (see `data.ts`).

## Porting a view

1. Add `data/<view>.ts` — call the backend action(s) directly, return a plain shape.
2. Add `views/<view>-view.blp` (static chrome) + `views/<view>-view.ts` (a `BhXView extends
   Adw.Bin` with `reload(entity, year)` that fills the data-driven parts).
3. Register it in `views/registry.ts`. Done — the window now shows it instead of the placeholder.

**Dev hooks** (handy for testing a view headlessly):
- `STEUER_APP_VIEW=<view-id>` — open straight to that view.
- `STEUER_APP_ENTITY=<entity-id>` — start on that entity (e.g. `gbr` has an ELSTER config for Steuer).
- `STEUER_APP_YEAR=<year>` — start on that year (if the entity has data for it), else its default year.
- `STEUER_APP_DEBUG=1` — log a one-line summary when a view finishes loading.
- `STEUER_APP_ASK="…"` — (Assistent) auto-send a question on open.

## Adwaita-Fallen, aus Screenshots gelernt

Jede hier kostete mindestens einen Screenshot-Durchlauf, und keine ist am Code zu sehen.

**Ein `header_suffix` mit mehr als einem Knopf frisst den Kopf der Gruppe.** Bei 1280 px mit
angedocktem Assistenten fehlt der Kopfzeile Breite, und GTK holt sie sich vom TITEL: erst umbricht
er auf ein Zeichen pro Zeile (`A-k-t-i-o-n-e-n`), erzwingt man eine Zeile, wird er zu einem blanken
`…`. Zweimal unabhängig zugeschlagen — in der Absende-Sektion (sechs Aktionsknöpfe) und in den
Rechnungen (Filter-Chips + „Neue Rechnung"). Abhilfe: eine Werkzeugleiste ÜBER der Gruppe, oder die
Zeile ohne Titel lassen, wenn die Knöpfe sich selbst benennen.

**Ein Banner am Ende einer `Adw.PreferencesPage` liegt unter der Falz.** Ein Dialog ist nur so hoch
wie sein Inhalt; eine Meldung, die man erst scrollen muss, ist keine. Banner nach oben.

**`ResizeWindow` ist eine Bitte, keine Zusage.** Der Aufruf antwortet mit der erfragten Größe, und
`default-width` liest genau diese Zahl zurück — auch wenn das Fenster gemappt ist und sie ignoriert.
Deshalb setzt `STEUER_APP_SIZE` die Größe VOR dem Mappen, und `dbus-shot.js` meldet die Pixelmaße
aus dem PNG-Header: die einzige Zahl über einen Screenshot, die sich nicht fälschen lässt.

**Popover werden nicht aufgenommen.** Die Devtools rendern die Fenster-Oberfläche; ein Popover ist
eine eigene. Was auf einem Screenshot zu sehen sein muss, gehört in einen `Adw.Dialog` oder inline.

## Status / roadmap

**All twelve nav views are ported to native widgets:**

| View | Source | I/O |
|------|--------|-----|
| Assistent | LLM Q&A (`answer` + YearCache) | outbound (model + cache) |
| Transaktionen | `searchAccountKeys` | store |
| Belege (Dokumente) | DMS `list` | store / Paperless |
| Offene Belege | aggregate detail + DMS links | store / Paperless |
| Rechnungen | `recurringDashboard` + `listOutgoingInvoices` | store + outbound (Qonto) |
| Kontakte | `listEntityContacts` | store |
| Projekte | `listProjects` + `addProject` / `updateProject` / `removeProject`; `loadProjektAnsicht` (Ergebnis, Kosten, Regeln) | manifest + store |
| Steuer/EÜR | `euerReportByTransactions` | store + Paperless |
| Auswertungen (BWA) | `computeBwa` on the aggregate | store + Paperless |
| Einblicke | `computeHinweise` (aggregate-derived) | store + Paperless |
| Zahlungen (Steuerkonto) | `steuerkontoReport` | store |
| Konten | `listConnections` | store |
| Einstellungen | `loadAppSettings` / `saveAppSettings` | filesystem (functional toggles) |

The **Beleg-Eingang** is the first full write flow (v3 redesign): a guided split view that links,
classifies (accept/override via the shared `confirmBelegDecision` core action, incl. the Paperless
`ki-uberarbeitet`/`accounting_category` mark-up), steps the queue with ←/→ + Enter and undoes via
toast; the Offen tab batch-links unambiguous receipts ("Automatisch zuordnen", dry-run preview).
Still deferred: Konten import/sync/connect, Beleg upload and Beleg thumbnails/inline-preview
(the confirm flow opens the original via the system handler instead). Some Einblicke hints
(USt/GewSt/Beleg-gap/Frist) need extra sub-results and will follow.

- **Later:** the **Rechnungen** + **Einstellungen** views; the deferred write paths; multi-turn
  Assistent; migrate the window chrome to Blueprint too; GResource + GSettings (window state); a
  `.desktop`/metainfo + Flatpak manifest; a `steuer app` CLI launcher.

> **UI definition: Blueprint `.blp`** for static structure, programmatic TS for data-driven rows
> (`gjsify build --app gjs` runs `@gjsify/vite-plugin-blueprint`; `blueprint-compiler` is required).
