#!/usr/bin/env node
// The web client's Adwaita markup, held against the INSTALLED @gjsify/adwaita-web.
//
// Three things a custom-element toolkit can rename under you, and all three fail SILENTLY:
//
//   1. A TAG. An unregistered custom element is a valid, inert `HTMLUnknownElement`-alike:
//      it parses, it lays out as a bare inline box, and nothing anywhere throws. `adw-button`
//      -> `gtk-button` (gjsify #1459) renamed nine of them at once.
//   2. An ATTRIBUTE. Anything outside `observedAttributes` is inherited, never read. 0.48
//      replaced `<adw-spin-row min max step>` with one `adjustment` (#1570): the row still
//      steps, on the DEFAULT range, so a declared max of 120 silently became 100.
//   3. A CSS CLASS. `class="adw-button"` on a plain `<button>` is the toolkit's documented
//      styling API and is NOT the element name — `<gtk-button>` renders an inner
//      `<button class="adw-button">`. Renaming the class along with the element strips
//      every button in the app back to the browser default, which typechecks, lints and
//      passes every unit test.
//
// None of the three is visible to tsc (they live in template strings), to the linter, or to
// the test suite (which never mounts the client). This check is the only thing between a
// version bump and a UI that renders but does nothing.
//
// It fails LOUDLY when it cannot measure: an empty registry or an empty class list is a
// broken probe, not a clean bill of health. The 0.48 bump's first tag check globbed a path
// that does not exist in the published layout and reported all 30 tags missing.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PKG = join(ROOT, '../node_modules/@gjsify/adwaita-web');
const SEARCH_DIRS = ['src/frontends/web'];
/** Written on any element, never declared by one. */
const GLOBAL_ATTRS = new Set(['class', 'id', 'slot', 'style', 'hidden', 'role', 'part', 'tabindex', 'lang', 'dir']);

function* walk(dir, exts) {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) yield* walk(path, exts);
        else if (exts.some((e) => path.endsWith(e))) yield path;
    }
}

/**
 * tag -> the attribute names its defining module knows, read from the package's own source
 * (its runtime entry IS `src/`, not a built `lib/`).
 *
 * The set is `observedAttributes` UNION every `getAttribute('…')` literal in the same file,
 * because those are two different contracts and only their union is "read at all":
 * `<adw-sidebar selected>` is never observed and is read once at connect time. A module
 * defining several elements shares one set — deliberately permissive, since a false ALARM
 * here would get the whole check switched off, while the renames it exists for (`min`/`max`/
 * `step` on the spin row) leave the file entirely.
 *
 * `[...AdwEntryRow.observedAttributes, 'revealed']` is resolved across files: the password
 * entry row declares one attribute of its own and inherits six.
 */
function registry() {
    const perTag = new Map(); // tag -> Set(attribute) from its own file
    const perClass = new Map(); // class -> Set(attribute) it declares itself
    const spreads = new Map(); // tag -> [base class names]
    for (const file of walk(join(PKG, 'src'), ['.ts'])) {
        if (file.endsWith('.spec.ts')) continue;
        const src = readFileSync(file, 'utf8');
        const defined = [...src.matchAll(/customElements\.define\(\s*['"]([a-z0-9-]+)['"]/g)].map((m) => m[1]);
        const known = new Set();
        const bases = [];
        // Attribute literals inside each `observedAttributes` block, kept per declaring class so
        // another file's spread can pick them up.
        for (const part of src
            .split(/export class (\w+)/)
            .slice(1)
            .reduce((acc, x, i, all) => (i % 2 ? acc : [...acc, [x, all[i + 1]]]), [])) {
            const [cls, body] = part;
            const decl = /static get observedAttributes\(\)[^{]*\{\s*return\s*(\[[\s\S]*?\])/.exec(body ?? '');
            if (!decl) continue;
            const own = new Set([...decl[1].matchAll(/['"]([a-z0-9-]+)['"]/g)].map((m) => m[1]));
            perClass.set(cls, own);
            for (const a of own) known.add(a);
            for (const b of decl[1].matchAll(/\.\.\.(\w+)\.observedAttributes/g)) bases.push(b[1]);
        }
        for (const g of src.matchAll(/getAttribute\(\s*['"]([a-z0-9-]+)['"]/g)) known.add(g[1]);
        for (const tag of defined) {
            perTag.set(tag, known);
            spreads.set(tag, bases);
        }
    }
    for (const [tag, bases] of spreads) {
        for (const base of bases) for (const a of perClass.get(base) ?? []) perTag.get(tag).add(a);
    }
    return perTag;
}

/** Every `.adw-*` / `.gtk-*` class the shipped stylesheet defines. */
function styleClasses() {
    const css = readFileSync(join(PKG, 'dist/adwaita-web.css'), 'utf8');
    return new Set([...css.matchAll(/\.((?:adw|gtk)-[a-z0-9-]+)/g)].map((m) => m[1]));
}

const tags = registry();
const classes = styleClasses();
if (tags.size === 0 || classes.size === 0) {
    console.error(`check-adwaita-markup: nichts zu messen — ${tags.size} Elemente, ${classes.size} CSS-Klassen`);
    console.error(`Erwartet unter ${PKG}. Ein leeres Ergebnis ist ein kaputter Test, kein grünes Ergebnis.`);
    process.exit(1);
}

const problems = [];
for (const dir of SEARCH_DIRS) {
    let files;
    try {
        files = [...walk(join(ROOT, dir), ['.ts', '.html'])];
    } catch {
        continue; // an absent frontend is not a failure
    }
    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        const where = (index) => `${file.slice(ROOT.length)}:${text.slice(0, index).split('\n').length}`;

        // 1 + 2: opening tags in the adw-/gtk- namespace, with their attributes.
        for (const m of text.matchAll(/<((?:adw|gtk)-[a-z0-9-]+)((?:\s+[^<>]*?)?)\/?>/g)) {
            const [, tag, attrText] = m;
            const known = tags.get(tag);
            if (known === undefined) {
                problems.push(`${where(m.index)}: <${tag}> ist in @gjsify/adwaita-web nicht registriert`);
                continue;
            }
            for (const a of (attrText ?? '').matchAll(/([a-z][a-z0-9-]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g)) {
                const name = a[1];
                if (GLOBAL_ATTRS.has(name) || name.startsWith('data-') || name.startsWith('aria-')) continue;
                if (!known.has(name)) {
                    problems.push(
                        `${where(m.index)}: <${tag} ${name}=…> wird nicht gelesen (bekannt: ${[...known].sort().join(', ')})`,
                    );
                }
            }
        }

        // 3: adw-/gtk- tokens used as a CSS class — the styling API, which does NOT follow
        // an element rename.
        for (const m of text.matchAll(/class\s*=\s*(["'])([^"']*)\1/g)) {
            for (const token of m[2].split(/\s+/)) {
                // `class="adw-button${active}"` — the token is half a template expression; the
                // literal half is what this can judge.
                const literal = token.includes('${') ? token.slice(0, token.indexOf('${')) : token;
                if (!/^(adw|gtk)-/.test(literal) || classes.has(literal)) continue;
                const asElement = tags.has(literal) ? ` — ${literal} ist ein ELEMENT, keine Klasse` : '';
                problems.push(`${where(m.index)}: class="… ${literal} …" kennt das Stylesheet nicht${asElement}`);
            }
        }
    }
}

if (problems.length > 0) {
    console.error(`check-adwaita-markup: ${problems.length} Fund(e) gegen die installierte @gjsify/adwaita-web:`);
    for (const p of problems) console.error(`  ${p}`);
    console.error('Ein unbekanntes Tag, ein ungelesenes Attribut und eine tote Klasse sehen alle aus wie „läuft".');
    process.exit(1);
}
console.log(
    `check-adwaita-markup: Markup passt zur installierten @gjsify/adwaita-web (${tags.size} Elemente, ${classes.size} CSS-Klassen).`,
);
