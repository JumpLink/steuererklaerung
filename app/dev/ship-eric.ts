// CI only: add a staged, slim ERiC runtime to the ship payload.
//
//   node dev/ship-eric.ts <staging-dir> <Platform-id>
//
// `gjsify.ship.extraFiles` lists single files and a missing source fails the build, so the entries
// cannot live in the committed package.json — builds without ERiC (forks, outside PRs) must stay
// green. This patches package.json in the CI workspace, and only when ERiC was fetched.
//
// ERIC_HERSTELLER_ID (CI secret, optional) is written to <staging>/hersteller-id.
//
// Layout in the payload: lib/steuererklaerung/eric/<Platform-id>/<relative path>, which is where
// packages/eric/src/paths.ts (bundledEricHome) looks.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ERIC_PLATFORM_IDS, type EricPlatformId } from '../../packages/eric/src/platform.ts';

const [staging, id, arch] = process.argv.slice(2);
if (!staging || !ERIC_PLATFORM_IDS.includes(id as EricPlatformId)) {
    console.error(`usage: ship-eric.ts <staging-dir> <${ERIC_PLATFORM_IDS.join('|')}> [x64|arm64]`);
    process.exit(2);
}

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

const root = resolve(staging);
// The Hersteller-ID of official builds comes from a CI secret only, as a file next to the runtime
// (paths.ts: bundledHerstellerId). Never echoed.
if (process.env.ERIC_HERSTELLER_ID?.trim()) {
    writeFileSync(join(root, 'hersteller-id'), `${process.env.ERIC_HERSTELLER_ID.trim()}\n`);
}
const pkgPath = new URL('../package.json', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const ship = (pkg.gjsify.ship ??= {});
const extra: Record<string, string> = (ship.extraFiles ??= {});
const files = walk(root);
if (files.length === 0) {
    console.error(`${staging} is empty — nothing to ship`);
    process.exit(1);
}
for (const file of files) {
    const rel = relative(root, file).split('\\').join('/');
    // Source paths are relative to app/; the staging dir lives under it.
    extra[`lib/steuererklaerung/eric/${id}/${rel}`] = relative(resolve(pkgPath, '..'), file).split('\\').join('/');
}
// koffi (the ERiC FFI on Windows/macOS) is `--external` in the bundle and `gjsify ship` stages only
// @gjsify/node-gi, so without this the zip/msi/app has no koffi and every ERiC call fails. koffi's
// index.cjs finds its native package at ../../../@koromix/koffi-<os>-<arch> from src/koffi/, which
// is the layout below. Linux uses the Vala binding instead.
const koffiOs = id === 'Windows-x86_64' ? 'win32' : id === 'Darwin-universal' ? 'darwin' : undefined;
if (koffiOs) {
    const appDir = resolve(pkgPath, '..');
    let modules: string | undefined;
    for (let dir = appDir; ; dir = resolve(dir, '..')) {
        if (existsSync(join(dir, 'node_modules', 'koffi', 'package.json'))) {
            modules = join(dir, 'node_modules');
            break;
        }
        if (resolve(dir, '..') === dir) break;
    }
    if (!modules) {
        console.error('koffi is not installed — run `gjsify install` first');
        process.exit(1);
    }
    const natives = existsSync(join(modules, '@koromix'))
        ? readdirSync(join(modules, '@koromix')).filter((n) => n.startsWith(`koffi-${koffiOs}-${arch ?? ''}`))
        : [];
    if (natives.length === 0) {
        console.error(`no @koromix/koffi-${koffiOs}-${arch ?? '*'} installed — install with --os ${koffiOs}`);
        process.exit(1);
    }
    // Runtime files only: the JS entry points and the prebuilt binaries, not docs/vendor/sources.
    const keep = (path: string) => /(^|\/)(package\.json|index\.(c?js)|indirect\.(c?js)|koffi\.node)$/.test(path);
    const stage = (pkgName: string) => {
        const base = join(modules, pkgName);
        for (const file of walk(base)) {
            const rel = relative(base, file).split('\\').join('/');
            if (!keep(rel) || rel.startsWith('doc/') || rel.startsWith('vendor/')) continue;
            extra[`lib/steuererklaerung/node_modules/${pkgName}/${rel}`] = relative(appDir, file).split('\\').join('/');
        }
    };
    stage('koffi');
    for (const n of natives) stage(`@koromix/${n}`);
    console.log(`shipping koffi + ${natives.join(', ')}`);
}
if (id === 'Linux-x86_64') {
    const typelibs = ((ship.bundledTypelibs ??= {}).linux ??= []);
    const prebuild = '../packages/eric/prebuilds/linux-x86_64';
    if (!typelibs.includes(prebuild)) typelibs.push(prebuild);
}
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 4)}\n`);
console.log(`shipping ${files.length} ERiC files for ${id}`);
