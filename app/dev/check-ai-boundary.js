#!/usr/bin/env node
// Where the app reaches an AI — and what a person does there WITHOUT one.
//
// The app promises that every function can be used without AI (docs/ideen-nutzerfuehrung.md §1).
// A promise like that rots at the moment someone writes `getLLMProvider()` into a new action and
// nobody asks "and without it?". So: find every source file in `src/core` that reaches the LLM,
// and require each one to name its way without AI in `ai-boundary.allow.json`.
//
// "Reaches" means, by import specifier (never by comment text):
//   - it imports `clients/llm/…` or `@anthropic-ai/claude-agent-sdk` (a DIRECT site), or
//   - it imports a file that is itself a site (an INDIRECT site — `invoices/import.ts` never names
//     the provider but calls the extraction that does).
// The walk follows imports through `src/core` only and does not pass through `index.ts` barrels:
// a barrel re-exports, it decides nothing, and walking through it would flag half the app. The
// frontends are adapters of the core sites and are not listed; the core file is the decision.
//
// Excluded by RULE, not by list: `src/core/clients/llm/**` (the provider implementations) and
// `engine-status.ts` (it asks whether an engine answers, it is the "is AI set up?" probe itself).
// Both ARE the AI layer, so a "way without AI" for them has no meaning.
//
// A new site without an entry is red. An entry for a file that no longer reaches AI is red too, so
// the list cannot rot. An entry with no `ohneKi` sentence is red: "no way yet" is allowed, "didn't
// think about it" is not — say so with an `idee`.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const CORE = join(ROOT, 'src/core');
const ALLOW_FILE = join(ROOT, 'dev/ai-boundary.allow.json');

const AI_LAYER_DIR = join(CORE, 'clients/llm') + '/';
const AI_LAYER_FILES = new Set([join(CORE, 'actions/assistant/engine-status.ts')]);
const AI_SPECIFIER = /(?:^|\/)clients\/llm(?:\/|$)|^@anthropic-ai\/claude-agent-sdk$/;

function* walk(dir) {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) yield* walk(path);
        else if (path.endsWith('.ts')) yield path;
    }
}

/** Import specifiers: `from 'x'`, `import 'x'`, `import('x')`. */
function specifiers(src) {
    const out = [];
    const re = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
    for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1]);
    return out;
}

const isAiLayer = (file) => file.startsWith(AI_LAYER_DIR) || AI_LAYER_FILES.has(file);
const isBarrel = (file) => file.endsWith('/index.ts');

const files = [...walk(CORE)].filter((f) => !isAiLayer(f));
/** file → resolved relative core imports */
const imports = new Map();
const sites = new Map(); // file → 'direkt' | 'indirekt'
for (const file of files) {
    const rel = [];
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (AI_SPECIFIER.test(spec)) sites.set(file, 'direkt');
        else if (spec.startsWith('.')) rel.push(resolve(dirname(file), spec));
    }
    imports.set(file, rel);
}

// Propagate: whoever imports a site is a site, until nothing changes. Barrels neither carry nor
// receive the flag (see header).
for (let changed = true; changed;) {
    changed = false;
    for (const file of files) {
        if (sites.has(file) || isBarrel(file)) continue;
        if (imports.get(file).some((target) => sites.has(target))) {
            sites.set(file, 'indirekt');
            changed = true;
        }
    }
}
for (const file of sites.keys()) if (isBarrel(file)) sites.delete(file);

const key = (file) => relative(ROOT, file);
const found = new Map([...sites].map(([file, how]) => [key(file), how]));

const allow = existsSync(ALLOW_FILE) ? (JSON.parse(readFileSync(ALLOW_FILE, 'utf8')).sites ?? {}) : {};

const problems = [];
for (const [path, how] of [...found].sort()) {
    if (!allow[path])
        problems.push(`${path} (${how}) — erreicht die KI, aber kein Eintrag in dev/ai-boundary.allow.json`);
}
for (const [path, entry] of Object.entries(allow)) {
    if (!found.has(path)) problems.push(`${path} — erreicht die KI nicht mehr (oder gibt es nicht), Eintrag entfernen`);
    else if (typeof entry.ohneKi !== 'string' || entry.ohneKi.trim() === '') {
        problems.push(`${path} — "ohneKi" fehlt: ein Satz, welcher Weg ohne KI das ersetzt (oder "idee")`);
    }
}

if (problems.length > 0) {
    console.error(`check-ai-boundary: ${problems.length} Problem(e):`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(
        'Jede Stelle, an der die KI erreicht wird, braucht einen Weg ohne KI — die App verspricht, ohne sie\n' +
            'benutzbar zu sein. Eintrag mit "ohneKi" (und ggf. "idee") in dev/ai-boundary.allow.json ergänzen.',
    );
    process.exit(1);
}
const open = Object.values(allow).filter((e) => e.idee).length;
console.log(
    `check-ai-boundary: ${found.size} KI-Stellen, alle mit Weg ohne KI (${open} davon noch mit Idee statt Weg).`,
);
