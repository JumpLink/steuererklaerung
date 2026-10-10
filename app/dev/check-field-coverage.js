#!/usr/bin/env node
// Which configuration fields a person can actually reach from the app — and which ones only a text
// editor or an agent can write.
//
// This app's claim is that it is usable without AI. That claim is about the FIELDS: every one that
// a user is expected to fill has to have a surface, and the ones that do not are invisible — they
// look identical, from the code, to fields nobody needs. Every gap found by hand so far (the
// Steuernummer, the classification rules, the recurring schedules, the children of the Anlage Kind)
// was found by someone stumbling over it, which is not a method.
//
// So: enumerate the schema's writable leaves, and check each one is mentioned somewhere in the
// desktop frontend. A mention is weak evidence — a field name can appear in a comment — but the
// ABSENCE of one is strong: a field the GUI never names is a field the GUI cannot write.
//
// The known gaps live in `field-coverage.allow.json` with a reason each. The list is meant to
// shrink; what it must never do is grow silently.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { mentions, schemaLeaves as scanSchemaLeaves, stripNonCode } from './field-coverage-scan.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const SCHEMA_DIR = join(ROOT, 'src/core/config/schema');
const SURFACE_DIRS = ['src/frontends/desktop'];
const ALLOW_FILE = join(ROOT, 'dev/field-coverage.allow.json');

/**
 * Leaf field names declared in a Zod schema file, with where each one is — which block a gap
 * belongs to is the first thing anyone reading the report needs. The scanning itself lives in
 * `field-coverage-scan.ts`, where the unit tests pin it.
 */
function schemaLeaves(file) {
    const leaves = new Map(); // name → { where, block }
    for (const [name, leaf] of scanSchemaLeaves(readFileSync(file, 'utf8'))) {
        leaves.set(name, { where: `${file.slice(ROOT.length)}:${leaf.line}`, block: leaf.block });
    }
    return leaves;
}

function* walk(dir) {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) yield* walk(path);
        else if (path.endsWith('.ts') || path.endsWith('.blp')) yield path;
    }
}

/**
 * The text a field name has to appear in: the desktop frontend, and NOTHING else.
 *
 * The tempting widening is to follow the views' imports one hop into `core/` — a field can be
 * reachable through an abstraction that never names it in a view, the way the classification lists
 * are edited by a real editor that iterates `NEEDLE_LIST_META` instead of naming
 * `privat_gegenseiten`. That version was written and measured: it cut the report from 96 fields to
 * 39, and three of the fields it silenced — `finanzamt`, `rechtsform`, `einkunftsart` — have no row
 * anywhere. They were merely NAMED by a core module a view imports for something else.
 *
 * A false positive costs one allowance line that says where the field really is reachable. A false
 * negative is this check reporting green over the exact gap it exists to find. So the surface stays
 * narrow and the indirection is written down in the allowlist, where a person reads it.
 */
function surfaceText() {
    return SURFACE_DIRS.flatMap((dir) => [...walk(join(ROOT, dir))])
        .map((file) => stripNonCode(readFileSync(file, 'utf8')))
        .join('\n');
}

const surface = surfaceText();

/**
 * The allowlist, flattened from `{ groups: { <slug>: { reason, fields } } }` to field → reason.
 *
 * Grouped rather than one entry per field because the honest reason is usually one sentence about a
 * whole block — "this domain has no view at all" — and repeating it 30 times makes the list read as
 * 30 separate decisions instead of one. The FIELDS stay listed individually so the list still
 * shrinks one field at a time.
 */
function loadAllow() {
    if (!existsSync(ALLOW_FILE)) return new Map();
    const raw = JSON.parse(readFileSync(ALLOW_FILE, 'utf8'));
    const out = new Map();
    for (const [slug, group] of Object.entries(raw.groups ?? {})) {
        if (!group.reason) throw new Error(`field-coverage.allow.json: Gruppe „${slug}" hat keine Begründung.`);
        for (const field of group.fields ?? []) out.set(field, { slug, reason: group.reason });
    }
    return out;
}

const allow = loadAllow();
const missing = [];
const covered = [];
/** Field name → the schema files that declare it, to expose cross-schema name collisions. */
const declaredIn = new Map();
/** Every `<file>:<field>` the schemas declare — an allowance outside this set names nothing. */
const allDeclared = [];
const staleAllowances = new Set(allow.keys());

for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts')) {
    for (const [name, leaf] of schemaLeaves(join(SCHEMA_DIR, file))) {
        declaredIn.set(name, [...(declaredIn.get(name) ?? []), file]);
        // Allowances are keyed `<schema file>:<field>`, never a bare field name: `spenden` and
        // `adresse` each exist in two schemas, and a bare key would excuse both at once.
        const key = `${file}:${name}`;
        allDeclared.push(key);
        // The name as written in the schema, and the camelCase the TS side usually uses for it.
        const camel = name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
        const mentioned = mentions(surface, name) || (camel !== name && mentions(surface, camel));
        if (mentioned) {
            covered.push(name);
            // NOT removed from staleAllowances: an allowance for a field that is now reachable is
            // exactly what the stale check below looks for. An earlier version deleted the key
            // here, which made that check unable to fire at all — it reported green against a
            // deliberately stale entry, which is worse than not having the check.
            continue;
        }
        if (allow.has(key)) {
            staleAllowances.delete(key);
            continue;
        }
        missing.push({ name, where: leaf.where, block: leaf.block, key });
    }
}

// A name declared by two schemas is matched against ONE global text, so a row built for either one
// marks both covered. That is a false negative — the exact thing this check must not produce
// quietly — and it cannot be fixed by a text scan, so it is printed instead of hidden. `spenden`
// exists as a Gewerbesteuer-Kürzung and as an ESt-Sonderausgabe; building the first silenced the
// second, and nothing said so until this list did.
const ambiguous = [...declaredIn]
    .filter(([name, files]) => files.length > 1 && covered.includes(name))
    .map(([name, files]) => `${name} (${files.join(', ')})`);
if (ambiguous.length > 0) {
    console.log(
        `check-field-coverage: ${ambiguous.length} Feldname(n) kommen in mehreren Schemata vor und gelten\n` +
            'schon als erreichbar, sobald EINES davon eine Zeile hat — hier von Hand nachsehen:',
    );
    for (const line of ambiguous) console.log(`  ${line}`);
}

// An allowance for a field that IS reachable now is the list failing to shrink. Removing it is the
// point of the exercise, so it is an error rather than a note.
const declaredKeys = new Set(allDeclared);
const nowCovered = [...staleAllowances].filter((key) => declaredKeys.has(key));
// And an allowance naming a field NO schema declares any more is dead weight that reads as a known
// gap — the reason it states outlived the field it excused.
const unknown = [...staleAllowances].filter((key) => !declaredKeys.has(key));
if (nowCovered.length > 0 || unknown.length > 0) {
    console.error('check-field-coverage: die Allowlist ist nicht mehr aktuell:');
    for (const key of nowCovered) console.error(`  ${key} — hat jetzt eine Oberfläche, Eintrag entfernen`);
    for (const key of unknown) console.error(`  ${key} — gibt es im Schema nicht (mehr), Eintrag entfernen`);
    process.exit(1);
}

if (missing.length > 0) {
    console.error(`check-field-coverage: ${missing.length} Feld(er) ohne Oberfläche:`);
    for (const m of missing) console.error(`  ${m.key}  · ${m.block}  · ${m.where}`);
    console.error(
        'Entweder eine Zeile dafür bauen, oder in dev/field-coverage.allow.json mit Begründung eintragen.\n' +
            'Ein Feld, das nur ein Texteditor schreiben kann, ist in einer App, die ohne KI benutzbar sein will,\n' +
            'kein Feature — es sieht im Code nur genauso aus wie eines, das niemand braucht.',
    );
    process.exit(1);
}
console.log(`check-field-coverage: ${covered.length} Felder erreichbar, ${allow.size} begründete Ausnahmen.`);
