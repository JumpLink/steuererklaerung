# lotse aus dem Quellcode einbinden

Das Assistenten-Panel „lotse" (siehe [KI-Assistent und MCP-Server](ki-und-mcp.md#der-zweite-assistent--lotse))
nutzt die Pakete `@lotse/core`, `@lotse/session` und `@lotse/widget` aus
[JumpLink/lotse](https://github.com/JumpLink/lotse). **Keines davon ist auf npm veröffentlicht.**

Deshalb gibt es keine Version, die sich in `app/package.json` festschreiben ließe: die drei
Abhängigkeiten stehen dort als `"*"` und werden über einen **Entwicklungs-Link** auf einen lokalen
lotse-Checkout aufgelöst. Dieses Dokument beschreibt, wie das lokal und in der CI funktioniert —
und warum es so aussieht.

## Einmal einrichten

```bash
git clone https://github.com/JumpLink/lotse.git        # irgendwohin, z. B. neben dieses Repo
cd lotse && gjsify install                             # NICHT optional, siehe unten
cd ../steuererklaerung
gjsify link ../lotse                                   # --dry-run zeigt vorher, was passiert
gjsify install                                         # ohne --immutable, siehe unten
gjsify run check                                       # sollte 0 sein
```

`gjsify link` legt `.gjsify-link.json` an und setzt Symlinks in `node_modules/@lotse/*`. Die Datei
ist **gitignoriert**: sie enthält einen absoluten Pfad, der nur auf einem Rechner gilt.

Verlinkt werden ausschließlich Pakete, die dieses Repo auch **deklariert** — also genau die drei
aus `app/package.json`. `gjsify link` ohne passende Auswahl bricht ab, statt stillschweigend nichts
zu tun.

## Drei Stolpersteine, jeder einmal bezahlt

### 1. `gjsify install` im lotse-Checkout ist Pflicht

Die drei verlinkten Pakete hängen alle an einem **vierten**, `@lotse/acp`, das dieses Repo nicht
deklariert und `gjsify link` deshalb nicht verlinkt. Aufgelöst wird es über den Symlink hinweg, in
lotses eigenem `node_modules` — nachweisbar mit `gjsify tsc --traceResolution`:

```
'@lotse/acp' … resolved to '…/node_modules/@lotse/core/node_modules/@lotse/acp/src/index.ts'
```

Ohne `gjsify install` im lotse-Checkout scheitert `gjsify run check` also mit **TS2307** auf
`@lotse/acp` — und zeigt dabei auf eine Datei in einem *anderen* Repository.

### 2. `preserveSymlinks` in `app/tsconfig.json` ist tragend

TypeScript löst die Importe einer Datei normalerweise über ihren **Realpath** auf. Für ein
verlinktes Paket heißt das: die `@girs/*`-Typen aus dem lotse-Checkout landen **zusätzlich** zu den
eigenen im Programm — zwei Deklarationen derselben GTK-Klassen, also `TS2300`/`TS2717`/`TS2308`
mitten in fremden `.d.ts`-Dateien.

`preserveSymlinks: true` lässt die Auflösung am Symlink-Pfad beginnen, womit die verlinkten Quellen
die `@girs/*` **dieses** Repos sehen. Die zweite Hälfte der Lösung steckt in lotse selbst: dessen
`packages/widget` deklariert die sechs `@girs/*` als `peerDependencies`. Beide Hälften werden
gebraucht — `peerDependencies` allein ändert an der Auflösung nichts.

### 3. `gjsify install --immutable` geht nicht, solange der Link steht

`--immutable` verweigert den Dienst, sobald `.gjsify-link.json` existiert. Darum **einfaches**
`gjsify install`. Die Sperrdatei wandert dadurch nicht: die drei `@lotse/*`-Angaben stehen in
`gjsify-lock.json` unter `requested` und lösen auf die Symlinks auf, es gibt also nichts, was unter
`packages` hinzukäme.

Umgekehrt heißt das: **ein frischer Checkout ohne Link kann nicht installieren** — die drei Namen
sind in keiner Registry zu finden. Erst `gjsify link`, dann `gjsify install`.

> Dass ein `install` mit Link überhaupt durchläuft, ist selbst erst eine Korrektur in der
> gjsify-CLI: vorher wurde die Abhängigkeitskante eines verlinkten Pakets weiterhin gegen npm
> aufgelöst, und ein 404 brach die gesamte Installation ab
> ([gjsify/gjsify#2160](https://github.com/gjsify/gjsify/pull/2160)). Diese Korrektur **steckt in
> der Version, die dieses Repo pinnt** — `@gjsify/cli 0.58.0` aus `app/package.json` —, also
> braucht weder ein lokaler Checkout noch die CI eine CLI aus einem Zweig. Der Satz steht hier
> trotzdem, weil er erklärt, warum die Reihenfolge *erst linken, dann installieren* überhaupt
> funktioniert; wer auf eine ältere CLI zurückgeht, läuft wieder in den 404.

## In der CI

`.github/workflows/ci.yml` macht genau dieselben vier Schritte — klonen, lotse installieren,
verlinken, installieren — und braucht dafür **keine Veröffentlichung**. Der lotse-Stand ist ein
**fester Commit** in der Job-Variablen `LOTSE_COMMIT`.

Ein Commit und kein Branch-Name, weil ein wandernder Verweis einen beliebigen lotse-Commit in einen
roten Build *dieses* Repos verwandelt — an einem PR, der lotse gar nicht berührt.

**Den Stand anheben:**

```bash
git -C <lotse-checkout> rev-parse <ref>     # vollständige 40-Zeichen-SHA
```

Die SHA in `LOTSE_COMMIT` eintragen, lokal neu verlinken, `gjsify run check` und `gjsify run test`
laufen lassen, dann committen. Der Tarball-Cache der CI hängt mit im Schlüssel, erneuert sich also
von selbst.

Weil lotse eine **andere** gjsify-Version pinnt als dieses Repo (gjsify erscheint als ein
Release-Zug, eine Mischung erzeugt still kaputte Bundles), installiert die CI lotses Abhängigkeiten
mit lotses eigener CLI über `npx` — ein globales Install würde die hier gebootstrappte Version
überschreiben. Beide Versionen liest die CI aus der jeweiligen `app/package.json` und beide kommen
aus der Registry: dieses Repo `@gjsify/cli 0.58.0` global, lotse `0.54.0` über `npx`. **Keine
unveröffentlichte CLI, kein Zweig-Build** — die vier Schritte laufen mit veröffentlichten Versionen
durch.

## Offen: Flatpak

Der Flatpak-Build baut **offline** aus `gjsify-sources.json`, und diese Datei kennt nur
Registry-Tarballs. Ein Symlink in einen Nachbar-Checkout lässt sich darin nicht ausdrücken, und ein
Git-Submodul wäre ein zweiter Wahrheitsstand neben `LOTSE_COMMIT`.

Das Panel ist deshalb **im Flatpak noch nicht enthalten**. Der Weg dorthin führt über
veröffentlichte `@lotse/*`-Pakete; danach ersetzt eine normale Versionsangabe in `app/package.json`
den Link, und dieses Dokument wird bis auf den Abschnitt „Einmal einrichten" überflüssig.
