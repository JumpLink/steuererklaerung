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
