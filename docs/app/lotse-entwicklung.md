# lotse einbinden

Das Assistenten-Panel „lotse" (siehe [KI-Assistent und MCP-Server](ki-und-mcp.md#der-zweite-assistent--lotse))
nutzt die Pakete `@lotse/core`, `@lotse/session` und `@lotse/widget` aus
[JumpLink/lotse](https://github.com/JumpLink/lotse). Sie sind auf npm veröffentlicht
(`@lotse/{acp,session,core,widget}` ab 0.2.0).

## Standard: aus der Registry

`app/package.json` führt die drei Pakete als `^0.2.0`, `gjsify-lock.json` hält die Registry-Einträge
(einschließlich des transitiven `@lotse/acp`). Es braucht nichts Besonderes:

```bash
gjsify install --immutable
gjsify run check
```

Die CI macht genau das — kein lotse-Checkout, kein Link, kein gepinnter Commit. Eine neue
lotse-Version hebt man wie jede andere Abhängigkeit an (Versionsangabe ändern, `gjsify install`,
Sperrdatei mit committen).

## Optional: unveröffentlichte lotse-Änderungen testen

```bash
git clone https://github.com/JumpLink/lotse.git        # z. B. neben dieses Repo
cd lotse && gjsify install                             # NICHT optional, siehe unten
cd ../steuererklaerung
gjsify link ../lotse                                   # --dry-run zeigt vorher, was passiert
gjsify install                                         # ohne --immutable
gjsify run check
```

`gjsify link` legt `.gjsify-link.json` an (gitignoriert, absoluter Pfad) und setzt Symlinks in
`node_modules/@lotse/*`.

**Vor dem Commit entlinken.** `gjsify install --immutable` verweigert den Dienst, solange
`.gjsify-link.json` existiert. Also `gjsify unlink`, dann `gjsify install --immutable`; stehen
danach noch Symlinks in `node_modules/@lotse/`, `node_modules` löschen und neu installieren (die
Installation weigert sich, ein Verzeichnis zu überschreiben, das auf einen Quellbaum zeigt).
Die Sperrdatei darf sich durch den Link nicht ändern — sie gehört zur Registry-Variante.

### Stolpersteine nur mit Link

1. **`gjsify install` im lotse-Checkout ist Pflicht.** Die verlinkten Pakete hängen an
   `@lotse/acp`, das dieses Repo nicht deklariert und `gjsify link` deshalb nicht verlinkt; es wird
   über den Symlink hinweg in lotses eigenem `node_modules` aufgelöst. Ohne das scheitert
   `gjsify run check` mit **TS2307** auf eine Datei in einem *anderen* Repository.
2. **`preserveSymlinks` in `app/tsconfig.json`** bleibt für diesen Weg stehen: TypeScript löst
   Importe sonst über den Realpath auf, die `@girs/*` aus dem lotse-Checkout kämen zusätzlich zu den
   eigenen ins Programm (zwei Deklarationen derselben GTK-Klassen, `TS2300`/`TS2717`/`TS2308`).
   Die Registry-Variante braucht es nicht — dort ist `gjsify run check` auch ohne grün, weil die
   `@girs/*`-`peerDependencies` von `@lotse/widget` auf die Kopie des Hosts auflösen.
3. **Der Link ersetzt die Registry-Auflösung**, die Sperrdatei bleibt dabei unverändert.

## Offen: Flatpak

Der Flatpak-Build baut **offline** aus `gjsify-sources.json`, das nur Registry-Tarballs kennt. Mit
den veröffentlichten Paketen ist der Grund für die Lücke weggefallen; die Datei muss mit der neuen
Sperrdatei neu erzeugt werden, bevor das Panel im Flatpak erscheint.
