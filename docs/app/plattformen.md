# macOS und Windows

Neben Linux (deb, rpm, AppImage, Flatpak) baut `gjsify ship` die App auch für macOS und Windows.
Beide Pakete tragen das **Node-Bundle** (`build:app:node`) auf node-gi samt GTK-Laufzeit, nicht das
GJS-Bundle. In `ci.yml` entstehen beide unsigniert auf Linux (`ship-macos-windows`). Für ein Release
baut `release.yml` Windows auf Linux (`package-windows`) und macOS komplett auf macOS
(`package-macos`): Ein Build mit ERiC darf den Job nicht als Artifact verlassen, und Signieren geht
nur auf einem Mac.

| Artefakt | Inhalt |
|---|---|
| `steuererklaerung-<version>-1.arm64.dmg` / `…x86_64.dmg` | Disk-Image für Apple Silicon bzw. Intel, der Haupt-Download |
| `steuererklaerung-<version>-1.macos.arm64.zip` / `…macos.x86_64.zip` | dieselbe `.app` als Zip |
| `steuererklaerung-<version>-1.windows.x64.zip` | Programmverzeichnis |
| `steuererklaerung-<version>-1.x64.msi` | Windows-Installer |

Neben jedem Artefakt liegt `<artefakt>.gjsify-release.json` mit Prüfsumme und Herkunft.

Die macOS-Pakete eines Releases sind mit einer Developer ID signiert und von Apple notarisiert. Die
Windows-Pakete sind unsigniert.

Bis einschließlich 0.1.6 fehlte den macOS- und Windows-Paketen die GTK-Laufzeit: `gjsify ship` konnte
sie beim Bau auf Linux nicht holen und schrieb die Pakete trotzdem. Die App startete nur auf einem Mac
mit Homebrew-GTK und beendete sich sonst sofort. Behoben in gjsify#2386; seither prüfen `ci.yml` und
`release.yml` jedes Paket auf die GTK-Laufzeit und das Adwaita-Icon-Theme.

## macOS: erster Start

Das `.dmg` öffnen und die App nach „Programme" ziehen. Die signierten Pakete startet Gatekeeper
ohne Rückfrage.

Ältere, unsignierte Pakete (bis 0.1.6 und aus `ci.yml`) startet Gatekeeper nach einem Download im
Browser nicht: Es erscheint „„Steuererklärung“ nicht geöffnet", und jeder weitere Start endet sofort
ohne Meldung. Nach dem Entpacken und Verschieben nach „Programme" hebt dieser Befehl die Sperre auf:

```sh
xattr -dr com.apple.quarantine /Applications/Steuererklärung.app
```

## Linux: deb und rpm

Beide setzen GJS ≥ 1.86 voraus (`minGjsVersion` bleibt, GJS wird nicht mitgeliefert).

| Paket | libgda 6 | Läuft auf |
|---|---|---|
| rpm | Systempaket `libgda` (Fedora hat `libgda6`) | Fedora 43+ |
| deb | **im Paket**, gebaut mit `app/dev/ship-gda-deb.sh` | Ubuntu ≥ 26.04 und jede Distribution mit GJS ≥ 1.86 |

Das deb bringt libgda selbst mit, weil Ubuntu 26.04 nur libgda 5 führt und es dort kein
`gir1.2-gda-6.0` gibt (#148). Es liegt unter `/usr/lib/steuererklaerung/gi` (Bibliothek und Typelib)
und `/usr/lib/steuererklaerung/gda` (SQLite-Provider und DTDs); libgda findet beides über den
Präfix, mit dem es gebaut wurde, ohne Umgebungsvariable. Die Bibliothek ist gegen Ubuntus
`libxml2.so.16` gelinkt und deshalb nur im deb (`gjsify.ship.formats.deb`), nicht im rpm oder
AppImage. Das deb hängt zusätzlich von `libxml2-16`, `libsqlite3-0` und `gir1.2-freedesktop` ab
(Letzteres liefert die `libxml2-2.0`-Typelib, die `Gda-6.0` einbindet).

Debian stable (trixie, GJS 1.82) ist ausgeschlossen, bis eine Debian-Version GJS ≥ 1.86 liefert.
Der Release-Workflow prüft Installation und Start des deb auf Ubuntu 26.04 (`prove-deb`).

## Datenbank

Das Node-Bundle nutzt `node:sqlite`. libgda wird nur unter Linux gebraucht.

## Geheimnisse

Ein Interface (`app/src/core/secrets/store.ts`), ein Backend je System:

| System | Ablage | Hinweis |
|---|---|---|
| Linux | libsecret / `secret-tool` | wie bisher |
| macOS | Schlüsselbund über `security` | das Geheimnis läuft über stdin, nie über argv |
| Windows | DPAPI, Blobs in `secrets.dpapi.json` im Konfigurationsordner (Modus 0600) | **Jedes Programm, das als dieser Benutzer läuft, kann sie entschlüsseln.** Auf echtem Windows noch ungetestet. |

Fehlt das Programm, fragt die App jedes Mal nach. Es gibt keinen Klartext-Fallback; die Texte im
Absenden-Dialog und in Konten sagen, wo ein Geheimnis liegt.

## Getestet

macOS 27 auf Apple Silicon, lokal gebautes `.app` mit GTK-Laufzeit (Oktober 2026), gesteuert über
`GJSIFY_DEVTOOLS`:

- Erststart ohne Konfiguration, Einführung, Einrichtungsassistent bis „Einrichtung abschließen"
- alle Ansichten mit Demodaten, „Eigene Daten verwenden" samt Neustart
- „Jetzt sichern", Beenden, zweiter Start mit eigenen Daten
- alle Bibliotheken aus dem Paket, keine aus Homebrew

Windows 11 x64 in einer VM, Build von 0.1.0 (Oktober 2026):

- MSI-Installation, Start über das Startmenü, portables Zip, deutsche Oberfläche
- „Jetzt sichern" in der Oberfläche und `steuererklaerung.cmd --internal-backup manual`
- ERiC 44.3.6.0 aus dem Benutzerordner: Status „verfügbar"
- MCP über stdio: `tools/list` liefert alle Werkzeuge

Noch nicht geprüft: der Datenschutz-Dialog vor dem Absenden (braucht eine Hersteller-ID), eine
echte Übermittlung, DPAPI; unter macOS ERiC, der Schlüsselbund und die Übersetzungen von GTK
selbst, die GTK noch unter dem Homebrew-Pfad sucht.

## Bekannte Grenzen

- **ELSTER nur auf x86_64 bzw. Universal-macOS.** ERiC gibt es für Linux x86_64, Windows x64 und
  macOS (Universal, `packages/eric/src/platform.ts`). Auf anderen Architekturen (z. B. Linux oder
  Windows auf ARM) meldet die ERiC-Einrichtung „unsupported platform".
