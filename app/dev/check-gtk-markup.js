#!/usr/bin/env node
// Desktop counterpart of check-adwaita-markup.js: Adwaita rows, groups, banners and toasts parse
// `title` / `subtitle` / `description` as Pango markup (`use-markup` defaults to true). A data
// string with `&` or `<` — a supplier called "1&1 Telecom GmbH" — is rejected by GTK, which logs
// `Failed to set text … from markup` and leaves the label EMPTY. Nothing else notices.
//
// So every such property in src/frontends/desktop must be a literal, a translation call
// (`_()` / `_p()` / `_n()`), wrapped in `markup()` (views/util.ts), or sit in a constructor that
// sets `useMarkup: false`. Put `// markup-ok` on the line when a computed value is known safe.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIR = join(ROOT, 'src/frontends/desktop');
const WIDGETS =
    'ActionRow|ExpanderRow|SwitchRow|ComboRow|SpinRow|EntryRow|PreferencesGroup|PreferencesRow|Banner|Toast|StatusPage|ButtonRow';
const PROPS = new Set(['title', 'subtitle', 'description']);

/**
 * Does the expression read a field off a record (`contact.name`, `h.title`, `this.topic.titel`)?
 * That is the shape data takes on its way into a row. Plain identifiers (a helper's own `title`
 * parameter) are judged where the value is produced; `markup(…)` arguments, string literals and
 * `.length` are not data in this sense.
 */
function readsData(value) {
    let v = value;
    for (let at = v.indexOf('markup('); at >= 0; at = v.indexOf('markup(')) {
        let depth = 0;
        let end = at + 6;
        for (; end < v.length; end++) {
            if (v[end] === '(') depth++;
            else if (v[end] === ')' && --depth === 0) break;
        }
        v = v.slice(0, at) + v.slice(end + 1);
    }
    v = v.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''").replace(/\.length\b/g, '');
    const q = v.search(/[^?]\?(?![.?])/);
    if (q >= 0) v = v.slice(q + 2);
    v = v.replace(/\b(?:Math|Number|String)\.\w+/g, '');
    return /[A-Za-z_)\]]\??\.[A-Za-z_]\w*(?!\w|\()/.test(v);
}

function* walk(dir) {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) yield* walk(path);
        else if (path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.story.ts')) yield path;
    }
}

/** Index of the `}` closing the `{` at `open`, skipping strings and template literals. */
function closing(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const c = text[i];
        if (c === '"' || c === "'" || c === '`') {
            for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
        } else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return i;
    }
    return -1;
}

/** Top-level `key: value` / shorthand `key` entries of an object literal body. */
function entries(body) {
    const out = [];
    let depth = 0;
    let start = 0;
    const flush = (end) => {
        const part = body.slice(start, end);
        const m = /^\s*(\w+)\s*(?::([\s\S]*))?$/.exec(part);
        if (m) out.push({ key: m[1], value: (m[2] ?? m[1]).trim(), at: start });
        start = end + 1;
    };
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c === '"' || c === "'" || c === '`') {
            for (i++; i < body.length && body[i] !== c; i++) if (body[i] === '\\') i++;
        } else if ('({['.includes(c)) depth++;
        else if (')}]'.includes(c)) depth--;
        else if (c === ',' && depth === 0) flush(i);
    }
    flush(body.length);
    return out;
}

const problems = [];
let seen = 0;
for (const file of walk(DIR)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(new RegExp(`new Adw\\.(?:${WIDGETS})\\(\\{`, 'g'))) {
        const open = m.index + m[0].length - 1;
        const end = closing(text, open);
        if (end < 0) continue;
        seen++;
        const body = text.slice(open + 1, end);
        const list = entries(body);
        if (list.some((e) => e.key === 'useMarkup' && e.value === 'false')) continue;
        for (const e of list) {
            if (!PROPS.has(e.key) || !readsData(e.value)) continue;
            const abs = text.slice(0, open + 1 + e.at + body.slice(e.at).search(/\S/)).split('\n').length;
            if (
                text
                    .split('\n')
                    .slice(abs - 1, abs + 2)
                    .some((l) => l.includes('markup-ok'))
            )
                continue;
            problems.push(
                `${file.slice(ROOT.length)}:${abs}: ${m[0].slice(4, -2)} ${e.key}: ${e.value.slice(0, 60).replace(/\s+/g, ' ')} — markup() oder useMarkup: false`,
            );
        }
    }
}
if (seen === 0) {
    console.error('check-gtk-markup: kein Adw-Widget gefunden — kaputter Test, kein grünes Ergebnis.');
    process.exit(1);
}
if (problems.length > 0) {
    console.error(`check-gtk-markup: ${problems.length} Daten-Text(e) ungeschützt in Pango-Markup:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
}
console.log(`check-gtk-markup: ${seen} Adw-Widgets, alle title/subtitle/description markup-sicher.`);
