# KI-Assistent und MCP-Server — zwei Schalter

> **In 0.1.0 gibt es nur den zweiten Schalter.** Der eingebaute KI-Assistent wird in dieser
> Version **nicht angeboten**: kein Panel, kein Stern, kein Schalter in den Einstellungen, und
> keine Aufgabe ruft im Hintergrund ein LLM. Entschieden wird das an einer Stelle,
> `ASSISTANT_OFFERED` in `app/src/core/config/assistant-offered.ts`. Der **MCP-Server** bleibt:
> Ein Assistent, den die Person selbst betreibt, darf sich weiterhin verbinden. Alles Weitere auf
> dieser Seite beschreibt den Stand, der mit 0.2 zurückkommt.

Die App kennt zwei voneinander unabhängige Wege, eine KI an die eigenen Zahlen zu lassen. Jeder hat
genau einen Schalter.

| Schalter | Wo er steht | Wo er gespeichert wird | Was er steuert |
|---|---|---|---|
| **Eingebauter KI-Assistent** | Einführung (Seite „KI-Assistent"), Einstellungen → Allgemein, Web: Einstellungen | Einstellungsdatei des Benutzers (`settings.json` → `aiAssistant`) | Stern/Panel in der App, Assistent-Tab und `/api/chat` im Web |
| **MCP-Server für externe Agenten** | Einstellungen → MCP, Web: Einstellungen | Manifest (`steuererklaerung.json` → `app.mcp`) | Welche Werkzeuge `steuer mcp` nach außen anbietet (Gruppen, Schreibzugriff) |

Ist der Assistent **eingeschaltet**, gibt es zusätzlich eine Wahl, *welcher* Assistent im Panel
sitzt — der eingebaute oder „lotse". Das ist keine dritte Einwilligung, sondern eine Auswahl
innerhalb der ersten: [siehe unten](#der-zweite-assistent--lotse).

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

## Der zweite Assistent — lotse

**Einstellungen → Allgemein → KI-Assistent → Modus.** Die Auswahl hat zwei Werte; voreingestellt
ist **Eingebaut**, eine bestehende Installation ändert sich also nicht von selbst.

| Modus | Was im Panel läuft |
|---|---|
| **Eingebaut** (Voreinstellung) | wie bisher: die App ruft einen KI-Anbieter **im eigenen Prozess** auf |
| **lotse** | die App startet einen **Coding-Agenten als eigenen Prozess** ([opencode](https://opencode.ai)) und spricht mit ihm über das [Agent Client Protocol](https://agentclientprotocol.com) |

Der Unterschied ist nicht das Modell, sondern **wer** arbeitet: ein Agent führt Werkzeuge aus,
fragt nach, arbeitet mehrschrittig. Darum ist die Wahl ausdrücklich und nicht automatisch.

**Ein Wechsel gilt beim nächsten Start.** Das Panel wird beim Öffnen des Fensters gebaut; die Zeile
sagt das selbst dazu. Solange der KI-Assistent aus ist, ist sie nicht bedienbar — es gibt dann
nichts auszuwählen.

**Welches opencode?** Zeile **Coding-Agent** direkt darunter (gilt ab dem nächsten Start, für das
Panel *und* die Einmal-Aufträge). Voreinstellung: **Mitgeliefertes opencode** mit eigener, isolierter
Konfiguration. Wer **Eigenes opencode (globale Konfiguration)** wählt, nutzt sein installiertes
opencode samt eigener Anmeldung und Modellen. Die Modellregel gegen kostenlose Fremdmodelle gilt für
beide. Fehlt die gewählte Variante, nimmt lotse die andere und die App schreibt einen Hinweis;
gibt es gar keine, erscheint die Hinweisseite.

### Was lotse hier bekommt — und was nicht

- **Kein Agent installiert, kein Panel.** Findet die App keinen opencode, zeigt sie eine
  Hinweisseite mit dem fehlenden Schritt, statt einen Chat vorzutäuschen.
- **Nur lesende Werkzeuge.** Der Agent erreicht die App über **ihren eigenen MCP-Server**, und den
  startet sie für diesen Zweck **lesend** — unabhängig davon, was im Manifest unter `app.mcp`
  steht. Ein extern eingerichteter Client (Claude, Cursor …) bekommt davon nichts ab; dessen
  Konfiguration bleibt unverändert.
- **Eigenes Datenverzeichnis.** lotse schreibt seine Sitzungen **nicht** nach
  `$XDG_DATA_HOME/lotse`, sondern in ein Unterverzeichnis des Datenverzeichnisses *dieser* App
  (`assistant-agent`, Modus `0700`). Ein Sitzungsprotokoll enthält den Text von Gesprächen über
  Steuerdaten; es gehört zu diesen Daten und nicht in die Historie eines anderen Programms.
- **Rückfragen: ablehnen oder fragen, nie von selbst erlauben.** Will der Agent löschen,
  verschieben, bearbeiten, schreiben oder einen Befehl ausführen, wird **abgelehnt** — der lesende
  MCP-Server könnte es ohnehin nicht, und eine Ablehnung ist die ehrliche Antwort darauf. Alles
  andere wird **gefragt**. Es gibt keine Antwort, die etwas zusätzlich erlaubt.
  `fetch` ist bewusst nicht abgelehnt: so sieht der Agent einen Gesetzestext oder eine
  BMF-Seite nach. Die URL steht in der Rückfrage.
- **Keine kostenlosen Fremdmodelle — und zwar durchgesetzt, nicht nur nicht angeboten.** Das Panel
  übergibt lotse eine **Modellregel** (`denyFreeHostedModels`): kostenlose Fremdmodelle stehen in
  der Modellauswahl nicht zur Verfügung, und solange eines ausgewählt ist, geht **keine Eingabe
  raus** — das Senden ist gesperrt und der Grund steht darunter. Umgeschaltet wird dabei nie: die
  Modellwahl bleibt die der Person, sie wird nur eingeschränkt. Die Regel ist **fail-closed**: ein
  Fehler in der Prüfung und ein Modell, das lotse nicht zuordnen kann, gelten beide als Ablehnung.
  Die Regel schränkt **Modelle** ein, nicht Anbieter: Ist noch keiner verbunden, bietet das Panel
  die Anmeldung bei **jedem Anbieter an, den lotse unterstützt** (`providerOnboarding` an), und ein
  Anbieter mit bezahlten und kostenlosen Modellen bleibt mit den bezahlten nutzbar. Die Rückfrage-Logik hat damit nichts zu tun; sie sieht Werkzeugaufrufe und kann ein
  Modell gar nicht erkennen.

  Eine **bekannte Lücke**, offen benannt: erkannt werden alles mit der Endung `-free` und
  `opencode/big-pickle` (lotses Regel `isFreeModel`). Eine *unbekannte* Modell-ID gilt als
  erlaubt, denn die Regel benennt die kostenlosen Modelle und nicht die bezahlten — würde Unbekanntes
  abgelehnt, wären fast alle Modelle gesperrt, auch bezahlte. Wer es genauer braucht, pflegt eine
  eigene Positivliste; das wäre dann eine Liste, die veraltet und jemanden von einem Modell
  aussperrt, für das er zahlt.

Technisch: die Pakete `@lotse/*` kommen von npm; ein Entwicklungs-Link auf einen lokalen Checkout
ist optional — [lotse einbinden](lotse-entwicklung.md).
