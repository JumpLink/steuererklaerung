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
- `STEUER_DEBUG_MEASURE=<px>` — print every widget whose minimum width exceeds `<px>`, see below.
- `STEUER_DEBUG_MEASURE_DELAY=<ms>` — when that walk runs (default 4000).

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

## Schmale Fenster (Telefon, 360 px)

**Die Mindestbreite des Fensters ist das Maximum über ALLE Seiten des Stacks**, nicht über die
sichtbare. Ein `Gtk.Stack` misst auch die Seiten, die niemand ansieht — eine einzige Filterleiste,
die nicht unter 605 px konnte, machte das ganze Fenster 605 px breit, auf jeder Ansicht. Ein
360-px-Fenster zeichnete den Inhalt dann abgeschnitten: der Kopfleiste fehlten die Knöpfe, dem
Banner der Text, jede Liste lief rechts aus dem Bild. Deshalb repariert man hier **nie die Ansicht,
auf der es auffällt**, sondern die Seite, die den Boden setzt.

Das Prinzip aller Korrekturen: aus „besteht auf" ein „hätte gern" machen. Die NATÜRLICHE Größe
bleibt gleich, der Desktop liegt also Pixel für Pixel wie vorher — GTK bekommt nur einen Weg nach
unten. Die Werkzeuge dafür stehen in `widgets/responsive.ts` (`chipScroller`, `rowActions`,
`wrappingLabel`, `wrapButtonLabel`, `pinNaturalWidth`), die Dokumentation steht jeweils an der
Funktion.

**`wrap: true` allein ändert BEIDE Enden.** Ein umbrechendes `Gtk.Label` meldet mit der Vorgabe
`natural-wrap-mode: inherit` die umgebrochene Breite auch als seine natürliche — die Beschriftung
hört also nicht nur auf zu bestehen, sie hört auf zu fragen. Sichtbar wurde das auf dem Desktop: die
Assistenz-Spalte fiel von 424 px auf 320 px, weil ihre Vorschlags-Pillen keine Zeile mehr für sich
verlangten. Deshalb immer `natural-wrap-mode: none` dazu (in TS: `wrappingLabel`), und **nie
`max-width-chars` als Umbruch-Hilfe** — das deckelt genau die natürliche Breite, die gleich bleiben
soll. Bei `Gtk.Entry` ist es umgekehrt herum richtig: `width-chars` ist das Minimum,
`max-width-chars` hält die natürliche Desktop-Breite.

**`STEUER_DEBUG_MEASURE=<px>`** läuft den Widget-Baum ab und meldet jedes Widget, dessen Minimum
über `<px>` liegt, mit Pfad und zugeteilter Breite (`window.ts`). Drei Fallen, jede hat einmal
„alles sauber" gemeldet, während die Screenshots sichtbar abgeschnitten waren:

1. **Die Ausgabe geht nach `/tmp/steuer-shot.log`**, nicht auf die stdout des Screenshot-Rigs — das
   Rig startet die App als eigene Sitzung und leitet sie dorthin um.
2. **Zu früh gemessen ist nichts gemessen.** Die Listen laden asynchron; vor dem Laden ist jede
   Ansicht leer und damit schmal. Darum `STEUER_DEBUG_MEASURE_DELAY` (Vorgabe 4000 ms).
3. **Das Rig beendet die App nach `STEUER_SHOT_SETTLE`.** Ist die Wartezeit kürzer als der Delay,
   kommt der Lauf nie dazu, etwas zu schreiben — und ein leeres Protokoll liest sich wie „sauber".
   Settle MUSS den Delay überdauern.

Gelesen wird eine `[measure]`-Zeile so: `alloc > 360` oder `min > alloc` heißt wirklich
abgeschnitten. Ein großes `min` INNERHALB eines `chipScroller` ist dagegen in Ordnung — das scrollt.

**Ein Viewport gibt dem Kind sein MINIMUM, nicht seine natürliche Breite.** Darum scrollt eine Reihe
schlichter Knöpfe von allein (ohne `ellipsize` ist Minimum = natürlich), ein
`Adw.InlineViewSwitcher` aber nicht: der ellipsiert, sein Minimum ist winzig, und die sechs
Steuer-Reiter wurden zu „Erkl… EÜR Anl… USt… Ste…" gequetscht statt scrollbar. `pinNaturalWidth`
misst einmal und fixiert — aus der Quetschung wird wieder ein Scroll.

**Der `Adw.InlineViewSwitcher` hat zwischen den Reitern je einen `Gtk.Separator`.** Das n-te KIND
ist also nicht der n-te Reiter; wer mitzählt, scrollt zu einem 1 px breiten Trennstrich und hält das
Ergebnis für einen Fehlschlag der Scroll-Logik. Nach `Gtk.ToggleButton` filtern.

**Eine `Adw.ActionRow` legt Titel und ALLE Suffixe in eine waagerechte Box.** Drei beschriftete
Knöpfe setzen damit einen harten Boden für die ganze Zeile — und was übrig bleibt, bekommt der
Titel, der dann ein Zeichen pro Zeile umbricht. Dafür gibt es `rowActions` (eine `Adw.WrapBox` als
EIN Suffix).

**Eine `Adw.Clamp` ohne `tightening-threshold` wird schmaler, sobald ihr Kind nachgeben kann.** Die
Clamp teilt bis `MAX(Kind-Minimum, tightening-threshold)` die volle Breite zu und lässt sie erst
darüber hinter dem Platz zurückbleiben — Vorgabe ist 400 px. Bis zu diesem Zweig war das
Kind-Minimum der Ansichten (die starre Filterleiste, ~605 px) selbst diese Grenze, die Inhaltsspalte
bekam also immer alles. Mit beweglichen Kindern übernahm die Vorgabe, und jede Ansicht verlor rund
26 px, ohne dass sich an ihr etwas geändert hätte: bei Verträge fiel „Archiviert" aus den
Filter-Chips. Deshalb steht in jeder Clamp `tightening-threshold` gleich `maximum-size` — damit ist
sie wieder das reine Breiten-Limit, als das sie überall gemeint war. Unter 400 px ändert sich
nichts, das Telefon bleibt unberührt.

**Ein `Adw.Breakpoint` INNERHALB einer Ansicht misst die Inhaltsspalte, nicht das Fenster.** Auf dem
Desktop ist die viel schmaler, als die Fensterbreite vermuten lässt: bei 1280 px bleiben zwischen
Navigation und Assistenz-Spalte **537 px** übrig (am Screenshot gemessen, der Inhalt läuft von
x=320 bis x=856). Vier Haltepunkte standen auf `max-width: 560px` — gedacht für das Telefon,
ausgelöst auf dem Desktop: Kontakte verlor seinen Gruppentitel, der Beleg-Eingang klappte seine
Warteschlange zu. Darum liegt jeder Haltepunkt in einer Ansicht bei **450 px**, unter den 537. Nur
die zwei in `window.blp` (720 / 1180) messen wirklich das Fenster. Wer einen neuen setzt, misst
erst die Spaltenbreite — rechnen reicht nicht, die 390 aus `min-sidebar-width` sind nur der Boden.

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
