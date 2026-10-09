#!/usr/bin/env node
// Every `=> $handler()` in a .blp must name a method that exists on the class beside it.
//
// WHY THIS EXISTS, measured 2026-08-23: renaming `_onCloseClicked` to `_onCloseClickedBROKEN` while
// `assistent-panel.blp` still said `clicked => $_onCloseClicked()` produced NO error and NO warning.
// The bundle built, the app launched, the screenshot succeeded — and the close button silently did
// nothing. Nothing else in the toolchain sees this: it is not a type (the .blp is a string to
// TypeScript), it is not a lint finding, and GtkBuilder does not treat an unresolvable handler as
// fatal. A screenshot cannot see it either, because a template with an unconnected button renders
// exactly like one with a connected button.
//
// The check is deliberately syntactic and local: for each `<name>.blp`, read `<name>.ts` beside it
// and require a member of that name. That misses a handler inherited from a base class, which this
// app does not do; it would rather be extended the day it does than be silent now.
//
// Candidate to move into gjsify, where every Blueprint consumer would get it. Not yet: a capability
// cannot be used by a consumer before it is published, which this workspace has just paid to learn.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

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

// `clicked => $_onSave()` / `notify::active => $_onToggled(swap)`. The handler name is what follows
// the `$`; Blueprint allows a trailing argument list we do not care about.
const HANDLER = /=>\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

/**
 * Strip comments before matching.
 *
 * Found by this check's own first run: a comment in `assistent-panel.blp` that DOCUMENTS the
 * convention (`clicked => $_onX()`) was reported as an unresolvable handler. A checker that flags
 * prose about itself is a checker people switch off.
 */
function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const problems = [];
for (const blp of blueprints(ROOT)) {
    const source = stripComments(readFileSync(blp, 'utf-8'));
    const handlers = [...source.matchAll(HANDLER)].map((m) => m[1]);
    if (handlers.length === 0) continue;

    const ts = join(dirname(blp), `${basename(blp, '.blp')}.ts`);
    let code;
    try {
        code = readFileSync(ts, 'utf-8');
    } catch {
        problems.push(`${blp}: names ${handlers.length} handler(s) but has no ${basename(ts)} beside it`);
        continue;
    }
    for (const name of new Set(handlers)) {
        // A method declaration, however it is spelled: `name(`, `private name(`, `async name(`.
        if (
            !new RegExp(
                `(^|[\\s;{])(private\\s+|protected\\s+|public\\s+|static\\s+|async\\s+)*${name}\\s*\\(`,
                'm',
            ).test(code)
        ) {
            problems.push(`${blp}: \`=> $${name}()\` has no matching method in ${basename(ts)}`);
        }
    }
}

if (problems.length > 0) {
    console.error(`check-blp-handlers: ${problems.length} unresolvable template handler(s):\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
        '\nAn unresolvable handler is not an error to GtkBuilder: the widget is built, the app runs,\n' +
            'and the control silently does nothing. Rename the method or the reference so they agree.',
    );
    process.exitCode = 1;
} else {
    console.log('check-blp-handlers: every template handler resolves.');
}
