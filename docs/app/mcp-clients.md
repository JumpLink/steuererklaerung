# Externe Agenten verbinden (MCP)

Ein externer Agent (Claude Desktop, Claude Code, opencode, Cursor, VS Code) startet den MCP-Server
der App selbst, als Kindprozess über stdio. Die App zeigt unter **Einstellungen → MCP → Externen
Agenten verbinden …** für jeden dieser Clients den fertigen Konfigurationsausschnitt — mit dem
Startbefehl **dieser** Installation — zum Kopieren an.

Vorher: **MCP-Server für externe Agenten** einschalten. Schreibende Werkzeuge bleiben aus, solange
**Schreibende Werkzeuge erlauben** nicht an ist. Siehe [ki-und-mcp.md](ki-und-mcp.md).

## Der Startbefehl je Installation

Der Dialog fragt die laufende Installation und die Plattform ab (`currentMcpInstallation()`,
`currentMcpPlatform()`); `resolveMcpLaunch` und `mcpClientSnippets` sind rein und nehmen die
Plattform als Eingabe.

| Installation | Befehl |
|---|---|
| Flatpak | `flatpak run --env=STEUER_WORKSPACE=<manifest> eu.jumplink.Steuererklaerung mcp` |
| AppImage | `$APPIMAGE mcp` (die Datei selbst, nicht der temporäre Mount-Pfad) |
| deb / rpm (Starter im `PATH`) | `/usr/bin/steuererklaerung mcp` (absolut aufgelöst) |
| Windows (zip/MSI) | `<Programmverzeichnis>\steuererklaerung.exe mcp` neben der `node.exe` |
| macOS (`.app`) | `<App>.app/Contents/MacOS/steuererklaerung mcp` |
| Windows/macOS ohne Starter | `<node> <bundle> mcp` wie `selfCommand()` |
| Entwicklungs-Checkout | `<checkout>/node_modules/.bin/gjsify run <checkout>/app/dist/app/steuer-app.gjs.mjs mcp` |

- `STEUER_WORKSPACE` zeigt auf das Manifest, das die App gerade benutzt. Der Client startet den
  Server aus seinem eigenen Arbeitsverzeichnis, in dem kein Manifest liegt.
- Im Demo-Modus kommt `STEUER_DEMO=1` dazu.
- Flatpak filtert die Umgebung des Aufrufers; deshalb gehen die Variablen als `--env=`-Flags mit,
  nicht über den `env`-Block des Clients.
- Im Checkout reicht `gjs -m <bundle>` nicht: Die Typelibs der nativen Brücken liegen unter
  `node_modules`, und erst `gjsify run` setzt `GI_TYPELIB_PATH`.
- Windows und macOS stehen nicht im `PATH`; der Starter liegt im gjsify-Ship-Layout neben dem
  Interpreter (`packageLauncher()`).
- Das Quoting des Claude-Code-Befehls folgt der Plattform: POSIX-Shell bzw. PowerShell
  (Einzelanführungszeichen, Umlaute und Leerzeichen im Pfad unproblematisch).

Die Desktop-App versteht dafür selbst das Unterkommando `mcp` (ohne Fenster; stdout ist das
Protokoll). Die CLI `steuer mcp` bleibt daneben unverändert. Schreibende Werkzeuge erscheinen nur,
wenn **Schreibende Werkzeuge erlauben** an ist (Smoke-Test mit Demo-Daten: 66 Werkzeuge ohne, 112 mit).

## Formate der Clients

Geprüft am 2026-10-10 (Pfade je OS am 2026-10-16) gegen die offizielle Dokumentation; Code:
`app/src/core/actions/mcp-clients.ts`.

| Client | Wohin | Schlüssel | Quelle |
|---|---|---|---|
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\\Claude\\claude_desktop_config.json` | `mcpServers` → `command`/`args`/`env` | <https://modelcontextprotocol.io/docs/develop/connect-local-servers> |
| Claude Code | Terminal: `claude mcp add --transport stdio --env … --scope user <name> -- <befehl>` | — | <https://code.claude.com/docs/en/mcp> |
| opencode | `~/.config/opencode/opencode.json` (Windows: `%USERPROFILE%\\.config\\opencode\\…`) | `mcp` → `type: "local"`, `command` als Array, `environment` | <https://opencode.ai/docs/mcp-servers/> |
| Cursor | `~/.cursor/mcp.json` (Windows: `%USERPROFILE%\\.cursor\\mcp.json`) | `mcpServers` → `type: "stdio"` | <https://cursor.com/docs/context/mcp> |
| VS Code | `.vscode/mcp.json` | `servers` (nicht `mcpServers`) → `type: "stdio"` | <https://code.visualstudio.com/docs/agent-customization/mcp-servers> |

Claude Desktop dokumentiert nur macOS und Windows; unter Linux erscheint dafür kein Eintrag. Nach einer Änderung an der Konfiguration den
Agenten neu starten.
