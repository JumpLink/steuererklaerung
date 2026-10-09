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
