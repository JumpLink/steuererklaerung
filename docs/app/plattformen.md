# macOS und Windows

Neben Linux (deb, rpm, AppImage, Flatpak) baut `gjsify ship` die App auch für macOS und Windows.
Beide Pakete tragen das **Node-Bundle** (`build:app:node`) auf node-gi samt GTK-Laufzeit, nicht das
GJS-Bundle. Sie entstehen in CI auf Linux (`ship-macos-windows` in `ci.yml`, `package-macos-windows`
in `release.yml`); gestartet wird auf den Zielsystemen selbst.

| Artefakt | Inhalt |
|---|---|
| `steuererklaerung-<version>-1.macos.arm64.zip` / `…macos.x86_64.zip` | `.app` für Apple Silicon bzw. Intel |
| `steuererklaerung-<version>-1.windows.x64.zip` | Programmverzeichnis |
| `steuererklaerung-<version>-1.x64.msi` | Windows-Installer |

Die Pakete sind unsigniert.

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

## Bekannte Grenzen

- **ELSTER-Übermittlung nur unter Linux.** ERiC wird per koffi geladen und ist dort geprüft; auf
  macOS und Windows zeigt die App „nicht unterstützt".
- **Diagramm-Beschriftungen fehlen** unter node-gi, bis node-gi die cairo-Textoperationen
  enthält (`packages/node-gi/node-gi/src/cairo.cc` in gjsify). Die Balken werden gezeichnet.
