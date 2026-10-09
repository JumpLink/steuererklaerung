#!/usr/bin/env node
// Every glossary term the app REFERENCES must exist in the shared GLOSSARY.
//
// The "?" button hides itself for an unknown term (`syncVisible` needs `hasEntry`), which is the
// right runtime behaviour and the worst possible development behaviour: a typo'd or renamed term
// does not throw, does not warn, and does not render — the help is simply absent, and absent help
// looks exactly like help that was never asked for. The Lernmodus setting then promises
// explanations "in jeder Ansicht" and quietly delivers fewer.
//
// Runs over source text rather than the built bundle: the terms are string literals at the call
// sites, and this must fail in `check`, before anything is built or screenshotted.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const GLOSSARY_FILE = join(ROOT, 'src/core/lib/glossary.ts');
const SEARCH_DIRS = ['src/frontends/desktop', 'src/frontends/web'];

/** Top-level keys of one glossary object literal (`GLOSSARY` or `GLOSSARY_EN`). */
function termsOf(name) {
    const src = readFileSync(GLOSSARY_FILE, 'utf8');
    const start = src.indexOf(`export const ${name}:`);
    const end = src.indexOf('\n};', start);
    const body = src.slice(start, end);
    return new Set([...body.matchAll(/^ {4}'?([a-zA-Z0-9_-]+)'?:\s*\{/gm)].map((m) => m[1]));
}

function* walk(dir) {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) yield* walk(path);
        else if (path.endsWith('.ts')) yield path;
    }
}

const known = termsOf('GLOSSARY');
const missing = [];
// The English UI reads GLOSSARY_EN: a term only one language explains is the same silent hole.
const english = termsOf('GLOSSARY_EN');
for (const term of known) if (!english.has(term)) missing.push(`GLOSSARY_EN: '${term}' fehlt`);
for (const term of english) if (!known.has(term)) missing.push(`GLOSSARY: '${term}' fehlt (nur in GLOSSARY_EN)`);
// The three shapes a term is referenced in: the widget constructor, the group helper, and the
// `help: { term: … }` option object the views pass around.
const patterns = [/new BhGlossaryHelp\(\s*'([^']+)'/g, /helpFor\([^,]+,\s*'([^']+)'/g, /term:\s*'([^']+)'/g];

for (const dir of SEARCH_DIRS) {
    let files;
    try {
        files = [...walk(join(ROOT, dir))];
    } catch {
        continue; // an absent frontend is not a failure
    }
    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const pattern of patterns) {
            for (const match of text.matchAll(pattern)) {
                if (!known.has(match[1])) missing.push(`${file.slice(ROOT.length)}: '${match[1]}'`);
            }
        }
    }
}

if (missing.length > 0) {
    console.error(`check-glossary-terms: ${missing.length} Begriff(e) ohne Eintrag in GLOSSARY:`);
    for (const m of missing) console.error(`  ${m}`);
    console.error('Ein unbekannter Begriff versteckt den "?"-Knopf lautlos — Hilfe, die niemand vermisst.');
    process.exit(1);
}
console.log(`check-glossary-terms: alle referenzierten Begriffe sind erklärt (${known.size} im Glossar).`);
