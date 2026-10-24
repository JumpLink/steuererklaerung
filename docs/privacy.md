# Privacy

This page describes what the Steuererklärung app does with your data. It is a desktop app with a command line and an MCP server, not an online service. The app is open source, so key statements link to the source file they are based on and can be checked rather than taken on trust. What cannot be checked in the code is marked as such.

The provider's details are in the [legal notice](../legal-notice/). Contact for privacy questions: Pascal Garber, JumpLink, pascal@jumplink.eu.

## 1. The developer receives no data

The developer runs no server for this app. The source contains no analytics, crash reporting, telemetry or update check; a search for such code finds nothing ([SECURITY.md](https://github.com/JumpLink/steuererklaerung/blob/main/SECURITY.md), section "Keine Telemetrie"). The only counter, [`LLMTelemetry`](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/llm/types.ts), tallies tokens and cost of your own AI calls on your computer.

Wherever the app talks to a third party, you set that connection up yourself, with your own account. What that third party does with the data is governed by its own terms and privacy policy, not by this page.

## 2. Your data stays on your computer

Your master data, bookings, receipts and generated tax files are stored as files on your machine; nothing is copied elsewhere.

- Configuration (`steuererklaerung.json`, with tax numbers and accounts): a fresh install uses `~/.config/steuererklaerung` ([paths.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/paths.ts)).
- Bookings, the SQLite ledger (`ledger.db`) and receipts of the built-in document store: `~/.local/share/steuererklaerung/transactions-data` ([paths.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/paths.ts), [transactions store](https://github.com/JumpLink/steuererklaerung/blob/main/packages/store/src/transactions/store.ts), [ledger path](https://github.com/JumpLink/steuererklaerung/blob/main/packages/store/src/ledger/path.ts)). Both locations can be changed with environment variables.
- Credentials for services are read from environment variables or a `.env` file ([main.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/frontends/desktop/main.ts)).

In the Flatpak, these paths are inside the app's sandbox. The Flatpak asks for no access to your home directory or other folders ([Flatpak manifest](https://github.com/JumpLink/steuererklaerung/blob/main/eu.jumplink.Steuererklaerung.json)).

## 3. Passwords and PINs are kept in the keyring

The ELSTER certificate PIN and mail passwords (invoice mailing, receipt mailbox) are stored in the operating system's secret store, not in a file: the Secret Service (GNOME Keyring) on Linux, the Keychain on macOS, a DPAPI-encrypted file on Windows ([store.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/secrets/store.ts)). If no secret store works, the app asks every time instead of falling back to plain text. The Flatpak is allowed to talk to the Secret Service for this. Storing the ELSTER PIN is optional ([submission.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/frontends/desktop/data/submission.ts)).

## 4. Connections the app makes

The app opens network connections only to services you configure or use. The Flatpak has network access (`--share=network`, see the [Flatpak manifest](https://github.com/JumpLink/steuererklaerung/blob/main/eu.jumplink.Steuererklaerung.json)).

- **Qonto** (bank, API): `thirdparty.qonto.com`, or the test host when staging is selected ([request.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/qonto/request.ts)). Your login and secret key are sent as request headers, and bookings and account data are retrieved. Only used if you enter Qonto credentials.
- **Paperless-ngx**: the server at your own `PAPERLESS_BASE_URL`, with your API token ([request.ts](https://github.com/JumpLink/steuererklaerung/blob/main/packages/paperless/src/request.ts)). Documents and metadata are exchanged with your server. No Paperless address is built into the app.
- **ELSTER (tax authority)**: when you validate or submit a return, the ERiC library sends it to the tax administration. According to the ERiC licence, it also transmits information about the type of operating system, and it writes log files that stay on your computer ([privacy-ack.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/actions/elster/privacy-ack.ts)). The app shows this notice before the first transmission ([dialog](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/frontends/desktop/views/datenschutz-dialog.ts)). A test send, a release step and a snapshot come before a real submission ([SECURITY.md](https://github.com/JumpLink/steuererklaerung/blob/main/SECURITY.md)).
- **Your bank via FinTS/HBCI**: the bank address you enter ([client.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/fints/client.ts)).
- **INWX** (domain invoices): the INWX API, only with INWX credentials ([request.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/inwx/request.ts)).
- **Mail servers**: an IMAP server for the receipt mailbox, using TLS by default. The app only reads and never deletes, moves or marks messages ([mail-eingang.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/config/schema/mail-eingang.ts)). An SMTP server is used for sending invoices ([mail-sender.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/mail/mail-sender.ts)). Both servers are yours.
- **Federal Ministry of Finance**: `www.bundesfinanzministerium.de`, to fetch official exchange rates, only when you run the import yourself ([bmf-import.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/config/bmf-import.ts)).
- **AI providers**: see section 5.

PayPal and Amazon files are only read on your computer; the code makes no connection to either ([PayPal parser](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/paypal/parser.ts), [Amazon parser](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/amazon/parser.ts)).

Links such as the support page open in your browser only when you click them ([support-dialog.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/frontends/desktop/views/support-dialog.ts)).

## 5. AI features are optional

An AI model is called only when you use an AI function: reading invoice fields, classifying documents, reviewing metadata, or asking the assistant. You choose the provider with the setting `LLM_PROVIDER` ([index.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/llm/index.ts)):

- `claude`: the Claude Agent SDK, with no tools allowed ([claude-agent-provider.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/llm/claude-agent-provider.ts)). The prompt goes to Anthropic under your own account.
- `scaleway`: `api.scaleway.ai`, with your API key ([chat.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/clients/scaleway/chat.ts)).
- `opencode`: a coding agent started as a local process by lotse. Free hosted models are refused for background jobs ([lotse-embed.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/actions/assistant/lotse-embed.ts)).

What is sent is the text of the document or your question. The assistant receives only summed-up figures, no IBANs or tax numbers ([chat.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/actions/assistant/chat.ts)). These providers process the data under their own terms; the developer sees none of it. Without AI, you can enter everything by hand.

## 6. The MCP server: an AI client you connect yourself

The app includes an MCP server through which an external AI assistant of your choice (for example Claude Code) can read your data. The app does not set up this connection on its own. You register the server in your AI client ([MCP command](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/frontends/cli/mcp.ts)).

Once connected, tool results (bookings, documents, figures from the groups you enabled) go to that AI client and from there to its provider. Which provider that is, and how it handles the data, depends on the client you chose. The server can be switched off and limited per tool group. Tools that change data are blocked unless the setting `mcp.allowWrite` is on, which is off by default ([app-settings.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/core/config/schema/app-settings.ts)).

By default the server talks to the AI client directly on your computer (stdio). The optional HTTP mode ([server.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/frontends/mcp/server.ts)) is bound to a local address and has no login, so use it only on a computer and network you trust. The web review interface is also bound to the local address `127.0.0.1` by default and has no login ([server.ts](https://github.com/JumpLink/steuererklaerung/blob/main/app/src/frontends/web/server.ts)).

## 7. Installation

The Flatpak build downloads the opencode agent from `registry.npmjs.org` when it is installed, as extra data with a fixed checksum ([Flatpak manifest](https://github.com/JumpLink/steuererklaerung/blob/main/eu.jumplink.Steuererklaerung.json)). No data about you is sent in this step beyond what any download involves. The app does not update itself.

## 8. Your rights

The developer holds no personal data about you, so there is nothing to look up or delete on that side. Your data lives on your device and, where you set it up, at the services above; use their own channels for requests. Questions about this page: pascal@jumplink.eu.

## 9. Changes

This page changes in the same commit as the behaviour it describes.
