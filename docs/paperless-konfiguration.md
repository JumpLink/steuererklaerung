# Paperless-NGX Konfiguration

Vorgeschlagene Ablagestruktur in Paperless-NGX. Beschrieben ist das **Schema** — welche Tags,
Korrespondenten und Dokumenttypen es gibt und wozu. Die konkreten numerischen IDs der eigenen
Instanz (und welcher Tag welche Nummer hat) stehen in der gitignorierten `steuererklaerung.json`
unter `paperless.tag_ids` / `custom_field_ids` / `document_type_ids`; `paperless list-tags`
liest sie aus der laufenden Instanz aus.

## Tags

* `Buchhaltung`: Übergeordneter Tag.
* `Eingangsrechnung`: Rechnungen, die wir bezahlen müssen.
* `Ausgangsrechnung`: Rechnungen, die wir gestellt haben.
* `Einnahme`: Einnahmen, Auszahlungsbestätigungen (z.B. Shopify Payouts, Affiliate-Provisionen).
* `Referral`: Empfehlungsprovisionen / Referral-Commissions (z.B. Shopify Development Store Referrals).
* `Steuer`: Steuerbescheide, Korrespondenz mit dem Finanzamt.
* `Bezahlt`: Status-Tag für erledigte Zahlungen.
* `Shopify`: Tag für Shopify-bezogene Dokumente.
* `2025`, `2026`: Jahres-Tags zur schnellen Filterung.

## Korrespondenten
* Namen der Lieferanten und Kunden pflegen.
* Beispiele: `Shopify`, `PayPal`, `Stripe`, etc.

## Dokumententypen
* `Rechnung`
* `Vertrag`
* `Bescheid`
* `Kontoauszug`
* `Einnahmenübersicht`: Für Einnahmen-Dokumente wie Shopify Payouts, Affiliate-Provisionen, etc.

## Speicherpfade (Storage Paths)
* Es empfiehlt sich, Buchhaltungsdokumente in einer festen Struktur auf dem Dateisystem abzulegen (z.B. `Jahre/2025/Eingang`), falls Paperless die Dateien exportiert.
