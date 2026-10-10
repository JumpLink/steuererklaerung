# Externe Agenten verbinden (MCP)

Ein externer Agent (Claude Desktop, Claude Code, opencode, Cursor, VS Code) startet den MCP-Server
der App selbst, als Kindprozess über stdio. Die App zeigt unter **Einstellungen → MCP → Externen
Agenten verbinden …** für jeden dieser Clients den fertigen Konfigurationsausschnitt — mit dem
Startbefehl **dieser** Installation — zum Kopieren an.

Vorher: **MCP-Server für externe Agenten** einschalten. Schreibende Werkzeuge bleiben aus, solange
**Schreibende Werkzeuge erlauben** nicht an ist. Siehe [ki-und-mcp.md](ki-und-mcp.md).

## Der Startbefehl je Installation

| Installation | Befehl |
|---|---|
| Flatpak | `flatpak run --env=STEUER_WORKSPACE=<manifest> eu.jumplink.Steuererklaerung mcp` |
| Paket (Starter im `PATH`) | `steuererklaerung mcp` |
| Entwicklungs-Checkout | `<checkout>/node_modules/.bin/gjsify run <checkout>/app/dist/app/steuer-app.gjs.mjs mcp` |

- `STEUER_WORKSPACE` zeigt auf das Manifest, das die App gerade benutzt. Der Client startet den
  Server aus seinem eigenen Arbeitsverzeichnis, in dem kein Manifest liegt.
- Im Demo-Modus kommt `STEUER_DEMO=1` dazu.
- Flatpak filtert die Umgebung des Aufrufers; deshalb gehen die Variablen als `--env=`-Flags mit,
  nicht über den `env`-Block des Clients.
- Im Checkout reicht `gjs -m <bundle>` nicht: Die Typelibs der nativen Brücken liegen unter
  `node_modules`, und erst `gjsify run` setzt `GI_TYPELIB_PATH`.

Die Desktop-App versteht dafür selbst das Unterkommando `mcp` (ohne Fenster; stdout ist das
Protokoll). Die CLI `steuer mcp` bleibt daneben unverändert.

## Formate der Clients

Geprüft am 2026-10-10 gegen die offizielle Dokumentation; Code:
`app/src/core/actions/mcp-clients.ts`.

| Client | Wohin | Schlüssel | Quelle |
|---|---|---|---|
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` → `command`/`args`/`env` | <https://modelcontextprotocol.io/docs/develop/connect-local-servers> |
| Claude Code | Terminal: `claude mcp add --transport stdio --env … --scope user <name> -- <befehl>` | — | <https://code.claude.com/docs/en/mcp> |
| opencode | `~/.config/opencode/opencode.json` | `mcp` → `type: "local"`, `command` als Array, `environment` | <https://opencode.ai/docs/mcp-servers/> |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` → `type: "stdio"` | <https://cursor.com/docs/context/mcp> |
| VS Code | `.vscode/mcp.json` | `servers` (nicht `mcpServers`) → `type: "stdio"` | <https://code.visualstudio.com/docs/agent-customization/mcp-servers> |

Claude Desktop dokumentiert nur macOS und Windows. Nach einer Änderung an der Konfiguration den
Agenten neu starten.
