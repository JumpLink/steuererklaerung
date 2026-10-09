# Lizenzen der Abhängigkeiten

`gjsify run check:licenses` liest die Lizenz jeder Laufzeit-Abhängigkeit, schreibt `NOTICE` neu,
kopiert die Lizenztexte nach `licenses/` und **scheitert**, wenn eine Lizenz mehr als Namensnennung
verlangt und nicht in `licenses.acknowledged.json` entschieden ist.

Bewusst **nicht** Teil von `gjsify run check`: ein Release-Tor, kein Commit-Tor.

Der Build bindet seine Abhängigkeiten **statisch** in ein `.mjs`. Für MIT und BSD ist das
unproblematisch; für alles andere ist es eine Entscheidung.

## Entschieden

### `lib-fints` — LGPL-2.1-or-later → mitgebündelt, Auflagen erfüllt

Unverändert und statisch ins Bundle gelinkt. Die Auflagen der LGPL sind damit zu erfüllen, nicht zu
umgehen:

- Der **vollständige Lizenztext** liegt unter `licenses/lib-fints.txt` und wird mit ausgeliefert.
  Ihn nur in `NOTICE` zu nennen wäre keine Erfüllung.
- **Version und Herkunft** stehen in `NOTICE`; Upstream ist
  <https://github.com/robocode13/lib-fints>. Die Bibliothek ist **unverändert** — gäbe es
  Änderungen, gehörten sie gekennzeichnet.
- **§6 (Ersetzbarkeit):** der vollständige Quelltext dieses Programms ist öffentlich, mit
  Build-Anweisung. Wer die Bibliothek durch eine eigene Fassung ersetzen will, tauscht die
  Abhängigkeit und baut neu — das ist der Weg, den ein statisch gelinktes JS-Bundle bietet, und er
  ist gangbar, weil nichts daran geheim ist.

Betroffen ist der FinTS-Pfad (Bankanbindung).

> Die App selbst bleibt MIT. Sie unter LGPL zu stellen wäre möglich, löst aber kein Problem, das
> hier noch offen wäre: die Ersetzbarkeit folgt bereits aus dem öffentlichen Quelltext. Eine
> Copyleft-Lizenz auf der App würde nur die Weiterverwendung durch andere einschränken, ohne für
> `lib-fints` etwas zu gewinnen.

### `@anthropic-ai/claude-agent-sdk` — „All rights reserved" → nicht mitgeliefert

Die `LICENSE.md` des Pakets lautet wörtlich:

> © Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here:
> <https://code.claude.com/docs/en/legal-and-compliance>

Das ist eine Erlaubnis zur **Nutzung**, keine zur **Weitergabe**. Anthropics Commercial Terms regeln
die Nutzung des Dienstes — nicht das Recht, Anthropics npm-Paket im eigenen Installationspaket an
Dritte weiterzureichen. „All rights reserved" heißt im Zweifel: nicht weitergeben.

Deshalb ist das SDK eine `optionalDependency` und im Build `--external`. Das Bundle enthält nur noch
den Import-Namen, nicht den Code. Wer den Assistenten will, installiert es selbst; ohne SDK sagt die
App das in einem Satz und funktioniert im Übrigen vollständig weiter — was der Anspruch „ohne KI
benutzbar" ohnehin verlangt.

Wer die Rechtslage anders beurteilt, macht es mit einer Zeile in `package.json` rückgängig.

## Vermerkt

- `domrobot-client` trägt kein `license`-Feld, die README sagt MIT. Als Tatsache vermerkt, nicht als
  Entscheidung; die fehlende maschinenlesbare Angabe gehört bei INWX gemeldet.
