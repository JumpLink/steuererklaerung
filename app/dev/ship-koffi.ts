// CI only: add koffi, the ERiC FFI on Windows/macOS, to the ship payload.
//
//   node dev/ship-koffi.ts <win32|darwin> <x64|arm64>
//
// koffi is `--external` in the node bundle and `gjsify ship` stages only @gjsify/node-gi, so without
// this the zip/msi/app has no koffi and every ERiC call fails, including a user-supplied ERiC
// (ERIC_HOME). It therefore runs for EVERY Windows/macOS package, whether ERiC is bundled or not.
// Patches package.json in the CI workspace (`extraFiles` lists single files); see with-koffi.sh.
//
// koffi's index.cjs finds its native package at ../../../@koromix/koffi-<os>-<arch> from
// src/koffi/, which is the layout below. Linux uses the Vala binding instead.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const [os, arch] = process.argv.slice(2);
if ((os !== 'win32' && os !== 'darwin') || (arch !== 'x64' && arch !== 'arm64')) {
    console.error('usage: ship-koffi.ts <win32|darwin> <x64|arm64>');
    process.exit(2);
}

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

const pkgPath = new URL('../package.json', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const extra: Record<string, string> = ((pkg.gjsify.ship ??= {}).extraFiles ??= {});
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
    ? readdirSync(join(modules, '@koromix')).filter((n) => n.startsWith(`koffi-${os}-${arch}`))
    : [];
if (natives.length === 0) {
    console.error(`no @koromix/koffi-${os}-${arch} installed — install with --os ${os} --cpu ${arch}`);
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
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 4)}\n`);
console.log(`shipping koffi + ${natives.join(', ')}`);
