# Running steuererklaerung-cli on GJS

The CLI is **dual-target**: the same `src/` runs on Node.js (the default, via
`--experimental-strip-types`) and natively on **GJS** (GNOME JavaScript) through
the [gjsify](https://github.com/gjsify/gjsify) toolchain — so the accounting tool
and its MCP server can run without a Node.js runtime (e.g. as a Flatpak).

The Node path is unchanged; everything below is additive.

## Prerequisites

- `gjs` ≥ 1.86 (SpiderMonkey 140 / ES2024 — Fedora 43+/Ubuntu 25.10+)
- the GNOME runtime libs gjsify uses (glib2, gobject-introspection, libsoup3, …)
- `gjsify install` at the workspace root (pulls `@gjsify/cli`, `@gjsify/runtime`,
  `@gjsify/node-globals`) — never `npm install`, which prunes the gjsify-managed deps

## Build & run

```bash
gjsify run build:gjs      # → app/dist/steuer.gjs.mjs   (gjsify build --app gjs)
gjsify run build:test:node     # → app/dist/steuer.node.mjs  (parity/CI bundle)

# Run a command — `gjsify run` resolves the native lib paths and execs `gjs -m`:
gjsify run start check-apis
gjsify run start transactions summary
# (equivalently: node_modules/.bin/gjsify run dist/steuer.gjs.mjs <command>)
```

`gjsify run` (from `@gjsify/cli` ≥ 0.5.0) is the entry point — no wrapper script
needed. It sends its command banner to **stderr** (so an MCP stdio server's
stdout stays clean) and auto-resolves the native prebuild paths of **all**
dependencies that declare `gjsify.prebuilds` in their package.json — the
`@gjsify/*` libsoup/tls/http2 bridges *and* `@steuererklaerung/eric`. (`gjsify info`
prints exactly what it would set.)

### MCP server on GJS

```bash
gjsify run start mcp        # stdio transport (29 tools)
```

Register it with an MCP client by pointing the command at `gjsify run` with a
**clean env** — it sets the native paths itself, so no `LD_LIBRARY_PATH` /
`GI_TYPELIB_PATH` are needed:

```json
{
  "command": "/abs/path/node_modules/.bin/gjsify",
  "args": ["run", "/abs/path/app/dist/steuer.gjs.mjs", "mcp"],
  "cwd": "/abs/path/app"
}
```

Verified end-to-end with the SDK client in
[`tests/integration/mcp-gjs-smoke.mjs`](../tests/integration/mcp-gjs-smoke.mjs).

### ELSTER (ERiC) on GJS

ELSTER validation runs natively via [`@steuererklaerung/eric`](../../packages/eric)
(`gi://SteuerEric`). Build its native binding once and provide ERiC:

```bash
export ERIC_HOME=/path/to/eric/runtime          # your ERiC install (never bundled)
gjsify run -w @steuererklaerung/eric build:meson         # build the typelib (needs meson+valac)
# gjsify run auto-detects the @steuererklaerung/eric typelib; the external ERiC .so
# libs come from ERIC_HOME (gjsify run appends its paths to an inherited one):
LD_LIBRARY_PATH="$ERIC_HOME/lib:$ERIC_HOME/lib/plugins" gjsify run start elster ustva validate-eric --xml out.xml
```

### Mail, contacts and calendar → postbote

The GOA/EDS binding and the IMAP client are no longer here. They moved to
[postbote](https://github.com/JumpLink/postbote) (`projects/mail` in werkstatt), which runs on
the same gjsify/GJS stack and registers as its own MCP server. Nothing in this project imports
`gi://Goa` any more, so the GOA and EDS system typelibs are no longer needed to run it.

## How it works (notes for maintainers)

- `node:*` imports resolve to `@gjsify/*` at bundle time; all outbound HTTP uses
  the Web `fetch` API, which gjsify backs with libsoup.
- `src/index.ts` runs an explicit GLib main loop on GJS (GJS has no always-on
  event loop) and drives parse fire-and-forget rather than with a top-level
  `await`, so the loop pumps I/O immediately and owns teardown. It runs until a
  command calls `process.exit()` (most do, via `runAndExit`); it only quits
  itself on parse/validation errors and `--help`/`--version`. Always exit via
  `process.exit()`, never a bare `imports.system.exit()` from async code — the
  latter sets GJS's exit flag without quitting the loop and hangs (gjsify#513).
  (An earlier note here claimed a top-level await suppresses microtask draining;
  that was pre-1.72 GJS behaviour — modern GJS 1.86+ drains correctly. The real
  MCP "no output" hang was the stdin auto-resume gap, below.)
- The MCP stdio handler calls `process.stdin.resume()` (gjsify's
  `ProcessReadStream` is a plain EventEmitter, so `.on('data')` does not
  auto-start reading like Node's Readable) and stays pending for the process
  lifetime. This was the actual cause of the original MCP "no output" hang;
  gjsify#509 makes `.on('data')` auto-resume upstream, after which the explicit
  `resume()` is just belt-and-suspenders.
- `koffi`, `@anthropic-ai/claude-agent-sdk` are externalized; DOM-only globals are
  excluded (`--exclude-globals` — auto-skipped upstream by gjsify#514); `qrcode`
  is lazy-loaded (its PNG renderer's `pngjs`/`sync-inflate` module init throws
  under gjs — addressed upstream by gjsify#508, which adds the missing `node:zlib`
  streaming classes).

## Support matrix

| Area | GJS status |
|------|-----------|
| `build:gjs` / `build:test:node` | ✅ |
| **MCP stdio server** (all 29 tools, incl. a real `tools/call`) | ✅ |
| GNOME mail / contacts / calendar | ➡️ moved to [postbote](https://github.com/JumpLink/postbote) |
| Read commands — Qonto, Paperless (fetch via libsoup) | ✅ |
| INWX invoices (`domrobot-client`) | ✅ |
| FinTS (`lib-fints`) | ✅ |
| **ELSTER validation** (`validateXml`/`checkXml`/`checkIBAN`/`checkSteuernummer`) | ✅ via `@steuererklaerung/eric` (needs `ERIC_HOME`) |
| `transactions` store (NDJSON) | ✅ |
| Multi-chunk gzip `fetch` body-read | ✅ via gjsify#515 (`Gio.IOErrorEnum`); shipped in `@gjsify/*` 0.5.0, verified end-to-end on gjs |
| `generate_sepa_qr` PNG data-URL | ✅ via gjsify#508 — `node:zlib` streaming classes; shipped in 0.5.0, renders a real PNG data-URL on gjs (re-verified overlay-free) |
| `qonto-export` (`xlsx`) | ✅ SheetJS `XLSX.read`/`write` round-trips on gjs (verified) |
| Interactive prompts (`@inquirer`) | ✅ works; best with `@gjsify/terminal-native` for full TTY |
| Exit codes for *error* cases | ✅ unknown commands + nested parse errors reject cleanly (rc=1, no hang/crash) via `.strictCommands()` + sync-throw normalization |

The gaps that made a GJS build need a source overlay were closed by the upstream
gjsify fixes #508 (zlib), #509 (process/stdin), #514 (auto-globals) and #515
(fetch), all of which shipped in `@gjsify/*` 0.5.0. The overlay is long gone and
a plain `gjsify install` produces a working GJS build; the Node build remains
available regardless.

**The deps are pinned EXACTLY, not by caret, and they are on 0.30.0** — every
`@gjsify/*` package publishes at one version per release train (gjsify ADR 0008),
so a mixed set is not a supported pairing. Read the current numbers off
`app/package.json` rather than from this paragraph; it named `^0.5.0` for seven
release trains after that stopped being true.

## Launch: `gjsify run` (no wrapper script)

Since `@gjsify/cli` 0.5.0, `gjsify run <bundle> [args]` is the entry point — used
by the `start` script. It:

- resolves the native prebuild paths (`LD_LIBRARY_PATH` / `GI_TYPELIB_PATH`) of
  **every** dependency that declares `gjsify.prebuilds` in its package.json — the
  `@gjsify/*` libsoup/tls/http2 bridges and `@steuererklaerung/eric` — by walking
  `node_modules` (run `gjsify info` to see what it detects); and
- sends its command banner to **stderr**, keeping stdout clean for the MCP stdio
  protocol.

This is why no hand-rolled launcher is needed (the former
`bin/steuererklaerung-cli-gjs.sh` was removed). The only path `gjsify run` does not
inject is the *external* ERiC runtime (`ERIC_HOME`) for ELSTER — pass it via an
inherited `LD_LIBRARY_PATH` (gjsify run appends its own paths to it).
