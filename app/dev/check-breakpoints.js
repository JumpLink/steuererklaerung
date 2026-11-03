#!/usr/bin/env node
// Every `Adw.Breakpoint` ladder in a .blp must be ordered so that each rung can actually apply.
//
// The rule and the incident behind it are in `breakpoint-scan.ts`, where the unit tests pin them:
// libadwaita applies exactly ONE breakpoint, found by walking them in reverse order of addition,
// so the narrowest `max-width` rung has to be declared last or it is dead code that compiles,
// builds and runs.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { orderProblems, scanBreakpoints } from './breakpoint-scan.ts';

const ROOT = join(import.meta.dirname, '..', 'src');

/** Every .blp under `dir`, recursively. */
function blueprints(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...blueprints(full));
        else if (entry.endsWith('.blp')) out.push(full);
    }
    return out;
}

const problems = [];
for (const blp of blueprints(ROOT)) {
    const breakpoints = scanBreakpoints(readFileSync(blp, 'utf-8'));
    if (breakpoints.length < 2) continue;
    for (const problem of orderProblems(breakpoints)) problems.push(`${blp}: ${problem}`);
}

if (problems.length > 0) {
    console.error(`check-breakpoints: ${problems.length} unreachable breakpoint rung(s):\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
        '\nlibadwaita applies ONE breakpoint — the last added whose condition holds. A rung listed\n' +
            'before a wider one never runs its setters, and nothing else reports it: the template\n' +
            'compiles, the app starts, and the window just keeps the wider layout. Reorder the rungs.',
    );
    process.exitCode = 1;
} else {
    console.log('check-breakpoints: every breakpoint rung is reachable.');
}
