# PDF-Kontoauszüge per FinTS ins DMS

`steuer fints statements` holt die elektronischen Kontoauszüge (PDF) der Bank per FinTS
(HKEKA/HIEKA) und legt sie über den DMS-Provider der Entität ab — nie direkt in Paperless.

> **Jeder Abruf löst eine TAN-Freigabe aus** (SecureGo o. ä.). Nur starten, wo sie bestätigt
> werden kann.

## Aufruf

```bash
steuer fints statements --entity <id>                 # Trockenlauf: zeigt, was fehlt
steuer fints statements --entity <id> --apply         # lädt fehlende Auszüge hoch
steuer fints statements --entity <id> --gaps          # fehlende Nummern, ohne Bankkontakt
```

| Option | Wirkung |
|--------|---------|
| `--entity` | Entität, deren DMS verwendet wird (Standard: die Standard-Entität). |
| `--account`, `--account-number` | Nur diese FinTS-Konfiguration bzw. dieses Konto. |
| `--from YYYY-MM-DD` | Auszüge überspringen, die vor diesem Tag enden. |
| `--apply` | Schreiben. Ohne die Option bleibt es beim Plan. |
| `--gaps` | Lücken in der Auszugsnummerierung je Konto und Jahr (nur DMS). |
| `--acknowledge` | Empfangsbestätigung. **Noch nicht unterstützt** (lib-fints hat keinen HKEKQ-Aufruf); die Option bricht mit einer Meldung ab. |

## Ablage

- Dokumenttyp **Kontoauszug** (muss im DMS existieren, sonst Fehler), Tag **Neu**.
- Korrespondent = Name der Bank, **nur wenn er bereits existiert**; sonst Hinweis, nichts wird angelegt.
- Titel: `Kontoauszug <Konfigname> <Kontonummer> <Jahr>/<Nr>`.

## Doppelte vermeiden

Das DMS hat keine freien Zusatzfelder, daher ist der Titel die Identität: ein Auszug, dessen
Titel schon unter dem Typ „Kontoauszug" existiert, wird nicht erneut hochgeladen. Identische
Bytes fängt zusätzlich die Prüfsumme des DMS ab; das zählt als „schon vorhanden", nicht als Fehler.

## Fehler

Bietet die Bank kein HIEKAS oder kein PDF-Format an, bricht der Abruf pro Konto mit einer
klaren Meldung ab; andere Konten laufen weiter.

## MCP

`dms_plan_fints_statements` (Plan, schreibt nichts, löst aber eine TAN aus; Parameter `gaps`)
und `dms_apply_fints_statements` (schreibt; hinter dem Read-only-Gate gesperrt).
