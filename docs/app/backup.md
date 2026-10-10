# Sicherung und Wiederherstellung

Die App hält alles lokal: die Konfiguration (`steuererklaerung.json`), den Buchungsspeicher
(`transactions-data/` mit `ledger.db`) und heruntergeladene Rechnungen (`invoices/`). Eine Sicherung
kopiert genau das in einen eigenen Ordner. Code: `app/src/core/actions/backup.ts`.

## Sichern

- **App:** Einstellungen → **Sicherung** → „Jetzt sichern". Dort stehen auch Zeitpunkt und Ort der
  letzten Sicherung, der Sicherungsordner und wie viele Sicherungen behalten werden (Standard 10).
- **CLI:** `steuer backup create [--dir <ordner>] [--keep <n>]` und `steuer backup list`.
- **Automatisch:** bevor eine Migration die Konfiguration umschreibt (`config migrate`, oder ein
  Speichern, das ein älteres Manifest auf die aktuelle Schema-Version hebt). Schlägt diese Sicherung fehl, bricht die Migration ab.

Die App sichert im Hintergrund: „Jetzt sichern" startet einen Kindprozess (`<app> backup manual`,
`app/src/frontends/desktop/background-backup.ts`), das Fenster bleibt bedienbar, der Knopf ist
gesperrt und zeigt einen Spinner, bis eine Meldung Erfolg oder Fehler nennt. Die CLI sichert
weiterhin synchron.

Es läuft immer nur eine Sicherung: CLI, App und die Sicherung vor einer Migration nehmen dieselbe
Sperre `$XDG_DATA_HOME/steuererklaerung/backup.lock` (Prozess-ID, Startzeit, Anlass). Ein zweiter
Lauf bricht mit „Es läuft bereits eine Sicherung …" ab. Eine Sperre, deren Prozess nicht mehr
läuft (abgestürzt, beendet), wird beim nächsten Lauf übernommen.

Standardordner: `$XDG_DATA_HOME/eu.jumplink.Steuererklaerung/backups` (meist
`~/.local/share/eu.jumplink.Steuererklaerung/backups`). Ein eigener Ordner wird in den
Einstellungen gewählt; er darf nicht innerhalb von `transactions-data/` oder `invoices/` liegen.

### Was eine Sicherung enthält

Jede Sicherung ist ein Ordner `<Zeitstempel>/` (Rechte 0700, Dateien 0600 — sie enthält dieselben
Steuernummern und Bankdaten wie das Original):

| Pfad in der Sicherung | Herkunft |
|---|---|
| `config/` | das Manifest (unter dem Namen, unter dem es gefunden wurde — auch `buchhaltung.json`), alte Einzel-Konfigurationen und `*.json.bak-*` |
| `invoices/` | `invoices/` neben dem Manifest |
| `transactions-data/` | der Buchungsspeicher; jede SQLite-Datenbank als konsistenter Schnappschuss (`VACUUM INTO`, geprüft mit `PRAGMA integrity_check`) |
| `ledger.db` | nur wenn `LEDGER_DB_PATH` außerhalb des Speichers liegt |
| `backup.json` | Zeitpunkt, Anlass (`manual`, `before-migration`), Quellpfade, Dateiliste |

**Nicht** gesichert: `.env` (Zugangsdaten gehören in einen Passwortmanager), `fints-data/`,
ERiC und die erzeugten ELSTER-XML-Dateien.

Eine unterbrochene Sicherung bleibt als `<Zeitstempel>.partial` liegen und zählt nicht. Beim Aufräumen
löscht die App nur Ordner mit ihrer eigenen `backup.json`, nie andere Dateien im Sicherungsordner.

## Wiederherstellen — von Hand, mit Absicht

Die App stellt nicht selbst wieder her: Eine Sicherung über die aktuellen Daten zu kopieren ist die
eine Aktion, bei der ein falscher Klick den neueren Stand kostet. So geht es:

1. **Alles beenden,** was auf die Daten zugreift: App, `steuer`-Kommandos, MCP-Server.
2. **Den aktuellen Stand beiseitelegen**, nicht löschen — z. B. `transactions-data/` in
   `transactions-data.vorher/` umbenennen, ebenso Manifest und `invoices/`.
3. **Zurückkopieren** aus dem Sicherungsordner (`sources` in `backup.json` nennt die ursprünglichen
   Pfade):
   - `config/<manifest>` → neben die anderen Dateien, wo das Manifest vorher lag;
   - `invoices/` → neben das Manifest;
   - `transactions-data/` → an den bisherigen Ort des Speichers;
   - ggf. `ledger.db` → nach `LEDGER_DB_PATH`.
   Keine `ledger.db-wal`/`-shm` vom alten Stand daneben liegen lassen.
4. **`.env` prüfen** — sie war nicht in der Sicherung und gilt unverändert weiter.
5. **Starten und prüfen,** z. B. `steuer backup list` und eine Buchungsansicht. Erst danach den
   beiseitegelegten Stand löschen.
