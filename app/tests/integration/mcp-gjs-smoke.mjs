// Smoke test: the steuererklaerung MCP stdio server runs natively on GJS and answers
// a real `initialize` + `tools/list` handshake driven by the MCP SDK client.
//
// Launches via `gjsify run` (the production entry, @gjsify/cli >= 0.5.0): it
// resolves every dependency's native prebuild paths (libsoup/tls + the
// @steuererklaerung/eric typelib) on its own and keeps stdout uncontaminated (its
// banner goes to stderr), so we spawn it with a CLEAN env — no manual
// LD_LIBRARY_PATH / GI_TYPELIB_PATH. A green run proves the launcher script is
// no longer needed.
//
// Prerequisite: `npm install` + `npm run build:gjs`, and a `gjs` >= 1.86 on PATH.
// Run with: `node tests/integration/mcp-gjs-smoke.mjs`.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, '..', '..'); // tests/integration -> cli
const repoRoot = join(cliRoot, '..'); // cli -> workspace root
const bundle = join(cliRoot, 'dist', 'steuer.gjs.mjs');
assert(existsSync(bundle), 'run `npm run build:gjs` first — dist/steuer.gjs.mjs missing');

const gjsify = join(repoRoot, 'node_modules', '.bin', 'gjsify');
assert(existsSync(gjsify), 'run `npm install` first — @gjsify/cli (>= 0.5.0) bin missing');

// Clean env: strip native paths so success proves `gjsify run` resolves them.
const env = { ...process.env };
delete env.LD_LIBRARY_PATH;
delete env.GI_TYPELIB_PATH;

const transport = new StdioClientTransport({
    command: gjsify,
    args: ['run', bundle, 'mcp'],
    env,
    cwd: cliRoot,
    stderr: 'inherit',
});

const client = new Client({ name: 'gjs-smoke', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const info = client.getServerVersion();
assert.equal(info?.name, 'steuererklaerung', `unexpected server name: ${info?.name}`);

const { tools } = await client.listTools();
// MEASURED, not guessed: 64 with every group enabled, after mail/contacts/calendar moved out
// to postbote. The floor is a little below that so a config-gated group does not fail the run,
// but a whole group disappearing still does.
assert(tools.length >= 60, `expected >= 60 tools, got ${tools.length}`);

// A representative tool from each remaining group must be registered, independent of whether
// its backend is reachable here. Mail, contacts and calendar moved out to postbote, which has
// its own smoke test.
const toolNames = new Set(tools.map((t) => t.name));
for (const name of [
    'paperless_search_documents',
    'qonto_search_transactions',
    'transactions_search',
    'elster_euer_report',
    'invoices_list',
    'list_contacts',
]) {
    assert(toolNames.has(name), `missing tool: ${name}`);
}

console.log(`OK: MCP stdio server on GJS — ${tools.length} tools (server ${info.name} ${info.version})`);

// A real tools/call. Tolerate an environment without the backing store or credentials (e.g.
// headless CI): we assert the server answers with a well-formed result, not that it succeeds.
// paperless_list_tags takes no arguments, so this exercises a real round trip rather than
// bouncing off input validation.
const res = await client.callTool({ name: 'paperless_list_tags', arguments: {} });
assert(Array.isArray(res.content) && res.content.length > 0, 'paperless_list_tags returned no content');
if (res.isError) {
    console.log(`OK: paperless_list_tags callable (unreachable here: ${String(res.content[0].text).slice(0, 80)})`);
} else {
    const tags = JSON.parse(res.content[0].text);
    assert(Array.isArray(tags), 'expected an array of tags');
    console.log(`OK: paperless_list_tags → ${tags.length} tag(s)`);
}

await client.close();
process.exit(0);
