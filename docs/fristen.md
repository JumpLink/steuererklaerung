# Fristen und Termine

Die gesetzlichen Abgabetermine, gegen die `elster fristen` bzw. die „Fristen"-Ansicht rechnet.
Welcher Turnus für eine Entität gilt (monatlich / vierteljährlich / jährlich) und ob eine
Dauerfristverlängerung vorliegt, steht in ihrer `elster`-Sektion in `steuererklaerung.json` —
hier steht nur, was daraus folgt.

## Umsatzsteuer-Voranmeldung (USt-VA)
**Turnus:** Vierteljährlich (der hier beispielhaft angenommene Fall)
**Fälligkeit:** Bis zum 10. des Folgemonats nach Quartalsende.

| Zeitraum | Quartal | Abgabe & Zahlung bis |
| :--- | :--- | :--- |
| **Q4 / 2025** | Okt - Dez 2025 | **10. Januar 2026** |
| **Q1 / 2026** | Jan - Mär 2026 | **10. April 2026** |
| **Q2 / 2026** | Apr - Jun 2026 | **10. Juli 2026** |
| **Q3 / 2026** | Jul - Sep 2026 | **10. Oktober 2026** |
| **Q4 / 2026** | Okt - Dez 2026 | **10. Januar 2027** |

### Dauerfristverlängerung
Konfiguriert je Entität über `elster.ust_dauerfristverlaengerung` (Einrichtung → Betrieb oder
Einstellungen). `elster.deadline_extension_months` ist etwas anderes: die Fristverlängerung der
Jahreserklärungen.

* **Antrag:** Dauerfristverlängerung um einen Monat für USt-Voranmeldung und Vorauszahlungen
* **Vorteil:** Fristen verschieben sich um einen Monat (z.B. 10. Januar -> 10. Februar)
* **Kosten:** Für Quartalszahler kostenlos
* **Hinweis:** Nach Genehmigung gelten die verlängerten Fristen dauerhaft

### Keine Voranmeldung
* **Kleinunternehmer** (`invoicing.self.issuer.kleinunternehmer`): keine USt-VA und keine
  Umsatzsteuererklärung; die Anlage EÜR bleibt.
* **Vom Finanzamt befreit** (`elster.ust_va_befreit`, Einrichtung „Keiner, nur Jahreserklärung"):
  keine USt-VA, die Umsatzsteuererklärung bleibt.

Grenzen und Quellen: [references/tax-sources.md](references/tax-sources.md), Abschnitt §18/§19 UStG.

## Jährliche Steuererklärungen
**Fälligkeit:** In der Regel bis 31. Juli des Folgejahres (kann variieren, bitte prüfen).

* **Einnahmenüberschussrechnung (EÜR)**
* **Umsatzsteuererklärung**
* **Einkommensteuererklärung**
* **Gewerbesteuererklärung** (nur wenn Gewinn > 24.500 EUR)

## Fristen-Wächter: Erinnerung und Kalender

Die offenen Posten aus Paperless (`payment_status = offen`, mit Fälligkeitsdatum) lassen sich als
Desktop-Benachrichtigung und als Kalender-Feed ausgeben. Beides liest nur.

```sh
steuer fristen notify [--lead 7] [--print]
steuer fristen ics --out ~/.local/share/steuer/fristen.ics
```

- **`fristen notify`** meldet in einer Benachrichtigung, wie viele Posten überfällig oder innerhalb von
  `--lead` Tagen (Standard 7) fällig sind, mit Korrespondent, Titel, Fälligkeit und Betrag. Ist nichts
  fällig, passiert nichts (Ausgabe „Nichts fällig.", Exit-Code 0). Lässt sich die Benachrichtigung nicht
  zustellen (kein Desktop, kein Benachrichtigungsdienst), steht der Inhalt auf der Konsole und der
  Exit-Code ist 1. `--print` zeigt den Text nur an.
- **`fristen ics --out <Datei>`** schreibt je Posten mit Fälligkeit einen ganztägigen Termin am echten
  Fälligkeitstag, mit Erinnerung 3 Tage vorher. Überfällige Posten behalten ihr Datum und beginnen mit
  „ÜBERFÄLLIG: ". Die Termin-ID leitet sich aus der Paperless-ID ab; ein erneuter Lauf aktualisiert
  die Einträge, statt sie zu verdoppeln.

Zum regelmäßigen Ausführen taugt ein Timer des Systems (z. B. ein systemd-User-Timer, der erst `ics`,
dann `notify` aufruft).
