# KI-Assistent und MCP-Server — zwei Schalter

Die App kennt zwei voneinander unabhängige Wege, eine KI an die eigenen Zahlen zu lassen. Jeder hat
genau einen Schalter.

| Schalter | Wo er steht | Wo er gespeichert wird | Was er steuert |
|---|---|---|---|
| **Eingebauter KI-Assistent** | Einführung (Seite „KI-Assistent"), Einstellungen → Allgemein, Web: Einstellungen | Einstellungsdatei des Benutzers (`settings.json` → `aiAssistant`) | Stern/Panel in der App, Assistent-Tab und `/api/chat` im Web |
| **MCP-Server für externe Agenten** | Einstellungen → MCP, Web: Einstellungen | Manifest (`steuererklaerung.json` → `app.mcp`) | Welche Werkzeuge `steuer mcp` nach außen anbietet (Gruppen, Schreibzugriff) |

## Warum der Assistent pro Benutzer gilt

Der Schalter ist eine **persönliche Einwilligung**: Wer ihn einschaltet, schickt Fragen und die zur
Antwort nötigen Daten an den eingerichteten KI-Anbieter. Das entscheidet die Person, nicht der
Datenbestand — ein Manifest kann in einem Projektordner liegen und von mehreren genutzt werden. Und
die Einführung fragt danach, **bevor** es überhaupt ein Manifest gibt.

Ältere Installationen haben im Manifest noch `app.assistant.enabled`. Dieser Wert gilt nur, solange
die Person selbst noch nie entschieden hat (`aiAssistant` nicht gesetzt). Wer den Assistenten dort
abgeschaltet hatte, behält ihn also aus; nichts wird migriert oder neu geschrieben. Sobald die Person
den Schalter umlegt, gilt ihre Entscheidung. Code: `app/src/core/config/assistant-preference.ts`
(`isAssistantEnabled`).

## Warum der MCP-Server im Manifest bleibt

`steuer mcp` ist ein eigener Prozess, den ein externer Client (Claude, Cursor, VS Code …) startet.
Er liest seine Freigaben aus dem Manifest des Arbeitsbereichs — dieselbe Datei, die auch CLI und
Web lesen. Änderungen greifen beim nächsten Start des MCP-Servers. Schreibende Werkzeuge sind ohne
`allowWrite` nie dabei; die Voreinstellung ist aus.

## Unabhängig voneinander

Der eingebaute Assistent braucht den MCP-Server nicht. Seine Werkzeuge laufen im selben Prozess:
die Zahlen des gewählten Jahres und, wenn Paperless eingerichtet ist, eine **lesende**
Belegsuche. Schreibwerkzeuge bekommt er nie; Vorschläge übernimmt nur ein Klick der Person. Wer den
MCP-Server abschaltet, nimmt dem eingebauten Assistenten also nichts weg — und umgekehrt.
