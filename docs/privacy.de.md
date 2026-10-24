# Datenschutz

Diese Seite beschreibt, was die App Steuererklärung mit deinen Daten macht. Sie ist eine Desktop-App mit Kommandozeile und MCP-Server, kein Online-Dienst. Die App ist Open Source, deshalb verlinken wichtige Aussagen auf die Quelldatei, auf der sie beruhen, und lassen sich nachprüfen, statt geglaubt werden zu müssen. Was sich im Code nicht prüfen lässt, ist als solches gekennzeichnet.

Die Angaben zum Anbieter stehen im [Impressum](../legal-notice/). Kontakt bei Datenschutzfragen: Pascal Garber, JumpLink, pascal@jumplink.eu.

## 1. Der Entwickler erhält keine Daten

Der Entwickler betreibt keinen Server für diese App. Im Quelltext gibt es keine Analyse, keine Absturzberichte, keine Telemetrie und keinen Update-Check; eine Suche nach solchem Code findet nichts ([SECURITY.md](https://github.com/JumpLink/steuererklaerung/blob/main/SECURITY.md), Abschnitt „Keine Telemetrie“). Der einzige Zähler, [`LLMTelemetry`](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/llm/types.ts), zählt Tokens und Kosten deiner eigenen KI-Aufrufe auf deinem Rechner.

Wo die App mit Dritten spricht, richtest du diese Verbindung selbst ein, mit deinem eigenen Konto. Was der Dritte mit den Daten tut, richtet sich nach seinen eigenen Bedingungen und seiner Datenschutzerklärung, nicht nach dieser Seite.

## 2. Deine Daten bleiben auf deinem Rechner

Stammdaten, Buchungen, Belege und erzeugte Steuerdateien liegen als Dateien auf deinem Rechner; nichts wird anderswohin kopiert.

- Konfiguration (`steuererklaerung.json`, mit Steuernummern und Konten): eine Neuinstallation nutzt `~/.config/steuererklaerung` ([paths.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/paths.ts)).
- Buchungen, die SQLite-Datenbank (`ledger.db`) und Belege des eingebauten Dokumentenspeichers: `~/.local/share/steuererklaerung/transactions-data` ([paths.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/paths.ts), [Buchungsspeicher](https://github.com/JumpLink/steuererklaerung/blob/main/packages/store/src/transactions/store.ts), [Datenbankpfad](https://github.com/JumpLink/steuererklaerung/blob/main/packages/store/src/ledger/path.ts)). Beide Orte lassen sich über Umgebungsvariablen ändern.
- Zugangsdaten für Dienste werden aus Umgebungsvariablen oder einer `.env`-Datei gelesen ([main.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/frontends/desktop/main.ts)).

Im Flatpak liegen diese Pfade innerhalb der Sandbox der App. Das Flatpak fordert keinen Zugriff auf dein Home-Verzeichnis oder andere Ordner an ([Flatpak-Manifest](https://github.com/JumpLink/steuererklaerung/blob/main/eu.jumplink.Steuererklaerung.json)).

## 3. Passwörter und PINs liegen im Schlüsselbund

Die ELSTER-Zertifikats-PIN und Mail-Passwörter (Rechnungsversand, Belege-Postfach) liegen im geheimen Speicher des Betriebssystems, nicht in einer Datei: Secret Service (GNOME-Schlüsselbund) unter Linux, Schlüsselbund unter macOS, eine DPAPI-verschlüsselte Datei unter Windows ([store.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/secrets/store.ts)). Funktioniert kein Speicher, fragt die App jedes Mal, statt auf Klartext auszuweichen. Das Flatpak darf dafür mit dem Secret Service sprechen. Das Speichern der ELSTER-PIN ist freiwillig ([submission.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/frontends/desktop/data/submission.ts)).

## 4. Verbindungen der App

Die App baut Netzwerkverbindungen nur zu Diensten auf, die du einrichtest oder nutzt. Das Flatpak hat Netzwerkzugriff (`--share=network`, siehe [Flatpak-Manifest](https://github.com/JumpLink/steuererklaerung/blob/main/eu.jumplink.Steuererklaerung.json)).

- **Qonto** (Bank, API): `thirdparty.qonto.com`, bei Staging der Testserver ([request.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/qonto/request.ts)). Login und Secret Key gehen als Request-Header mit, Buchungen und Kontodaten werden abgerufen. Nur bei hinterlegten Qonto-Zugangsdaten.
- **Paperless-ngx**: der Server unter deiner eigenen `PAPERLESS_BASE_URL`, mit deinem API-Token ([request.ts](https://github.com/JumpLink/steuererklaerung/blob/main/packages/paperless/src/request.ts)). Dokumente und Metadaten gehen mit deinem Server hin und her. Eine Paperless-Adresse ist nicht in die App eingebaut.
- **ELSTER (Finanzverwaltung)**: Beim Prüfen oder Übermitteln einer Erklärung sendet die ERiC-Bibliothek sie an die Finanzverwaltung. Laut ERiC-Lizenz übermittelt sie zusätzlich Angaben zur Art des Betriebssystems und legt Protokolldateien an, die auf deinem Rechner bleiben ([privacy-ack.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/actions/elster/privacy-ack.ts)). Die App zeigt diesen Hinweis vor der ersten Übermittlung ([Dialog](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/frontends/desktop/views/datenschutz-dialog.ts)). Vor einem Echtversand stehen ein Testversand, eine Freigabe und ein Snapshot ([SECURITY.md](https://github.com/JumpLink/steuererklaerung/blob/main/SECURITY.md)).
- **Deine Bank über FinTS/HBCI**: die Bankadresse, die du einträgst ([client.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/fints/client.ts)).
- **INWX** (Domain-Rechnungen): die INWX-API, nur mit INWX-Zugangsdaten ([request.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/inwx/request.ts)).
- **Mailserver**: ein IMAP-Server für das Belege-Postfach, standardmäßig mit TLS. Die App liest nur und löscht, verschiebt oder markiert nie Nachrichten ([mail-eingang.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/config/schema/mail-eingang.ts)). Für den Rechnungsversand dient ein SMTP-Server ([mail-sender.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/mail/mail-sender.ts)). Beide Server sind deine eigenen.
- **Bundesfinanzministerium**: `www.bundesfinanzministerium.de`, um amtliche Umrechnungskurse zu laden, nur wenn du den Import selbst startest ([bmf-import.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/config/bmf-import.ts)).
- **KI-Anbieter**: siehe Abschnitt 5.

PayPal- und Amazon-Dateien werden nur auf deinem Rechner ausgelesen; der Code baut zu keinem von beiden eine Verbindung auf ([PayPal-Parser](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/paypal/parser.ts), [Amazon-Parser](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/amazon/parser.ts)).

Links wie die Unterstützungsseite öffnen sich nur im Browser, wenn du sie anklickst ([support-dialog.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/frontends/desktop/views/support-dialog.ts)).

## 5. KI-Funktionen sind optional

Ein KI-Modell wird nur aufgerufen, wenn du eine KI-Funktion nutzt: Rechnungsfelder auslesen, Dokumente klassifizieren, Metadaten prüfen oder den Assistenten fragen. Den Anbieter wählst du mit der Einstellung `LLM_PROVIDER` ([index.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/llm/index.ts)):

- `claude`: das Claude Agent SDK, ohne erlaubte Werkzeuge ([claude-agent-provider.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/llm/claude-agent-provider.ts)). Der Prompt geht mit deinem eigenen Konto an Anthropic.
- `scaleway`: `api.scaleway.ai`, mit deinem API-Schlüssel ([chat.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/scaleway/chat.ts)).
- `opencode`: ein Coding-Agent, den lotse als lokalen Prozess startet. Kostenlose gehostete Modelle werden für Hintergrundaufgaben abgelehnt ([lotse-embed.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/actions/assistant/lotse-embed.ts)).

Gesendet wird der Text des Dokuments oder deine Frage. Der Assistent erhält nur zusammengefasste Kennzahlen, keine IBANs oder Steuernummern ([chat.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/actions/assistant/chat.ts)). Diese Anbieter verarbeiten die Daten nach ihren eigenen Bedingungen; der Entwickler sieht nichts davon. Ohne KI kannst du alles von Hand eintragen.

## 6. Der MCP-Server: ein KI-Client, den du selbst verbindest

Die App enthält einen MCP-Server, über den ein externer KI-Assistent deiner Wahl (etwa Claude Code) deine Daten lesen kann. Die App richtet diese Verbindung nicht von sich aus ein. Du trägst den Server in deinem KI-Client ein ([MCP-Befehl](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/frontends/cli/mcp.ts)).

Sobald verbunden, gehen Werkzeugergebnisse (Buchungen, Dokumente, Kennzahlen aus den freigegebenen Gruppen) an diesen KI-Client und von dort an dessen Anbieter. Wer das ist und wie er die Daten behandelt, hängt vom gewählten Client ab. Der Server lässt sich abschalten und pro Werkzeuggruppe begrenzen. Werkzeuge, die Daten ändern, sind gesperrt, solange die Einstellung `mcp.allowWrite` aus ist, was standardmäßig der Fall ist ([app-settings.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/config/schema/app-settings.ts)).

Standardmäßig spricht der Server direkt auf deinem Rechner mit dem KI-Client (stdio). Der optionale HTTP-Modus ([server.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/frontends/mcp/server.ts)) ist an eine lokale Adresse gebunden und hat keine Anmeldung; nutze ihn nur auf einem Rechner und in einem Netz, denen du vertraust. Auch die Web-Oberfläche zur Durchsicht ist standardmäßig an die lokale Adresse `127.0.0.1` gebunden und hat keine Anmeldung ([server.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/frontends/web/server.ts)).

## 7. Installation

Der Flatpak-Build lädt bei der Installation den Agenten opencode von `registry.npmjs.org`, als Extra-Daten mit fester Prüfsumme ([Flatpak-Manifest](https://github.com/JumpLink/steuererklaerung/blob/main/eu.jumplink.Steuererklaerung.json)). Dabei werden keine Angaben über dich gesendet, die über jeden Download hinausgehen. Die App aktualisiert sich nicht selbst.

## 8. Deine Rechte

Der Entwickler hält keine personenbezogenen Daten von dir, es gibt dort also nichts auszukunften oder zu löschen. Deine Daten liegen auf deinem Gerät und, soweit du es eingerichtet hast, bei den genannten Diensten; wende dich dafür an deren eigene Kanäle. Fragen zu dieser Seite: pascal@jumplink.eu.

## 9. Änderungen

Diese Seite ändert sich im selben Commit wie das Verhalten, das sie beschreibt.
