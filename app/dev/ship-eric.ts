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
// koffi, the FFI that loads ERiC on Windows/macOS, is staged by ship-koffi.ts for every build.
//
// Layout in the payload: lib/steuererklaerung/eric/<Platform-id>/<relative path>, which is where
// packages/eric/src/paths.ts (bundledEricHome) looks.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ERIC_PLATFORM_IDS, type EricPlatformId } from '../../packages/eric/src/platform.ts';

const [staging, id] = process.argv.slice(2);
if (!staging || !ERIC_PLATFORM_IDS.includes(id as EricPlatformId)) {
    console.error(`usage: ship-eric.ts <staging-dir> <${ERIC_PLATFORM_IDS.join('|')}>`);
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
if (id === 'Linux-x86_64') {
    const typelibs = ((ship.bundledTypelibs ??= {}).linux ??= []);
    const prebuild = '../packages/eric/prebuilds/linux-x86_64';
    if (!typelibs.includes(prebuild)) typelibs.push(prebuild);
}
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 4)}\n`);
console.log(`shipping ${files.length} ERiC files for ${id}`);
