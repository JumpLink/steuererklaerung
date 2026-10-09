#!/usr/bin/env node
// Every dependency that ends up INSIDE the shipped bundle must have a known licence, and any
// licence that asks for more than attribution must be acknowledged deliberately.
//
// The build statically links its dependencies into one `.mjs`. That is fine for MIT and BSD, and
// it is a decision for anything else — `lib-fints` is LGPL-2.1-or-later, and an LGPL library linked
// into a program is exactly the case the licence writes rules for. A dependency with NO licence
// field is worse than a copyleft one: redistributing it is unlicensed by default.
//
// This does not decide anything. It refuses to let the question ship unnoticed: a licence outside
// the permissive set must be listed in `licenses.acknowledged.json` with the route taken, and the
// generated NOTICE names every dependency either way.
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const ACK_FILE = join(ROOT, 'licenses.acknowledged.json');
const NOTICE_FILE = join(ROOT, 'NOTICE');
// Copies of the licence TEXTS that must travel with the program, not just be named in NOTICE.
// LGPL-2.1 §6 wants the licence with the combined work; naming it is not shipping it.
const LICENSES_DIR = join(ROOT, 'licenses');

/** Licences that a bundle satisfies by attribution alone — the NOTICE below is that attribution. */
const PERMISSIVE = new Set([
    'MIT',
    'ISC',
    'BSD-2-Clause',
    'BSD-3-Clause',
    'Apache-2.0',
    '0BSD',
    'Unlicense',
    'CC0-1.0',
    'MIT OR Apache-2.0',
    'Apache-2.0 OR MIT',
]);

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function packageDir(name) {
    for (const base of [join(ROOT, 'node_modules'), join(dirname(ROOT), 'node_modules')]) {
        const dir = join(base, name);
        if (existsSync(join(dir, 'package.json'))) return dir;
    }
    return null;
}

function resolvePackage(name) {
    const dir = packageDir(name);
    return dir ? readJson(join(dir, 'package.json')) : null;
}

/** The package's own licence file, whatever it is called. */
function licenseFile(name) {
    const dir = packageDir(name);
    if (!dir) return null;
    for (const candidate of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING', 'COPYING.LESSER']) {
        const path = join(dir, candidate);
        if (existsSync(path)) return path;
    }
    return null;
}

const pkg = readJson(join(ROOT, 'package.json'));
const deps = Object.keys(pkg.dependencies ?? {});
const acknowledged = existsSync(ACK_FILE) ? readJson(ACK_FILE) : {};

const entries = [];
const unresolved = [];
for (const name of deps) {
    const meta = resolvePackage(name);
    if (!meta) {
        unresolved.push(name);
        continue;
    }
    const license = typeof meta.license === 'string' ? meta.license : (meta.licenses?.[0]?.type ?? '');
    entries.push({ name, version: meta.version ?? '?', license: license || 'UNKNOWN' });
}
entries.sort((a, b) => a.name.localeCompare(b.name));

const problems = entries.filter((e) => !PERMISSIVE.has(e.license) && !acknowledged[e.name]);

// The NOTICE is GENERATED, so it cannot drift from what is actually installed. A hand-kept list of
// third-party licences is wrong the first time a dependency is added and nobody notices for years.
const lines = [
    `${pkg.name} — Drittanbieter-Hinweise`,
    '',
    'Diese Datei wird erzeugt (dev/check-licenses.js) und listet jede Laufzeit-Abhängigkeit,',
    'die in das ausgelieferte Bundle eingebunden wird, mit Version und Lizenz.',
    '',
];
for (const e of entries) {
    const ack = acknowledged[e.name];
    lines.push(`  ${e.name}@${e.version} — ${e.license}${ack ? `  [${ack.route}]` : ''}`);
    if (ack?.note) lines.push(`      ${ack.note}`);
}
lines.push('');

// Ship the licence text of every acknowledged (i.e. non-permissive) dependency. Rebuilt from
// scratch each run so a removed dependency does not leave its licence behind, claiming the program
// still contains code it no longer has.
rmSync(LICENSES_DIR, { recursive: true, force: true });
const shipped = [];
for (const e of entries) {
    // `shipText` is part of the DECISION, not derived from the licence id: "MIT laut README" needs
    // no separate text, a bundled LGPL library does. Requiring a file for every acknowledgement
    // would have made the honest note about a missing `license` field fail the check.
    if (!acknowledged[e.name]?.shipText) continue;
    const source = licenseFile(e.name);
    if (!source) {
        console.error(`check-licenses: ${e.name} soll seinen Lizenztext mitliefern, hat aber keine Lizenzdatei.`);
        process.exit(1);
    }
    mkdirSync(LICENSES_DIR, { recursive: true });
    const target = join(LICENSES_DIR, `${e.name.replace(/[@/]/g, '-').replace(/^-/, '')}.txt`);
    cpSync(source, target);
    shipped.push(target.slice(ROOT.length));
}
if (shipped.length > 0) {
    lines.splice(
        lines.length - 1,
        0,
        'Vollständige Lizenztexte liegen unter licenses/:',
        ...shipped.map((s) => `  ${s}`),
        '',
    );
}
writeFileSync(NOTICE_FILE, lines.join('\n'), 'utf8');

if (unresolved.length > 0) {
    console.error(`check-licenses: ${unresolved.length} Abhängigkeit(en) nicht auflösbar: ${unresolved.join(', ')}`);
    console.error('Ohne installierte Abhängigkeiten sagt diese Prüfung nichts — erst `gjsify install`.');
    process.exit(1);
}
if (problems.length > 0) {
    console.error('check-licenses: Lizenz(en), die mehr als Namensnennung verlangen, ohne Entscheidung:');
    for (const p of problems) console.error(`  ${p.name}@${p.version} — ${p.license}`);
    console.error(
        `Eintrag in licenses.acknowledged.json anlegen: { "<paket>": { "route": "…", "note": "…" } }.\n` +
            'Das ist eine bewusste Entscheidung, kein Haken — was das Bundle statisch einbindet, wird mit ausgeliefert.',
    );
    process.exit(1);
}
console.log(`check-licenses: ${entries.length} Abhängigkeiten, alle Lizenzen geklärt. NOTICE geschrieben.`);
