// Cut the official ERiC JAR down to the slim runtime the app bundles and pack it as a tar.gz.
//
//   node dev/eric-slim.ts <ERiC-…-<platform>.jar> <Platform-id> <outdir>
//
// Output: <outdir>/eric-<version>-<Platform-id>.tar.gz. The archive is for the PRIVATE release
// repo only — ERiC never enters this repository (see packages/eric/AGENTS.md).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ERIC_PLATFORM_IDS, platformById, type EricPlatformId } from '../../packages/eric/src/platform.ts';
import { extractJar } from '../../packages/eric/src/setup.ts';

const [jar, id, outDir] = process.argv.slice(2);
if (!jar || !outDir || !ERIC_PLATFORM_IDS.includes(id as EricPlatformId)) {
    console.error(`usage: eric-slim.ts <jar> <${ERIC_PLATFORM_IDS.join('|')}> <outdir>`);
    process.exit(2);
}
const version = /ERiC-([\d.]+)-/.exec(basename(jar))?.[1];
if (!version) {
    console.error(`cannot read the version from ${basename(jar)}`);
    process.exit(2);
}
const stage = mkdtempSync(join(tmpdir(), 'eric-slim-'));
try {
    const files = extractJar(jar, platformById(id as EricPlatformId), stage);
    const archive = resolve(outDir, `eric-${version}-${id}.tar.gz`);
    const tar = spawnSync('tar', ['-czf', archive, '-C', stage, '.'], { stdio: 'inherit' });
    if (tar.status !== 0) process.exit(tar.status ?? 1);
    console.log(`${archive}: ${files.length} files`);
} finally {
    rmSync(stage, { recursive: true, force: true });
}
