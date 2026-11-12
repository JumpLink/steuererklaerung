#!/usr/bin/env node
// Every write tool of the MCP server has an approval tier (ADR 0005).
//
// The lotse assistant may one day call this app's write tools, and what it has to ask the person
// first depends on the tool: tier A (the app's own dialog, one call) or tier B (lotse's dialog,
// per call). The tiers are written out in `src/core/actions/assistant/write-tiers.ts`; this gate
// makes sure that list cannot fall behind the tools. It reads `registerTool(` calls by source text,
// like the other `check:*` gates, and a write tool is one annotated `readOnlyHint: false`.
//
// Red when:
//   - a write tool is in no tier (the new tool nobody classified),
//   - a name is in both tiers, or twice in one,
//   - a tiered name is no write tool any more (renamed, removed, or made read-only) — so the list
//     cannot rot,
//   - a write tool is registered under a name this scan cannot read (a variable), because a tool
//     it cannot see is a tool it cannot tier.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const TOOLS_DIR = join(ROOT, 'src/frontends/mcp/tools');
const TIERS_FILE = join(ROOT, 'src/core/actions/assistant/write-tiers.ts');

/** Names in `export const <const> = [ 'a', 'b', ] as const;`. */
function tierList(source, constName) {
    const match = new RegExp(`export const ${constName} = \\[([^\\]]*)\\] as const;`).exec(source);
    if (!match) {
        console.error(`check:assistant-tiers: ${constName} not found in ${TIERS_FILE}`);
        process.exit(1);
    }
    // A commented-out name is not a tiered one.
    const body = match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const writes = new Set();
const unreadable = [];
for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'))) {
    const chunks = readFileSync(join(TOOLS_DIR, file), 'utf-8')
        .split(/\bregisterTool\(/)
        .slice(1);
    for (const chunk of chunks) {
        // A chunk ends where the next registration starts, so the first hint belongs to this tool.
        if (/\breadOnlyHint:\s*(true|false)/.exec(chunk)?.[1] !== 'false') continue;
        const name = /^\s*'([^']+)'/.exec(chunk)?.[1];
        if (name) writes.add(name);
        else unreadable.push(`${file}: ${chunk.slice(0, 40).replace(/\s+/g, ' ')}`);
    }
}

const source = readFileSync(TIERS_FILE, 'utf-8');
const a = tierList(source, 'TIER_A_TOOLS');
const b = tierList(source, 'TIER_B_TOOLS');
const tiered = [...a, ...b];

const problems = [];
for (const name of [...writes].sort()) {
    if (!tiered.includes(name)) problems.push(`write tool without a tier: ${name}`);
}
for (const name of new Set(tiered)) {
    if (tiered.filter((n) => n === name).length > 1) problems.push(`in more than one place: ${name}`);
    if (!writes.has(name)) problems.push(`tiered but not a write tool: ${name}`);
}
for (const line of unreadable) problems.push(`write tool with a name this gate cannot read: ${line}`);

if (problems.length > 0) {
    console.error('check:assistant-tiers FAILED — write-tiers.ts and the MCP write tools disagree:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
        'Put each write tool in TIER_A_TOOLS or TIER_B_TOOLS (docs/adr/0005-assistant-writes-in-two-tiers.md).',
    );
    process.exit(1);
}
console.log(`check:assistant-tiers: ${writes.size} write tools, ${a.length} in tier A, ${b.length} in tier B.`);
