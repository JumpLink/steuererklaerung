/**
 * Centralized AI prompts for Paperless document processing (invoice extraction, metadata review).
 * All prompt text used by the CLI when calling LLMs lives here for easier maintenance and consistency.
 */

import { ACCOUNTING_CATEGORY_OPTIONS } from './select-field-constants.ts';

export type PromptLanguage = 'de' | 'en';

// -----------------------------------------------------------------------------
// Invoice field extraction (paperless-extract-invoice, review-metadata type handlers)
// -----------------------------------------------------------------------------

// Single source of truth for the category enum embedded in the prompt — keeps it
// from drifting out of sync with ACCOUNTING_CATEGORY_OPTIONS (the hand-written
// selection hints in the prompt are guarded by a drift test).
const ACCOUNTING_CATEGORY_ENUM = ACCOUNTING_CATEGORY_OPTIONS.map((c) => `"${c}"`).join(', ');

export const INVOICE_EXTRACTION_SYSTEM_PROMPT = `You extract structured data from invoice/receipt OCR text (German or international).
Return a single JSON object with exactly these keys (use empty string or omit if not found):
- invoice_number: string (Rechnungsnummer / invoice number — the UNIQUE identifier for THIS specific invoice)
- invoice_date: string (YYYY-MM-DD only — the date printed on the invoice, "Rechnungsdatum")
- due_date: string (Fälligkeitsdatum, YYYY-MM-DD only)
- currency: string (ISO 4217 code of the invoice currency, e.g. EUR, USD, CHF – from "Total due", "Betrag", or currency symbol in the document; do not assume EUR)
- total_net: number (Betrag netto, numeric only, in the invoice's currency)
- total_gross: number (Betrag brutto / total amount due on THIS document, numeric only, in the invoice's currency)
- tax_amount: number (Umsatzsteuer / tax amount, numeric only, in the invoice's currency)
- tax_rate: string (must be exactly "0%", "5%", "7%", "16%", or "19%" — the German VAT rate on the invoice; use "0%" if explicitly tax-exempt or Reverse Charge; 5% and 16% are temporary COVID rates from July–December 2020)
- customer_number: string (Kundennummer / customer ID if present)
- service_period_start: string (YYYY-MM-DD, first day of the Leistungszeitraum; for monthly e.g. "12/2025" → "2025-12-01"; for ranges like "01.02.2026 - 01.03.2027" → "2026-02-01"; omit if not found)
- service_period_end: string (YYYY-MM-DD, last day of the Leistungszeitraum; for monthly e.g. "12/2025" → "2025-12-31"; for ranges like "01.02.2026 - 01.03.2027" → "2027-03-01"; omit if not found)
- supplier_country: string (ISO 3166-1 alpha-2 country code of the SUPPLIER/SELLER, derived from their address on the invoice, e.g. "DE", "US", "NL", "FR". Look at the sender/company address, NOT the billing address)
- supplier_vat_id: string (The supplier's VAT ID / USt-IdNr. as printed on the invoice, e.g. "DE123456789", "FR12345678901". NOT the customer's VAT ID)
- reverse_charge: boolean (true if the invoice explicitly states Reverse Charge / "Steuerschuldnerschaft des Leistungsempfängers" / "VAT reverse charge" / tax-exempt due to §13b UStG. Also true if supplier is outside Germany and charges 0% tax. false otherwise)
- sale_type: string (must be exactly "GOODS" or "SERVICES" — "GOODS" if the invoice is for physical products/materials/equipment, "SERVICES" if for services/consulting/subscriptions/hosting/software. Use "SERVICES" when unsure)
- accounting_category: string (must be exactly one of: ${ACCOUNTING_CATEGORY_ENUM}. Select by content and supplier: outgoing invoice 19% VAT → "8400 Erlöse 19% USt"; outgoing 7% → "8300 Erlöse 7% USt"; outgoing reverse charge/§13b → "8336 Erlöse Reverse Charge"; tax-free foreign/EU sales → "8125 Steuerfreie Auslandsumsätze"; interest/other income → "8500 Sonstige Erträge/Zinsen"; subcontractor/freelancer invoices → "4946 Fremdleistungen"; tax advisor / legal / bookkeeping → "4950 Rechts-/Beratungskosten"; payroll → "4100 Personalkosten (Löhne/Gehälter)"; social contributions → "4138 Soziale Abgaben"; office rent / Betriebskostenabrechnung / Heizkosten → "4210 Miete/Raumkosten"; electricity/gas/water → "4240 Gas/Strom/Wasser"; insurance → "4360 Versicherungen"; Künstlersozialkasse / professional-body dues → "4380 Beiträge/Künstlersozialkasse"; car costs → "4500 Kfz-Kosten"; advertising/marketing (Instagram, ads) → "4600 Werbe-/Marketingkosten"; travel → "4670 Reisekosten"; client meals → "4654 Bewirtungskosten"; hosting/cloud → "4806 Hosting/Cloud"; phone/internet → "4921 Telefon/Internet"; office supplies/postage → "4930 Bürobedarf"; training/books → "4940 Fortbildung/Fachliteratur"; domains → "4955 Domains"; software/licenses → "4964 Software/Lizenzen"; bank fees → "4970 Nebenkosten Geldverkehr"; other operating expense → "4650 Sonstige Betriebsausgaben"; equipment > €250 → "0420 Büroeinrichtung/GWG"; depreciation → "4830 Abschreibungen (AfA)"; owner draw → "1800 Privatentnahme"; owner deposit → "1810 Privateinlage"; transfer between own accounts → "1360 Interne Überweisung"; VAT payment/refund to tax office → "1789 Umsatzsteuer-Zahllast (Finanzamt)"; trade tax → "2150 Gewerbesteuer")

IMPORTANT RULES:
1. Sammelrechnung (collective invoice): If the document contains MULTIPLE sub-invoices or line items with separate invoice numbers, extract the data for the OVERALL document — use the main Rechnungsnummer (the one at the top/header), the total "Zu zahlender Gesamtbetrag" as total_gross, and the overall tax sum. Do NOT use a sub-invoice number.
2. Recurring invoices (e.g. monthly phone bills): Each month's invoice has its OWN unique invoice number and date, even if the customer number or contract number stays the same. Extract the invoice_number that is UNIQUE to this billing period, not a contract number or customer number. A Vertragsnummer or Kundennummer is NOT an invoice_number.
3. Payment receipts vs invoices: If the document is a payment confirmation (Zahlungsbeleg, Klarna Kontoauszug, PayPal receipt) that references another invoice, extract the payment document's own reference number, NOT the referenced invoice number.
4. total_gross must be the final amount due on THIS document ("Zu zahlender Gesamtbetrag", "Total due", "Rechnungsbetrag"). Not a sub-total or partial amount.
5. supplier_country: Determine from the supplier's postal address or country name on the invoice. Common mappings: "Deutschland"/"Germany" → "DE", "France"/"Frankreich" → "FR", "United States" → "US", "Netherlands"/"Niederlande" → "NL", "Ireland"/"Irland" → "IE". If the address says a German city but no country, assume "DE".
6. reverse_charge: If the supplier is outside Germany (supplier_country ≠ "DE") and the invoice shows 0% tax or no tax line, set reverse_charge to true. German invoices with 19% or 7% USt are never Reverse Charge.

Do not include any text outside the JSON object.`;

/**
 * Build a user prompt that includes Qonto transaction context alongside the OCR content.
 * This helps the LLM cross-check amounts and avoid extraction errors.
 */
export function buildInvoiceExtractionUserPrompt(
  ocrContent: string,
  qontoContext?: {
    amount: number;
    currency: string;
    label?: string;
    reference?: string | null;
    settledAt?: string;
    category?: string;
  },
): string {
  const parts: string[] = [];

  if (qontoContext) {
    const lines = [
      'Bank transaction context (for cross-checking, do NOT use as invoice fields):',
      `  Amount: ${qontoContext.amount.toFixed(2)} ${qontoContext.currency}`,
    ];
    if (qontoContext.label) lines.push(`  Label: ${qontoContext.label}`);
    if (qontoContext.reference) lines.push(`  Reference: ${qontoContext.reference}`);
    if (qontoContext.settledAt) lines.push(`  Settled: ${qontoContext.settledAt}`);
    if (qontoContext.category) lines.push(`  Bank category: ${qontoContext.category} (hint for accounting_category)`);
    lines.push('');
    lines.push('Extract the invoice fields from the document text below, NOT from the bank context above.');
    parts.push(lines.join('\n'));
  }

  parts.push(ocrContent);
  return parts.join('\n\n');
}

// -----------------------------------------------------------------------------
// Document classification (paperless classify-documents)
// -----------------------------------------------------------------------------

export const DOCUMENT_CLASSIFICATION_SYSTEM_PROMPT = `You classify documents based on their OCR text content.
You are given a list of available document types with their IDs and names.
Analyze the document content and determine which document type fits best.

Return a single JSON object with exactly these keys:
- document_type_id: number or null (the ID of the best matching document type from the list, or null if none fits)
- confidence: string ("high", "medium", or "low")
- reason: string (brief explanation in the document's language why this type was chosen)

Rules:
- Choose the MOST SPECIFIC type that matches. For example, prefer "Incoming Invoice" over a generic "Document" type.
- Invoices, receipts, and bills from other companies/services TO us = incoming invoice (Eingehende Rechnung).
- Invoices FROM us to customers = outgoing invoice (Ausgehende Rechnung).
- If the document is clearly not matching any available type, return document_type_id: null.
- Bank fee statements (Qonto, N26, etc.) with a specific amount and date ARE invoices (incoming).
- Scanned personal documents, school documents, insurance letters, etc. are NOT invoices.
- Look at the actual content, not just the filename.

Do not include any text outside the JSON object.`;

/**
 * Build user prompt for document classification with available types list.
 */
export function buildDocumentClassificationUserPrompt(
  ocrContent: string,
  documentTypes: Array<{ id: number; name: string }>,
  currentType?: { id: number; name: string } | null,
): string {
  const parts: string[] = [];

  parts.push('Available document types:');
  for (const dt of documentTypes) {
    parts.push(`  ${dt.id}: ${dt.name}`);
  }
  parts.push('');

  if (currentType) {
    parts.push(`Current document type: ${currentType.name} (ID: ${currentType.id})`);
    parts.push('Only change the type if the content clearly does not match the current type.');
    parts.push('');
  } else {
    parts.push('No document type is currently set.');
    parts.push('');
  }

  parts.push('Document content:');
  parts.push(ocrContent);

  return parts.join('\n');
}

// -----------------------------------------------------------------------------
// Metadata review (paperless review-metadata)
// -----------------------------------------------------------------------------
// Correspondent rules: invoices → sender (incoming) / customer (outgoing); never own IDs for outgoing.
// Pay slip (Gehaltsabrechnung) → issuer (employer/payroll), not health insurance (Krankenkasse).

export const REVIEW_METADATA_SYSTEM_PROMPT_DE = `Du analysierst Dokumente und gibst Metadaten-Empfehlungen. Antworte NUR mit einem einzelnen JSON-Objekt ohne weiteren Text.
Keys: title (string, aussagekräftiger Kurztitel), correspondent_id (number oder null), correspondent_create_name (string nur wenn neuer Korrespondent), document_type_id (number oder null), document_type_create_name (string nur wenn neuer Typ), created (YYYY-MM-DD oder null), add_tag_ids (array of numbers, optional).
Regeln: Wähle bevorzugt aus der angegebenen Liste (correspondent_id / document_type_id). Nur wenn kein passender existiert, einen neuen Namen in correspondent_create_name / document_type_create_name vorschlagen (keine Duplikate). created nur setzen wenn im Dokument ein klares Datum erkennbar ist, sonst null. Titel: erkennbar worum es geht, nicht nur Dateiname.
Dokumenttyp: Wenn bereits ein Dokumenttyp gesetzt ist (siehe Current metadata) und er zum Inhalt passt (z. B. Schulinformation bei Schulthemen, Spendennachweis bei Spenden, Tabellenkalkulation bei Tabellen/Spreadsheets), gib genau diese document_type_id zurück und ändere den Typ nicht. Einen anderen document_type_id schlage nur vor, wenn der aktuelle Typ offensichtlich falsch ist oder kein Typ gesetzt ist. Spezifische Typen (z. B. Schulinformation, Spendennachweis, Tabellenkalkulation) nicht durch allgemeinere (z. B. Information) ersetzen. Nur ändern, wenn der Inhalt eindeutig nicht zum aktuellen Typ passt.
Korrespondent: Die folgenden Regeln gelten NUR für Dokumente vom Typ "Eingehende Rechnung" bzw. "Ausgehende Rechnung". Bei eingehenden Rechnungen = Korrespondent ist der Absender (von wem die Rechnung kommt). Bei ausgehenden Rechnungen = Korrespondent ist immer der Zielkunde/Empfänger der Rechnung (an wen die Rechnung gerichtet ist), niemals der Aussteller (wir). Die "Own correspondent IDs" (unser Unternehmen) dürfen bei ausgehenden Rechnungen niemals als correspondent_id gesetzt werden. Bei allen anderen Dokumenttypen (AGB, Information, Tabellenkalkulation, …) diese Rechnungs-Regeln NICHT anwenden: Wenn bereits ein Korrespondent gesetzt ist und er zum Dokument passt (z. B. eigenes Unternehmen bei AGB oder Verträgen von uns), diesen beibehalten. Nicht pauschal durch "Kunde" ersetzen.
Gehaltsabrechnung: Korrespondent ist der Aussteller der Abrechnung (Arbeitgeber, Lohnbuchhaltung, Lohnservice), nicht die Krankenkasse (z. B. AOK) oder andere auf der Abrechnung genannte Institutionen (Rentenversicherung etc.).
Inhalts-Tags (add_tag_ids): Es wird eine Liste "Content tags" mit Tag-IDs und Bedeutungen gegeben. Füge in add_tag_ids nur IDs aus dieser Liste ein, die eindeutig zum Dokument passen: schulbezogen (z. B. Zeugnis, Schule, Schüler) → school-ID; finanzbezogen (Rechnungen, Buchhaltung, Steuern) → finance-ID; server-/Infrastruktur-bezogen → server_infrastructure-ID; eindeutig nicht archivwürdig (z. B. Quellcode, versehentlich hinzugefügt, Infoschreiben ohne Langzeitwert) → irrelevant-ID. Keine ID angeben oder leeres Array, wenn keiner passt. Nur IDs aus der Liste verwenden.`;

export const REVIEW_METADATA_SYSTEM_PROMPT_EN = `You analyze documents and provide metadata recommendations. Respond ONLY with a single JSON object, no other text.
Keys: title (string, descriptive short title), correspondent_id (number or null), correspondent_create_name (string only if new correspondent), document_type_id (number or null), document_type_create_name (string only if new type), created (YYYY-MM-DD or null), add_tag_ids (array of numbers, optional).
Rules: Prefer selecting from the given list (correspondent_id / document_type_id). Only if no match exists, suggest a new name in correspondent_create_name / document_type_create_name (no duplicates). Set created only when a clear date is found in the document, otherwise null. Title: make clear what the document is about, not just the filename.
Document type: If a document type is already set (see Current metadata) and it fits the content (e.g. Schulinformation for school-related, Spendennachweis for donation receipt, Tabellenkalkulation for spreadsheet), return that same document_type_id and do not change it. Only suggest a different document_type_id when the current type is clearly wrong or missing. Do not replace specific types (e.g. Schulinformation, Spendennachweis, Tabellenkalkulation) with more generic ones (e.g. Information). Only change when the content clearly does not match the current type.
Examples: Current type Tabellenkalkulation (20), content is a table/spreadsheet → return document_type_id: 20. Current type Schulinformation (6), content about school → return document_type_id: 6. A spreadsheet that contains invoice data should still keep type Tabellenkalkulation (do not switch to invoice).
Correspondent: The following rules apply ONLY when the document type is "Incoming invoice" or "Outgoing invoice". For incoming invoices: correspondent = sender (who the invoice is from). For outgoing invoices: correspondent = the addressee/customer (who the invoice is addressed to), never the issuer (us). "Own correspondent IDs" (our company) must never be set as correspondent_id for outgoing invoices. For all other document types (AGB, Information, spreadsheet, …) do NOT apply these invoice rules: if a correspondent is already set and fits the document (e.g. own company for AGB or contracts we issued), keep it. Do not replace with "Customer" by default.
Pay slip (Gehaltsabrechnung): Correspondent is the issuer of the pay slip (employer, payroll department, payroll service), not the health insurance (e.g. AOK) or other institutions mentioned on the slip (pension fund, etc.).
Content tags (add_tag_ids): A "Content tags" list with tag IDs and meanings will be given. Include in add_tag_ids only IDs from that list that clearly fit the document: school-related (e.g. report card, school, pupil) → school ID; finance-related (invoices, accounting, taxes) → finance ID; server/infrastructure-related → server_infrastructure ID; clearly not worth keeping (e.g. source code, accidentally added, informational letter with no long-term value) → irrelevant ID. Omit or use empty array if none apply. Use only IDs from the list.`;

export function getReviewMetadataSystemPrompt(lang: PromptLanguage): string {
  return lang === 'de' ? REVIEW_METADATA_SYSTEM_PROMPT_DE : REVIEW_METADATA_SYSTEM_PROMPT_EN;
}

/** User-prompt label for content tags (add_tag_ids). */
export const REVIEW_METADATA_USER_LABEL_CONTENT_TAGS = 'Content tags (add_tag_ids – include only IDs that fit the document):';

/**
 * Build the content-tags block for the user prompt (school, finance, server_infrastructure, irrelevant).
 * Only includes entries whose ID is set (> 0). Used so the AI can suggest add_tag_ids.
 */
export function getReviewMetadataContentTagsBlock(
  lang: PromptLanguage,
  tagIds: { school?: number; finance?: number; server_infrastructure?: number; irrelevant?: number },
): string {
  const entries: string[] = [];
  if (tagIds.school != null && tagIds.school > 0) {
    entries.push(lang === 'de' ? `  ${tagIds.school}: school (Schule, Zeugnis, Schüler, …)` : `  ${tagIds.school}: school (school, report card, pupil, …)`);
  }
  if (tagIds.finance != null && tagIds.finance > 0) {
    entries.push(lang === 'de' ? `  ${tagIds.finance}: finance (Finanzen, Rechnungen, Buchhaltung, …)` : `  ${tagIds.finance}: finance (invoices, accounting, …)`);
  }
  if (tagIds.server_infrastructure != null && tagIds.server_infrastructure > 0) {
    entries.push(lang === 'de' ? `  ${tagIds.server_infrastructure}: server_infrastructure (Server, Infrastruktur, …)` : `  ${tagIds.server_infrastructure}: server_infrastructure (server, infrastructure, …)`);
  }
  if (tagIds.irrelevant != null && tagIds.irrelevant > 0) {
    entries.push(
      lang === 'de'
        ? `  ${tagIds.irrelevant}: irrelevant (nicht archivwürdig, z. B. Quellcode, versehentlich hinzugefügt, Infoschreiben ohne Langzeitwert)`
        : `  ${tagIds.irrelevant}: irrelevant (not worth keeping, e.g. source code, accidentally added, informational letter with no long-term value)`,
    );
  }
  if (entries.length === 0) return '';
  return [REVIEW_METADATA_USER_LABEL_CONTENT_TAGS, ...entries].join('\n');
}

/** User-prompt label for the list of existing correspondents. */
export const REVIEW_METADATA_USER_LABEL_CORRESPONDENTS = 'Existing correspondents (id: name):';

/** User-prompt label for the list of existing document types. */
export const REVIEW_METADATA_USER_LABEL_DOCUMENT_TYPES = 'Existing document types (id: name):';

/** User-prompt label for document content block. */
export const REVIEW_METADATA_USER_LABEL_DOCUMENT_CONTENT = 'Document content (OCR, normalized):';

/**
 * Hint for the user prompt: current document type with name so the AI preserves it when it fits.
 * Pass the resolved type name (from document types list) and id; when null, the AI is told no type is set.
 */
export function getReviewMetadataCurrentTypeHint(
  lang: PromptLanguage,
  typeName: string | null,
  typeId: number | null,
): string {
  if (typeId == null || typeName == null) {
    return lang === 'de'
      ? 'Aktuell ist kein Dokumenttyp gesetzt; du kannst einen vorschlagen.'
      : 'No document type is set; you may suggest one.';
  }
  return lang === 'de'
    ? `Aktueller Dokumenttyp: ${typeName} (${typeId}). Nur einen anderen document_type_id vorschlagen, wenn das Dokument offensichtlich nicht zu diesem Typ passt.`
    : `Current document type: ${typeName} (${typeId}). Only suggest a different document_type_id if the document clearly does not match this type.`;
}

/**
 * Builds the "own correspondent IDs" hint for the user prompt.
 * Instructs the model: for outgoing invoice never use these IDs (correspondent = customer); for incoming = sender.
 */
export function getReviewMetadataOwnBlock(lang: PromptLanguage, ownCorrespondentIds: number[]): string {
  if (ownCorrespondentIds.length === 0) return '';
  const ids = ownCorrespondentIds.join(', ');
  return lang === 'de'
    ? `Eigene Korrespondenten-IDs (unser Unternehmen / wir selbst): ${ids}. Bei Ausgehende Rechnung diese IDs NIEMALS als correspondent_id setzen – Korrespondent ist immer der Zielkunde/Empfänger. Bei Eingehende Rechnung = Absender. Bei allen anderen Dokumenttypen bestehenden Korrespondenten beibehalten wenn passend (z. B. wir bei AGB), nicht durch "Kunde" ersetzen.`
    : `Own correspondent IDs (user's own company / ourselves): ${ids}. For outgoing invoice never set these as correspondent_id – correspondent is always the addressee/customer. For incoming invoice = sender. For all other document types keep existing correspondent if it fits (e.g. us for AGB), do not replace with "Customer".`;
}

// -----------------------------------------------------------------------------
// MCP prompts (single source of truth)
// -----------------------------------------------------------------------------
// These strings back the MCP prompts registered in src/frontends/mcp/prompts.ts.
// Both AI-usage modes draw from this file: the app's own review-metadata action
// consumes REVIEW_METADATA_SYSTEM_PROMPT_* directly, while an external agent
// (Claude Code) drives the same workflow through these MCP prompts + the
// paperless_* / document-workflow MCP tools. Keep the canonical wording HERE so
// the server never duplicates prompt text.

/**
 * Usage note appended to the review-metadata system prompt when it is exposed as
 * an MCP prompt. Tells an external agent how to drive the same review the app
 * runs internally — read/map/write via the paperless_* tools and record the
 * rationale into the `ai_note` (KI-Hinweis) custom field.
 */
export const REVIEW_METADATA_MCP_USAGE_NOTE = `So wendest du diese Regeln über den steuererklaerung-MCP an (pro Dokument):
1. Lesen: paperless_get_document → OCR-Inhalt + aktuelle Metadaten/Custom-Fields.
2. Namen → IDs auflösen: paperless_list_correspondents / paperless_list_document_types / paperless_list_tags.
3. Empfehlung nach obigen Regeln bilden (Titel, correspondent_id, document_type_id, created, add_tag_ids).
4. Schreiben: paperless_update_document mit sprechenden Feldnamen.
5. Begründung festhalten: Setze das Feld "ai_note" (KI-Hinweis) auf EINE knappe deutsche Zeile (< 200 Zeichen), die sagt, WAS geändert wurde und woher es stammt, z. B. «KI-Review <Datum>: Korrespondent «X», Typ «Eingangsrechnung», Rechnungsnr. erkannt. Modell «claude-…».». Bei jedem Review frisch überschreiben.
Dieselben Regeln laufen headless über die CLI: paperless review-metadata (schreibt ai_note automatisch).`;

/**
 * Full text of the `review_document_metadata` MCP prompt: the metadata-review
 * system rules (single source above) plus the usage note. Defaults to German to
 * match the app's default review language.
 */
export function getReviewDocumentMetadataPromptText(lang: PromptLanguage = 'de'): string {
  return `${getReviewMetadataSystemPrompt(lang)}\n\n${REVIEW_METADATA_MCP_USAGE_NOTE}`;
}

/**
 * Full text of the `enrich_paperless_documents` MCP prompt: the higher-level
 * batch workflow for working through Paperless documents and enriching them.
 * Canonical, condensed version of the document-workflow guidance — kept here so
 * prompts.ts stays the single source of truth for MCP prompt text.
 */
export const ENRICH_PAPERLESS_DOCUMENTS_PROMPT = `Arbeite eine Menge Paperless-Dokumente durch und reichere sie an. Paperless ist das gemeinsame Gedächtnis: schreibe dauerhafte Schlüsse als Metadaten zurück, damit der nächste Lauf darauf aufbaut. Generischer Ablauf, keine Einzelfall-Skripte — wende Urteilsvermögen an.

Auswahl der Dokumente:
- tag:Neu (oder ein anderer Tag) → paperless_search_documents nach dem Tag.
- Korrespondentenname → paperless_list_correspondents auflösen, dann suchen.
- explizite IDs / ein Bereich (z. B. 2791-2797) → direkt darauf arbeiten.
- ohne Argument: standardmäßig der "Neu"-Eingang.

Schritte pro Dokument:
1. Analysieren: paperless_get_document (OCR + aktuelle Custom-Fields). Einmalig paperless_list_tags / _document_types / _correspondents für Namen→IDs.
2. Klassifizieren & routen: Dokumenttyp und data_scope (privat | geschäftlich | gemischt) bestimmen — das entscheidet den Abschluss-Schritt.
3. Verwandtes finden: paperless_search_documents nach Kundennummer, Korrespondent, Beträgen oder Zeitraum. Besonders Rechnung ↔ Storno und Bescheid ↔ Aufhebungsbescheid.
4. Validieren: Liegt ein früherer Schluss vor (menschliche Notiz oder eine andere KI), leite die Kernzahlen selbst aus dem OCR neu her (Verbrauch/Zähler, Salden, tatsächlich fälliger Betrag, Fristen) und bestätige oder widerlege. Nie Zahlen ungeprüft durchreichen.
5. Anreichern (nach Bestätigung schreiben): paperless_update_document mit sprechenden Feldnamen — data_scope, payment_status, amount_to_pay, ai_note (knappe deutsche Begründung, < 200 Zeichen), ai_confidence, ai_reviewed_at (heute), plus Tags (tags komplett ersetzen: read-modify-write). link_documents für Beziehungen (relation:"cancels" auf dem Storno; relation:"related" für Verweise). Widerspricht deine Neuberechnung einer früheren Aussage, Tag "KI-Konflikt" setzen und in ai_note erklären — Zahlen nicht still "korrigieren".
6. Abschluss nach Domäne:
   - Privat: Aktionsliste (wer, wie viel, bis wann); pro offenem Betrag generate_sepa_qr (Scan-to-Pay). NIE an Qonto pushen.
   - Geschäftlich: an die bestehende Pipeline übergeben — match_transaction_to_document, get_reconciliation_status, USt/ELSTER-Fluss.

Datenschutz: Private Dokumente nie in Geschäftssysteme pushen. Keine vollständigen Dokumentinhalte, IBANs, Kundennummern oder Finanzsummen ungefragt an den Nutzer zurückgeben — Zusammenfassungen und die Aktionsliste sind ok. Nie automatisch bezahlen (GiroCodes sind Scan-to-Pay, der Nutzer bestätigt in der Banking-App).

Jede KI-Metadatenentscheidung hält ihre Begründung in ai_note (KI-Hinweis) fest.`;
