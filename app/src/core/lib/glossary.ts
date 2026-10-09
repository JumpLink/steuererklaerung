// Plain-German explanations of the tax/accounting terms — the SHARED glossary, used by the web
// <bh-help> popovers, the native "?" glossar button, the assistant, and a future Hilfe view.
// Pure data, no browser/GTK deps, so every frontend + the core can import it. Kept intentionally
// COMPLETE — a few entries (e.g. rohertrag, nachtraeglich-24) have no inline "?" yet. Keep each
// text short, concrete, jargon-free.

export interface GlossaryEntry {
    title: string;
    text: string;
}

export const GLOSSARY: Record<string, GlossaryEntry> = {
    euer: {
        title: 'Anlage EÜR',
        text: 'Einnahmen-Überschuss-Rechnung: Gewinn = Betriebseinnahmen − Betriebsausgaben (gezählt wird, wann das Geld fließt — §4 Abs. 3 EStG). Die einfache Gewinnermittlung für kleine Betriebe.',
    },
    gewinn: {
        title: 'Gewinn (EÜR)',
        text: 'Betriebseinnahmen minus Betriebsausgaben (netto). Die Grundlage für Einkommen- und Gewerbesteuer.',
    },
    'ust-zahllast': {
        title: 'USt-Zahllast',
        text: 'Vereinnahmte Umsatzsteuer minus gezahlte Vorsteuer. Positiv = du zahlst ans Finanzamt, negativ = du bekommst zurück.',
    },
    vorsteuer: {
        title: 'Vorsteuer',
        text: 'Die Umsatzsteuer, die dir andere in Rechnung gestellt haben. Du holst sie vom Finanzamt zurück — wenn du die Rechnung (Beleg) aufbewahrst.',
    },
    'vereinnahmte-ust': {
        title: 'Vereinnahmte USt',
        text: 'Die Umsatzsteuer, die du deinen Kunden berechnet und erhalten hast. Sie gehört dem Finanzamt.',
    },
    abschlusszahlung: {
        title: 'Abschlusszahlung',
        text: 'USt-Zahllast des Jahres minus die unterjährig schon geleisteten Vorauszahlungen — der Rest, der mit der Jahreserklärung fällig wird (oder erstattet wird).',
    },
    'gewst-messbetrag': {
        title: 'Steuermessbetrag (GewSt)',
        text: 'Gewerbeertrag (abgerundet, minus 24.500 € Freibetrag) × 3,5 %. Mal dem Hebesatz der Gemeinde ergibt das die Gewerbesteuer. Unter dem Freibetrag = 0 €.',
    },
    gewerbesteuer: {
        title: 'Gewerbesteuer',
        text: 'Steuermessbetrag × Hebesatz der Gemeinde. Fällt nur an, wenn der Gewerbeertrag über dem Freibetrag von 24.500 € liegt.',
    },
    feststellung: {
        title: 'Gesonderte & einheitliche Feststellung',
        text: 'Bei einer GbR/Personengesellschaft wird der Gewinn einmal festgestellt und dann auf die Gesellschafter verteilt — jeder versteuert seinen Anteil in der eigenen Einkommensteuer.',
    },
    einkuenfte: {
        title: 'Einkünfte aus Gewerbebetrieb',
        text: 'Der festgestellte Gewinn (ggf. plus Aufgabegewinn, minus Sonderbetriebsausgaben), der auf die Gesellschafter verteilt wird.',
    },
    sonderbetriebsausgaben: {
        title: 'Sonderbetriebsausgaben',
        text: 'Ausgaben, die ein einzelner Gesellschafter für die Gesellschaft trägt (z. B. häusliches Arbeitszimmer). Sie mindern nur seinen Anteil.',
    },
    aufgabe: {
        title: 'Betriebsaufgabe',
        text: 'Wird ein Betrieb beendet, wird das verbliebene Anlagevermögen zum gemeinen Wert entnommen → Aufgabegewinn/-verlust (§16/§34 EStG, gewerbesteuerfrei, steuerbegünstigt).',
    },
    'nachtraeglich-24': {
        title: 'Nachträgliche Einkünfte (§24 Nr. 2 EStG)',
        text: 'Zahlungen, die NACH der Betriebsaufgabe noch für den alten Betrieb fließen (z. B. eine späte Kundenzahlung). Zählen weiter zum Betrieb, sind aber gewerbesteuerfrei.',
    },
    rohertrag: {
        title: 'Rohertrag',
        text: 'Gesamtleistung (Umsatz) minus Wareneinsatz/Fremdleistungen — was nach den direkten Kosten übrig bleibt.',
    },
    gesamtleistung: {
        title: 'Gesamtleistung',
        text: 'Die gesamten Betriebseinnahmen einer Periode (Umsatzerlöse + sonstige Erträge).',
    },
    betriebsergebnis: {
        title: 'Betriebsergebnis',
        text: 'Gesamtleistung minus alle Betriebskosten — das operative Ergebnis. Über das ganze Jahr entspricht es dem EÜR-Gewinn.',
    },
    bwa: {
        title: 'BWA',
        text: 'Betriebswirtschaftliche Auswertung: eine monatliche Gewinn-und-Verlust-Übersicht. Zeigt, wie sich Umsatz, Kosten und Ergebnis übers Jahr entwickeln.',
    },
    kleinunternehmer: {
        title: 'Kleinunternehmerregelung (§19 UStG)',
        text: 'Wer im Vorjahr ≤ 25.000 € Umsatz hatte (und ≤ 100.000 € im laufenden Jahr), darf ohne Umsatzsteuer arbeiten — weist dann aber keine USt aus und zieht keine Vorsteuer.',
    },
    doppelzahlung: {
        title: 'Doppelzahlung',
        text: 'Eine versehentlich doppelt bezahlte Rechnung. Die zweite Zahlung ist kein Umsatz, sondern eine Rückzahlungspflicht — sie wird aus Umsatz und USt herausgerechnet. Die App meldet verdächtige Zahlungen selbst; ein Eintrag bleibt offen, bis die Rückzahlung an den Kunden verknüpft ist.',
    },
    'vst-ohne-beleg': {
        title: 'Vorsteuer ohne Beleg',
        text: 'Ausgaben mit Vorsteuer, zu denen (noch) keine Rechnung hinterlegt ist. Für den Vorsteuerabzug musst du die Rechnung aufbewahren und auf Anforderung vorlegen können.',
    },
    afa: {
        title: 'AfA (Abschreibung)',
        text: 'Anschaffungen über 800 € netto werden nicht sofort, sondern über ihre Nutzungsdauer verteilt als Ausgabe abgesetzt — „Absetzung für Abnutzung".',
    },
    abgabefrist: {
        title: 'Abgabefrist',
        text: 'Regelfrist für die Jahreserklärungen ist der 31. Juli des Folgejahres (ohne Steuerberater). Eine gewährte Fristverlängerung verschiebt das.',
    },
    steuerkonto: {
        title: 'Steuer-Zahlungen',
        text: 'Was tatsächlich übers Bankkonto an die Finanzkasse floss (oder erstattet wurde) — zum Abgleich mit Mein ELSTER. Kein amtlicher Kontostand.',
    },
    mcp: {
        title: 'MCP (Model Context Protocol)',
        text: 'Eine offene Schnittstelle, über die externe KI-Assistenten (ChatGPT, Claude Code …) deine Buchhaltungs-Werkzeuge nutzen können. Hier stellst du ein, welche davon nach außen offen sind.',
    },
    ustva: {
        title: 'Umsatzsteuer-Voranmeldung',
        text: 'Die unterjährige Meldung der Umsatzsteuer — je nach Umsatz monatlich oder vierteljährlich. Sie ist eine Vorauszahlung; abgerechnet wird am Jahresende mit der Umsatzsteuererklärung.',
    },
    'ist-versteuerung': {
        title: 'Ist-Versteuerung',
        text: 'Die Umsatzsteuer wird fällig, wenn das Geld EINGEHT (§20 UStG) — nicht schon beim Rechnungsdatum. Schont die Liquidität und ist bis 800.000 € Umsatz möglich; das Gegenstück heißt Soll-Versteuerung.',
    },
    dauerfristverlaengerung: {
        title: 'Dauerfristverlängerung',
        text: 'Verschiebt jede Voranmeldung um einen Monat nach hinten. Wer monatlich meldet, hinterlegt dafür eine Sondervorauszahlung von 1/11 der Vorjahres-Zahllast.',
    },
    transferticket: {
        title: 'Transferticket',
        text: 'Die Quittung einer ELSTER-Übertragung. Sie belegt, dass und wann etwas angekommen ist — heb sie zu den Unterlagen des Jahres.',
    },
    snapshot: {
        title: 'Snapshot',
        text: 'Ein eingefrorenes Abbild einer Erklärung: das erzeugte XML plus die Zahlen und den Datenstand, aus dem es entstand. Ändern sich die Daten danach, meldet das Programm den Snapshot als veraltet — abgegeben wird nie etwas anderes als das Eingefrorene.',
    },
    freigabe: {
        title: 'Freigabe',
        text: 'Deine ausdrückliche Bestätigung, dass ein Snapshot abgegeben werden darf. Sie hängt am Datenstand: ändern sich die Zahlen, verfällt sie und muss neu erteilt werden.',
    },
    klassifizierung: {
        title: 'Klassifizierung',
        text: 'Die Zuordnung einer Buchung zu einer Kategorie (SKR03). Mit Beleg kommt sie vom Beleg, ohne Beleg aus Regeln — und eine eigene Umbuchung gewinnt immer.',
    },
    skr03: {
        title: 'SKR03',
        text: 'Ein verbreiteter Standardkontenrahmen. Die vierstelligen Nummern (z. B. 4930 Bürobedarf) sind die Schubladen, in die Einnahmen und Ausgaben sortiert werden.',
    },
    'privatentnahme': {
        title: 'Privatentnahme',
        text: 'Geld oder Waren, die du dem Betrieb für dich privat entnimmst. Keine Betriebsausgabe — der Gewinn ändert sich dadurch nicht.',
    },
    'frei-verfuegbar': {
        title: 'Frei verfügbar',
        text: 'Kontostand minus die Umsatzsteuer seit der letzten Voranmeldung, minus fällige Steuerzahlungen, minus offene Eingangsrechnungen — was davon nicht schon dem Finanzamt oder Lieferanten gehört. Eine Rechnung, keine Empfehlung; die Herleitung zeigt jeden Posten.',
    },
    steuerruecklage: {
        title: 'Steuerrücklage',
        text: 'Geschätzte Einkommen- und Gewerbesteuer des Jahres minus schon gezahlte Vorauszahlungen, also was der Bescheid voraussichtlich noch fordert (negativ: Erstattung). Nur eine Rechnung, keine Buchung: es wird kein Geld verschoben.',
    },
    anlagegut: {
        title: 'Anlagegut',
        text: 'Etwas Angeschafftes, das länger als ein Jahr genutzt wird (Rechner, Möbel). Es wird nicht sofort abgezogen, sondern über die Nutzungsdauer verteilt — siehe AfA.',
    },
    gwg: {
        title: 'GWG (geringwertiges Wirtschaftsgut)',
        text: 'Ein Anlagegut bis 800 € netto (ohne abziehbare Vorsteuer), das selbständig nutzbar ist — es darf im Jahr der Anschaffung voll abgezogen werden (§ 6 Abs. 2 EStG). Darüber wird es abgeschrieben; bis 1.000 € geht wahlweise ein Sammelposten über fünf Jahre (§ 6 Abs. 2a EStG).',
    },
    'anlagegut-kandidat': {
        title: 'Anlagegut-Kandidat',
        text: 'Eine Ausgabe über der GWG-Grenze, die nicht im Anlageverzeichnis steht — vermutlich ein Anlagegut, das abgeschrieben statt sofort abgezogen wird. Raten an denselben Händler zählen als ein Gut. Ein Vorschlag, keine Buchung: aufnehmen oder als in Ordnung markieren.',
    },
    'reverse-charge': {
        title: 'Reverse Charge (§ 13b UStG)',
        text: 'Bei Leistungen ausländischer Unternehmer schuldet der Empfänger die deutsche Umsatzsteuer, nicht der Lieferant — die Rechnung kommt ohne USt. Mit Vorsteuerabzug hebt sich das auf, anzumelden ist es trotzdem; ein Kleinunternehmer zahlt sie ohne Abzug.',
    },
    'e-rechnung': {
        title: 'E-Rechnung',
        text: 'Eine Rechnung als strukturierter Datensatz nach EN 16931 — XRechnung (reine XML-Datei) oder ZUGFeRD/Factur-X (PDF mit eingebettetem XML, nicht die Profile MINIMUM und BASIC-WL). Die App liest sie ohne KI und ohne Abtippen (§14 UStG).',
    },
    'ohne-befund': {
        title: 'Geprüft, ohne Befund',
        text: 'Ein Hinweis, der nachgesehen und nichts gefunden hat — mit dem, was geprüft wurde. Das Gegenstück heißt „nicht prüfbar, weil …": dann fehlen die Daten für die Prüfung. Beides ist besser als Schweigen, das nach „alles gut" aussieht.',
    },
    'iban-wechsel': {
        title: 'IBAN-Wechsel',
        text: 'Ein bekannter Lieferant wird plötzlich an eine IBAN bezahlt, an die bisher nie Geld ging. Meist ist es ein neues Konto, manchmal eine gefälschte Rechnung — und überwiesenes Geld ist dann kaum zurückzuholen. Darum immer unter der bisher bekannten Telefonnummer oder Adresse nachfragen, nie unter der auf der neuen Rechnung.',
    },
    'zu-pruefen': {
        title: 'Zu prüfen',
        text: 'Buchungen, die keine Regel und kein Beleg einordnet, und solche, die nur eine Auffangregel erfasst hat. Bestätigen merkt sich die Kategorie als geprüft, ohne an der EÜR etwas zu ändern; Umbuchen ändert sie.',
    },
    'laufende-kosten': {
        title: 'Laufende Kosten',
        text: 'Abbuchungen im festen Abstand an denselben Empfänger — Miete, Software, Versicherung —, die die App erkennt und die man bestätigt; bestätigte zieht Frei verfügbar ab. Nicht zu verwechseln mit den wiederkehrenden Rechnungen: das sind eigene Ausgangsrechnungen an Kunden.',
    },
    erstattung: {
        title: 'Erstattung',
        text: 'Geld, das ein Lieferant für eine frühere Zahlung zurückgibt (Rückgabe, Teilerstattung, Rückbuchung); mit „Ja" an diese Zahlung geknüpft, mindert sie deren Ausgabe samt Vorsteuer in dem Jahr und Voranmeldungszeitraum, in dem sie eingeht.',
    },
    splitbuchung: {
        title: 'Splitbuchung',
        text: 'Eine Buchung, die du in Teile mit eigenem Betrag, eigener Kategorie und eigenem Steuersatz zerlegst — etwa eine Bestellung mit betrieblichen und privaten Posten; ein Teil nimmt immer den Rest, und der private Teil zählt weder als Ausgabe noch für die Vorsteuer.',
    },
    projektergebnis: {
        title: 'Projektergebnis',
        text: 'Was ein Projekt im Zeitraum netto gebracht hat: Umsatz der Projektrechnungen minus die Kosten der zugeordneten Ausgaben (private und neutrale Teile zählen nicht), je Stunde gerechnet, wenn Zeiten erfasst sind. Eine interne Auswertung, keine Steuerzahl.',
    },
    dokumentregel: {
        title: 'Dokumentregel',
        text: 'Du legst einmal fest, was ein Beleg von einem bestimmten Absender ist — Dokumenttyp, Kategorie, Eingang oder Ausgang. Jeder spätere Beleg mit diesem Absender bekommt die Werte beim Hinzufügen automatisch, ohne KI; die KI füllt nur, was die Regel offen lässt. Bei Paperless übernimmt Paperless diese Zuordnung selbst, die App zeigt nur, welche Regel dort gegriffen hat.',
    },
    'belege-aus-mail': {
        title: 'Belege aus Mail',
        text: 'Die App liest einen Mail-Ordner und legt PDF- und E-Rechnungs-Anhänge neuer Nachrichten in den Beleg-Eingang — Regeln greifen dabei wie bei jedem hinzugefügten Beleg. Sie liest nur: nichts wird markiert, verschoben oder gelöscht, und vom Mailtext bleibt nur Absender und Datum. Mit Paperless holt Paperless die Belege selbst (dort „Mail“ einrichten).',
    },
    mahnstufe: {
        title: 'Mahnstufe',
        text: 'Wie weit eine überfällige Rechnung gemahnt ist — 1 Zahlungserinnerung (freundlich), 2 Mahnung (bestimmt), 3 letzte Mahnung (förmlich); die App entwirft nur den Text und versendet nie selbst, die Stufe gilt erst, wenn du „Als versandt markieren" bestätigst.',
    },
    verjaehrung: {
        title: 'Verjährung',
        text: 'Eine Forderung verjährt regelmäßig nach drei Jahren, gerechnet ab Ende des Jahres, in dem sie entstand (§§ 195, 199 BGB) — die App nennt daraus „Handeln bis 31.12." und sagt „vermutlich", weil sie Hemmung und Neubeginn (§§ 203 ff., 212 BGB) nicht verfolgt.',
    },
    auffangregel: {
        title: 'Auffangregel',
        text: 'Eine allgemeine Regel, die nach dem Kategorie-Wort der Bank einordnet („Reisekosten", „Verkaufserlöse") statt nach der Gegenseite. Meist richtig, aber geraten — darum stehen diese Buchungen unter „Zu prüfen".',
    },
    'sonstige-rechnung': {
        title: 'Sonstige Rechnung',
        text: 'Jede Rechnung ohne gültigen Datensatz: Papier, ein PDF ohne eingebettetes XML, ein Scan — und auch ZUGFeRD-Dateien im Profil MINIMUM oder BASIC-WL. Sie ist in der Übergangszeit noch zulässig; hier muss man die Felder selbst eintragen.',
    },
};

// English explanations for the English UI — the SAME keys as GLOSSARY (a unit test holds them in
// step). Official German tax terms keep their German name, glossed once in English, because that
// is the word the user meets in ELSTER, on a Bescheid and on the form; a translated name would be
// a word nobody at the Finanzamt recognises.
export const GLOSSARY_EN: Record<string, GlossaryEntry> = {
    euer: {
        title: 'Anlage EÜR (cash-basis profit statement)',
        text: 'Einnahmen-Überschuss-Rechnung: profit = business income − business expenses, counted when the money flows (§4(3) EStG). The simple profit calculation for small businesses.',
    },
    gewinn: {
        title: 'Profit (EÜR)',
        text: 'Business income minus business expenses (net). The basis for income tax and Gewerbesteuer (trade tax).',
    },
    'ust-zahllast': {
        title: 'USt-Zahllast (VAT payable)',
        text: 'VAT collected minus input VAT paid. Positive = you pay the Finanzamt (tax office), negative = you get money back.',
    },
    vorsteuer: {
        title: 'Vorsteuer (input VAT)',
        text: 'The VAT that others charged you on their invoices. You reclaim it from the Finanzamt — as long as you keep the invoice (receipt).',
    },
    'vereinnahmte-ust': {
        title: 'Collected USt (VAT)',
        text: 'The VAT you charged your customers and received. It belongs to the Finanzamt.',
    },
    abschlusszahlung: {
        title: 'Abschlusszahlung (final payment)',
        text: 'The year’s VAT payable minus the advance payments already made during the year — the remainder that becomes due (or is refunded) with the annual return.',
    },
    'gewst-messbetrag': {
        title: 'Steuermessbetrag (GewSt base amount)',
        text: 'Trade income (rounded down, minus the €24,500 allowance) × 3.5 %. Multiplied by the municipality’s Hebesatz (multiplier) this gives the Gewerbesteuer. Below the allowance = €0.',
    },
    gewerbesteuer: {
        title: 'Gewerbesteuer (trade tax)',
        text: 'Steuermessbetrag × the municipality’s Hebesatz. Only due when trade income exceeds the €24,500 allowance.',
    },
    feststellung: {
        title: 'Gesonderte & einheitliche Feststellung (partnership profit assessment)',
        text: 'For a GbR/partnership the profit is assessed once and then split among the partners — each pays tax on their share in their own income tax return.',
    },
    einkuenfte: {
        title: 'Einkünfte aus Gewerbebetrieb (business income)',
        text: 'The assessed profit (plus any gain on cessation, minus Sonderbetriebsausgaben) that is split among the partners.',
    },
    sonderbetriebsausgaben: {
        title: 'Sonderbetriebsausgaben (partner-specific expenses)',
        text: 'Expenses a single partner bears for the partnership (e.g. a home office). They only reduce that partner’s share.',
    },
    aufgabe: {
        title: 'Betriebsaufgabe (business cessation)',
        text: 'When a business ends, the remaining fixed assets are withdrawn at fair value → gain/loss on cessation (§16/§34 EStG, free of Gewerbesteuer, taxed at a reduced rate).',
    },
    'nachtraeglich-24': {
        title: 'Nachträgliche Einkünfte (subsequent income, §24 No. 2 EStG)',
        text: 'Payments for the old business that arrive AFTER it ceased (e.g. a late customer payment). They still count towards the business, but are free of Gewerbesteuer.',
    },
    rohertrag: {
        title: 'Rohertrag (gross profit)',
        text: 'Total output (revenue) minus cost of goods/subcontracting — what is left after the direct costs.',
    },
    gesamtleistung: {
        title: 'Gesamtleistung (total output)',
        text: 'All business income of a period (revenue + other income).',
    },
    betriebsergebnis: {
        title: 'Betriebsergebnis (operating result)',
        text: 'Total output minus all operating costs — the operating result. Over the whole year it equals the EÜR profit.',
    },
    bwa: {
        title: 'BWA (management report)',
        text: 'Betriebswirtschaftliche Auswertung: a monthly profit-and-loss overview. Shows how revenue, costs and result develop over the year.',
    },
    kleinunternehmer: {
        title: 'Kleinunternehmerregelung (small-business exemption, §19 UStG)',
        text: 'With ≤ €25,000 revenue in the previous year (and ≤ €100,000 in the current one) you may work without VAT — but then you show no VAT on invoices and reclaim no input VAT.',
    },
    doppelzahlung: {
        title: 'Duplicate payment',
        text: 'An invoice paid twice by mistake. The second payment is not revenue but an obligation to repay — it is taken out of revenue and VAT. The app flags suspicious payments itself; an entry stays open until the refund to the customer is linked.',
    },
    'vst-ohne-beleg': {
        title: 'Input VAT without a receipt',
        text: 'Expenses with input VAT that have no invoice attached (yet). To reclaim input VAT you must keep the invoice and be able to show it on request.',
    },
    afa: {
        title: 'AfA (depreciation)',
        text: 'Purchases over €800 net are not deducted at once but spread over their useful life — “Absetzung für Abnutzung”.',
    },
    abgabefrist: {
        title: 'Filing deadline',
        text: 'The regular deadline for the annual returns is 31 July of the following year (without a tax adviser). A granted extension moves it.',
    },
    steuerkonto: {
        title: 'Tax payments',
        text: 'What actually flowed from the bank account to the Finanzkasse (tax office cash desk), or was refunded — to compare with Mein ELSTER. Not an official account balance.',
    },
    mcp: {
        title: 'MCP (Model Context Protocol)',
        text: 'An open interface through which external AI assistants (ChatGPT, Claude Code …) can use your bookkeeping tools. Here you choose which of them are open to the outside.',
    },
    ustva: {
        title: 'Umsatzsteuer-Voranmeldung (advance VAT return)',
        text: 'The VAT report during the year — monthly or quarterly depending on revenue. It is an advance payment; the final settlement happens at year end with the annual VAT return.',
    },
    'ist-versteuerung': {
        title: 'Ist-Versteuerung (cash accounting for VAT)',
        text: 'VAT becomes due when the money COMES IN (§20 UStG) — not already on the invoice date. Easier on cash flow and allowed up to €800,000 revenue; the counterpart is Soll-Versteuerung (accrual accounting).',
    },
    dauerfristverlaengerung: {
        title: 'Dauerfristverlängerung (permanent filing extension)',
        text: 'Moves every advance VAT return back by one month. Monthly filers pay a special advance payment of 1/11 of the previous year’s VAT payable for it.',
    },
    transferticket: {
        title: 'Transferticket (ELSTER receipt)',
        text: 'The receipt of an ELSTER submission. It proves that and when something arrived — keep it with the year’s records.',
    },
    snapshot: {
        title: 'Snapshot',
        text: 'A frozen copy of a return: the generated XML plus the figures and the data state it came from. If the data changes afterwards, the app reports the snapshot as outdated — nothing other than the frozen copy is ever submitted.',
    },
    freigabe: {
        title: 'Approval',
        text: 'Your explicit confirmation that a snapshot may be submitted. It is tied to the data state: if the figures change, it lapses and must be given again.',
    },
    klassifizierung: {
        title: 'Classification',
        text: 'Assigning a transaction to a category (SKR03). With a receipt it comes from the receipt, without one from rules — and your own reclassification always wins.',
    },
    skr03: {
        title: 'SKR03 (standard chart of accounts)',
        text: 'A widely used German standard chart of accounts. The four-digit numbers (e.g. 4930 office supplies) are the drawers that income and expenses are sorted into.',
    },
    privatentnahme: {
        title: 'Privatentnahme (private withdrawal)',
        text: 'Money or goods you take out of the business for private use. Not a business expense — the profit does not change.',
    },
    'frei-verfuegbar': {
        title: 'Free to spend',
        text: 'Account balance minus the VAT since the last advance VAT return, minus tax payments due, minus open supplier invoices — the part that does not already belong to the Finanzamt or to suppliers. A calculation, not a recommendation; the derivation shows every item.',
    },
    steuerruecklage: {
        title: 'Tax reserve',
        text: 'The year’s estimated income tax and Gewerbesteuer minus advance payments already made, i.e. what the tax assessment will probably still demand (negative: refund). Only a calculation, not a transaction: no money is moved.',
    },
    anlagegut: {
        title: 'Fixed asset',
        text: 'Something purchased that is used for more than a year (computer, furniture). It is not deducted at once but spread over its useful life — see AfA.',
    },
    gwg: {
        title: 'GWG (low-value asset)',
        text: 'Geringwertiges Wirtschaftsgut: a fixed asset up to €800 net (without deductible input VAT) that can be used on its own — it may be deducted in full in the year of purchase (§ 6(2) EStG). Above that it is depreciated; up to €1,000 a pooled item over five years is optional (§ 6(2a) EStG).',
    },
    'anlagegut-kandidat': {
        title: 'Fixed-asset candidate',
        text: 'An expense above the GWG limit that is not in the asset register — probably a fixed asset that is depreciated instead of deducted at once. Instalments to the same vendor count as one asset. A suggestion, not a transaction: add it or mark it as fine.',
    },
    'reverse-charge': {
        title: 'Reverse charge (§ 13b UStG)',
        text: 'For services from foreign businesses the recipient owes the German VAT, not the supplier — the invoice comes without VAT. With input VAT deduction it cancels out, but it must still be declared; a Kleinunternehmer (small business) pays it without deduction.',
    },
    'e-rechnung': {
        title: 'E-Rechnung (e-invoice)',
        text: 'An invoice as a structured data set according to EN 16931 — XRechnung (a plain XML file) or ZUGFeRD/Factur-X (a PDF with embedded XML, not the MINIMUM and BASIC-WL profiles). The app reads it without AI and without retyping (§14 UStG).',
    },
    'ohne-befund': {
        title: 'Checked, nothing found',
        text: 'A check that looked and found nothing — stating what was checked. Its counterpart is “not checkable, because …”: then the data for the check is missing. Both beat silence, which looks like “all good”.',
    },
    'iban-wechsel': {
        title: 'IBAN change',
        text: 'A known supplier is suddenly paid to an IBAN that never received money before. Usually it is a new account, sometimes a forged invoice — and money transferred is then hard to get back. So always ask via the phone number or address you already know, never the one on the new invoice.',
    },
    'zu-pruefen': {
        title: 'To review',
        text: 'Transactions that no rule and no receipt classifies, and those caught only by a catch-all rule. Confirming records the category as reviewed without changing anything in the EÜR; Mark as transfer changes it.',
    },
    'laufende-kosten': {
        title: 'Recurring costs',
        text: 'Debits at a fixed interval to the same payee — rent, software, insurance — that the app detects and you confirm; confirmed ones are deducted from Free to spend. Not to be confused with recurring invoices: those are your own outgoing invoices to customers.',
    },
    erstattung: {
        title: 'Refund',
        text: 'Money a supplier returns for an earlier payment (return, partial refund, chargeback); linked to that payment with “Yes”, it reduces its expense including input VAT in the year and VAT period in which it arrives.',
    },
    splitbuchung: {
        title: 'Split transaction',
        text: 'A transaction you divide into parts with their own amount, category and tax rate — say an order with business and private items; one part always takes the remainder, and the private part counts neither as an expense nor for input VAT.',
    },
    projektergebnis: {
        title: 'Project result',
        text: 'What a project earned net in the period: revenue of the project invoices minus the cost of the assigned expenses (private and neutral parts do not count), per hour when time is tracked. An internal report, not a tax figure.',
    },
    dokumentregel: {
        title: 'Document rule',
        text: 'You define once what a receipt from a given sender is — document type, category, incoming or outgoing. Every later receipt from that sender gets these values automatically when added, without AI; AI only fills what the rule leaves open. With Paperless, Paperless does this assignment itself and the app only shows which rule applied there.',
    },
    'belege-aus-mail': {
        title: 'Receipts from mail',
        text: 'The app reads a mail folder and puts PDF and e-invoice attachments of new messages into the receipt inbox — rules apply as for any added receipt. It only reads: nothing is flagged, moved or deleted, and of the mail text only sender and date are kept. With Paperless, Paperless fetches the receipts itself (set up “Mail” there).',
    },
    mahnstufe: {
        title: 'Reminder level',
        text: 'How far an overdue invoice has been chased — 1 payment reminder (friendly), 2 Mahnung (firm), 3 final Mahnung (formal); the app only drafts the text and never sends it itself, the level only applies once you confirm “Mark as sent”.',
    },
    verjaehrung: {
        title: 'Verjährung (limitation period)',
        text: 'A claim normally becomes time-barred after three years, counted from the end of the year in which it arose (§§ 195, 199 BGB) — the app derives “act by 31 Dec” from that and says “probably”, because it does not track suspension and restart (§§ 203 ff., 212 BGB).',
    },
    auffangregel: {
        title: 'Catch-all rule',
        text: 'A general rule that classifies by the bank’s category word (“travel costs”, “sales revenue”) instead of the counterparty. Usually right, but a guess — which is why these transactions are listed under “To review”.',
    },
    'sonstige-rechnung': {
        title: 'Other invoice',
        text: 'Any invoice without a valid data set: paper, a PDF without embedded XML, a scan — and also ZUGFeRD files in the MINIMUM or BASIC-WL profile. Still allowed during the transition period; here you enter the fields yourself.',
    },
};

/** The glossary for a UI language: German for `de`, English for everything else. */
export function glossaryFor(language: string): Record<string, GlossaryEntry> {
    return language === 'de' ? GLOSSARY : GLOSSARY_EN;
}
