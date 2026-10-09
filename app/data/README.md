# `app/data` — Icon und Desktop-Eintrag

Zwei Dateien, die nichts bauen und nichts bündeln:

| Datei | Wofür |
|---|---|
| `icons/hicolor/scalable/apps/eu.jumplink.Steuererklaerung.svg` | das App-Icon (SVG, eigenes Werk, MIT wie der Rest) |
| `eu.jumplink.Steuererklaerung.desktop` | der Desktop-Eintrag für eine echte Installation |

**Aus dem Repository heraus** braucht es keine Installation: die App legt `icons/` beim Start
auf den Icon-Theme-Suchpfad (`src/frontends/desktop/icons.ts`), damit alles, was GTK im Prozess
über den Icon-**Namen** auflöst, das Icon findet — vor allem der Über-Dialog.

**Der Eintrag in Shell, Dock und Übersicht** kommt davon nicht: unter Wayland ordnet der
Compositor die App-Id des Fensters einer **installierten** `.desktop`-Datei zu. Dafür müssen
beide Dateien in ein XDG-Datenverzeichnis:

```bash
install -Dm644 app/data/icons/hicolor/scalable/apps/eu.jumplink.Steuererklaerung.svg \
  ~/.local/share/icons/hicolor/scalable/apps/eu.jumplink.Steuererklaerung.svg
install -Dm644 app/data/eu.jumplink.Steuererklaerung.desktop \
  ~/.local/share/applications/eu.jumplink.Steuererklaerung.desktop
```

Das `Exec=steuer-app` in der `.desktop`-Datei setzt einen Starter im `PATH` voraus — ein
Zweizeiler, der `gjsify run start:app` im Projektverzeichnis aufruft. Ein richtiges
Paket (Flatpak samt Metainfo) gibt es noch nicht; es ist in
`src/frontends/desktop/README.md` als offener Punkt notiert.
