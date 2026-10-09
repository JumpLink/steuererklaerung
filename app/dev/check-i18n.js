#!/usr/bin/env node
// Every msgid the source marks must be translated in every catalogue — completely, not fuzzily.
//
// gettext fails SOFT by design: a msgid without a msgstr is shown as the msgid itself. With English
// msgids that means a German user meets one English label in an otherwise German window, and
// nothing anywhere says so. A fuzzy entry is worse: msgfmt skips it, so a reworded string falls
// back to English although the .po file looks translated to anyone reading it.
//
// So this runs the same extraction as `dev/i18n.sh extract` into a temporary file and fails when
//   · the committed .pot is stale (a msgid was added or changed without `i18n:extract`),
//   · a catalogue misses a msgid, leaves it empty or fuzzy,
//   · a msgstr drops or renames a `{name}` placeholder or changes the number of `%s`.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DOMAIN = 'eu.jumplink.Steuererklaerung';

/** Minimal .po reader: enough for msgctxt / msgid / msgid_plural / msgstr[n] and the fuzzy flag. */
function parsePo(text) {
    const entries = [];
    let cur = null;
    let field = null;
    const flush = () => {
        if (cur && cur.msgid !== undefined) entries.push(cur);
        cur = null;
        field = null;
    };
    const unquote = (s) => JSON.parse(s.replace(/\\(?!["\\nt])/g, '\\\\'));
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line === '') {
            flush();
            continue;
        }
        if (line.startsWith('#~')) continue; // obsolete
        cur ??= { flags: [], msgstr: [] };
        if (line.startsWith('#,')) {
            cur.flags.push(
                ...line
                    .slice(2)
                    .split(',')
                    .map((f) => f.trim()),
            );
            continue;
        }
        if (line.startsWith('#')) continue;
        let m;
        if ((m = line.match(/^msgctxt (".*")$/))) {
            if (cur.msgid !== undefined) {
                flush();
                cur = { flags: [], msgstr: [] };
            }
            cur.msgctxt = unquote(m[1]);
            field = 'msgctxt';
        } else if ((m = line.match(/^msgid (".*")$/))) {
            if (cur.msgid !== undefined) {
                flush();
                cur = { flags: [], msgstr: [] };
            }
            cur.msgid = unquote(m[1]);
            field = 'msgid';
        } else if ((m = line.match(/^msgid_plural (".*")$/))) {
            cur.msgid_plural = unquote(m[1]);
            field = 'msgid_plural';
        } else if ((m = line.match(/^msgstr(?:\[(\d+)\])? (".*")$/))) {
            const idx = m[1] === undefined ? 0 : Number(m[1]);
            cur.msgstr[idx] = unquote(m[2]);
            field = `msgstr:${idx}`;
        } else if (line.startsWith('"')) {
            const v = unquote(line);
            if (field?.startsWith('msgstr:')) cur.msgstr[Number(field.slice(7))] += v;
            else if (field) cur[field] += v;
        }
    }
    flush();
    return entries.filter((e) => e.msgid !== '');
}

const key = (e) => `${e.msgctxt ?? ''}\u0004${e.msgid}`;
const show = (e) => (e.msgctxt ? `[${e.msgctxt}] ` : '') + JSON.stringify(e.msgid).slice(0, 90);
const names = (s) =>
    [...s.matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .sort()
        .join(',');
const percents = (s) => (s.match(/%[sd]/g) ?? []).length;

function* walk(dir) {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) yield* walk(path);
        else if (/\.(ts|blp)$/.test(path) && !path.endsWith('.spec.ts')) yield path;
    }
}

const tmp = mkdtempSync(join(tmpdir(), 'check-i18n-'));
const problems = [];
try {
    const files = [...walk(join(ROOT, 'src'))].map((f) => relative(ROOT, f)).sort();
    writeFileSync(join(tmp, 'POTFILES'), files.join('\n') + '\n');
    const res = spawnSync(
        'xgettext',
        [
            `--files-from=${join(tmp, 'POTFILES')}`,
            `--output=${join(tmp, 'fresh.pot')}`,
            '--from-code=UTF-8',
            '--language=JavaScript',
            '--keyword=_',
            '--keyword=_n:1,2',
            '--keyword=_p:1c,2',
            '--keyword=C_:1c,2',
        ],
        { cwd: ROOT, encoding: 'utf8' },
    );
    if (res.error || res.status !== 0) {
        console.error(`check-i18n: xgettext failed — is gettext installed? ${res.error?.message ?? res.stderr}`);
        process.exit(1);
    }
    const fresh = parsePo(readFileSync(join(tmp, 'fresh.pot'), 'utf8'));
    const committed = new Set(parsePo(readFileSync(join(ROOT, 'po', `${DOMAIN}.pot`), 'utf8')).map(key));
    const freshKeys = new Set(fresh.map(key));
    const stale =
        fresh.filter((e) => !committed.has(key(e))).length + [...committed].filter((k) => !freshKeys.has(k)).length;
    if (stale > 0)
        problems.push(`po/${DOMAIN}.pot is stale (${stale} msgid(s) differ) — run \`gjsify run i18n:extract\``);

    const langs = readFileSync(join(ROOT, 'po', 'LINGUAS'), 'utf8')
        .split(/\s+/)
        .filter(Boolean);
    for (const lang of langs) {
        const po = new Map(parsePo(readFileSync(join(ROOT, 'po', `${lang}.po`), 'utf8')).map((e) => [key(e), e]));
        for (const want of fresh) {
            const got = po.get(key(want));
            const where = `${lang}.po: ${show(want)}`;
            if (!got) {
                problems.push(`${where} — missing`);
                continue;
            }
            if (got.flags.includes('fuzzy')) problems.push(`${where} — fuzzy`);
            const forms = want.msgid_plural === undefined ? 1 : 2;
            const strs = got.msgstr.slice(0, Math.max(forms, got.msgstr.length));
            if (strs.length < forms || strs.some((s) => !s)) {
                problems.push(`${where} — untranslated`);
                continue;
            }
            const sources = want.msgid_plural === undefined ? [want.msgid] : [want.msgid, want.msgid_plural];
            const wantNames = names(sources.at(-1));
            for (const s of strs) {
                // A singular form may legitimately omit the count ("One booking"), never add a name.
                const extra = names(s)
                    .split(',')
                    .filter((n) => n && !wantNames.split(',').includes(n));
                if (extra.length > 0) problems.push(`${where} — unknown placeholder {${extra.join('}, {')}}`);
            }
            if (want.msgid_plural === undefined) {
                if (names(strs[0]) !== names(want.msgid)) problems.push(`${where} — placeholders differ`);
                if (percents(strs[0]) !== percents(want.msgid)) problems.push(`${where} — %s count differs`);
            }
        }
    }
} finally {
    rmSync(tmp, { recursive: true, force: true });
}

if (problems.length > 0) {
    console.error(`check-i18n: ${problems.length} problem(s):`);
    for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
    if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
    console.error('An untranslated or fuzzy msgid shows up as English in a German window — silently.');
    process.exit(1);
}
console.log('check-i18n: every msgid is translated in every catalogue.');
