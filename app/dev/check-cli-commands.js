#!/usr/bin/env node
// Every CLI command that EXISTS must also be reachable — exported from the barrel and registered
// on yargs.
//
// A command module that nobody imports is not a compile error, not a lint error and not a test
// failure: the file type-checks, the bundle builds, and `steuer --help` simply does not list it.
// The only way to notice is to want the command and be told "Unknown command" — which is how
// `time` sat fully implemented (store, core actions, CLI module, even `time bill`) but
// unreachable from 2026-08 until 2026-09-10. Written, tested, shipped, invisible.
//
// Runs over source text rather than the built bundle, so it fails in `check` before anything is
// built — and because the bundle is exactly what would happily leave the command out.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const CLI_DIR = join(ROOT, 'src/frontends/cli');
const BARREL = join(CLI_DIR, 'index.ts');
const ENTRY = join(ROOT, 'src/index.ts');

/**
 * The files the barrel is meant to cover: every module directly in `cli/`, plus the `index.ts` of
 * each sub-command group. Files *inside* a group (elster/, paperless/, sync/) export sub-commands
 * that their own parent registers — those are not expected on the top-level yargs instance.
 */
function surfaceModules() {
    const out = [];
    for (const entry of readdirSync(CLI_DIR, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            const idx = join(CLI_DIR, entry.name, 'index.ts');
            if (existsSync(idx)) out.push([`./${entry.name}/index.ts`, idx]);
        } else if (entry.name.endsWith('.ts') && entry.name !== 'index.ts') {
            out.push([`./${entry.name}`, join(CLI_DIR, entry.name)]);
        }
    }
    return out;
}

/**
 * Strip comments before matching. Without this the check passes on a registration that somebody
 * commented out — the one shape in which a command most plausibly gets disabled by accident, and
 * the shape this guard was verified against.
 */
function withoutComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const barrel = withoutComments(readFileSync(BARREL, 'utf8'));
const entry = withoutComments(readFileSync(ENTRY, 'utf8'));
const problems = [];

for (const [spec, path] of surfaceModules()) {
    const src = readFileSync(path, 'utf8');
    const commands = [...src.matchAll(/^export const (\w*Command)\s*:/gm)].map((m) => m[1]);
    if (commands.length === 0) continue;

    if (!barrel.includes(`'${spec}'`)) {
        problems.push(`${spec} exportiert ${commands.join(', ')}, fehlt aber in cli/index.ts`);
        continue;
    }
    for (const name of commands) {
        if (!new RegExp(`\\.command\\(\\s*${name}\\s*\\)`).test(entry)) {
            problems.push(`${name} (${spec}) ist nicht per .command() in src/index.ts registriert`);
        }
    }
}

if (problems.length > 0) {
    console.error('Nicht erreichbare CLI-Kommandos:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nEin Kommando ohne Registrierung ist fuer Nutzende schlicht nicht vorhanden.');
    process.exit(1);
}

console.log('check:cli-commands — alle CLI-Kommandos sind exportiert und registriert.');
