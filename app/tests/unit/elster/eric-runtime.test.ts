/**
 * The platform table, the slim-runtime filter, the load preparation and the pure-JS JAR extraction
 * behind `steuererklaerung elster setup` and the bundled ERiC. Everything runs against fixtures in
 * a temp directory, so every platform branch is checked from any host.
 */

import { describe, expect, it } from '@gjsify/unit';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import {
    bundledEricHome,
    bundledHerstellerId,
    resolveEricHomeWithSource,
    setConfiguredEricHome,
} from '../../../../packages/eric/src/paths.ts';
import {
    ericPlatform,
    isNeededPlugin,
    libFileName,
    platformById,
    slimTarget,
} from '../../../../packages/eric/src/platform.ts';
import { clearQuarantine, prepareLoad, prependToPath } from '../../../../packages/eric/src/runtime-env.ts';
import { extractJar } from '../../../../packages/eric/src/setup.ts';

/** A ZIP with the given entries; `deflate` picks the entries stored compressed. */
function buildZip(files: Record<string, string>, deflate = new Set<string>()): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
        const raw = Buffer.from(text);
        const method = deflate.has(name) ? 8 : 0;
        const data = method === 8 ? deflateRawSync(raw) : raw;
        const nameBuf = Buffer.from(name);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(method, 8);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBuf, data);
        centrals.push(central, nameBuf);
        offset += local.length + nameBuf.length + data.length;
    }
    const centralBuf = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, centralBuf, end]);
}

export default async () => {
    await describe('ERiC platform table', async () => {
        await it('maps Node platforms to the ERiC distributions', async () => {
            expect(ericPlatform('linux', 'x64')?.id).toBe('Linux-x86_64');
            expect(ericPlatform('win32', 'x64')?.id).toBe('Windows-x86_64');
            expect(ericPlatform('darwin', 'arm64')?.id).toBe('Darwin-universal');
            expect(ericPlatform('darwin', 'x64')?.id).toBe('Darwin-universal');
            expect(ericPlatform('linux', 'arm64')).toBe(null);
        });

        await it('names libraries the way each platform does', async () => {
            expect(libFileName(platformById('Linux-x86_64'), 'ericapi')).toBe('libericapi.so');
            expect(libFileName(platformById('Windows-x86_64'), 'ericapi')).toBe('ericapi.dll');
            expect(libFileName(platformById('Darwin-universal'), 'ericapi')).toBe('libericapi.dylib');
            expect(platformById('Windows-x86_64').libDir).toBe('dll');
        });

        await it('matches the JAR file names of each platform', async () => {
            expect(platformById('Linux-x86_64').jarPattern.test('ERiC-44.3.6.0-Linux-x86_64.jar')).toBe(true);
            expect(platformById('Linux-x86_64').jarPattern.test('ERiC-44.3.6.0-Windows-x86_64.jar')).toBe(false);
        });
    });

    await describe('slim runtime selection', async () => {
        await it('keeps commonData, the Kontoabfrage and the tax-year plugins from 2024 on', async () => {
            expect(isNeededPlugin('commonData')).toBe(true);
            expect(isNeededPlugin('checkElsterKontoabfrage_6')).toBe(true);
            expect(isNeededPlugin('checkUStVA_2026')).toBe(true);
            expect(isNeededPlugin('checkEUER_2024')).toBe(true);
            expect(isNeededPlugin('checkFEIN_90_2025')).toBe(true);
        });

        await it('drops older years and procedures the app never sends', async () => {
            expect(isNeededPlugin('checkUStVA_2023')).toBe(false);
            expect(isNeededPlugin('checkGewStZ_2025')).toBe(false);
            expect(isNeededPlugin('checkFEIN_95_2025')).toBe(false);
            expect(isNeededPlugin('checkLohn_2025')).toBe(false);
        });

        await it('picks files by their platform layout', async () => {
            const linux = platformById('Linux-x86_64');
            const win = platformById('Windows-x86_64');
            expect(slimTarget(linux, 'lib/libericapi.so')).toBe('lib/libericapi.so');
            expect(slimTarget(linux, 'lib/libcheckUStVA_2025.so')).toBe(null);
            expect(slimTarget(linux, 'lib/plugins/libcheckUStVA_2025.so')).toBe('lib/plugins/libcheckUStVA_2025.so');
            expect(slimTarget(linux, 'lib/plugins/libcheckLohn_2025.so')).toBe(null);
            expect(slimTarget(linux, 'include/eric_api.h')).toBe(null);
            expect(slimTarget(linux, 'lizenz.pdf')).toBe('lizenz.pdf');
            expect(slimTarget(win, 'dll/ericapi.dll')).toBe('dll/ericapi.dll');
            expect(slimTarget(win, 'dll/plugins/commonData.dll')).toBe('dll/plugins/commonData.dll');
            expect(slimTarget(win, 'lib/ericapi.dll')).toBe(null);
        });
    });

    await describe('load preparation', async () => {
        await it('prepends to PATH reusing the existing spelling and without duplicates', async () => {
            const env: Record<string, string | undefined> = { Path: '/windows' };
            expect(prependToPath(env, '/eric')).toBe('Path');
            expect(env.Path).toBe(`/eric${delimiter}/windows`);
            prependToPath(env, '/eric');
            expect(env.Path?.split(delimiter).filter((p) => p === '/eric').length).toBe(1);
            expect(env.PATH).toBe(undefined);
        });

        await it('touches PATH only for Windows and clears quarantine only on macOS', async () => {
            const env: Record<string, string | undefined> = { PATH: '/usr/bin' };
            prepareLoad('/x', '/x/lib', platformById('Linux-x86_64'), env);
            expect(env.PATH).toBe('/usr/bin');
            let ran: string[] = [];
            clearQuarantine('/tmp/eric-q-test', (cmd, args) => {
                ran = [cmd, ...args];
            });
            expect(ran[0]).toBe('xattr');
            expect(ran.includes('com.apple.quarantine')).toBe(true);
        });

        await it('survives a failing xattr', async () => {
            clearQuarantine('/tmp/eric-q-fail', () => {
                throw new Error('read-only');
            });
            expect(true).toBe(true);
        });
    });

    await describe('bundled ERiC lookup', async () => {
        await it('finds eric/<platform> above the bundle and ignores a directory without the library', async () => {
            const root = mkdtempSync(join(tmpdir(), 'eric-bundled-'));
            try {
                const p = platformById('Linux-x86_64');
                const bundle = join(root, 'lib', 'steuererklaerung');
                mkdirSync(bundle, { recursive: true });
                expect(bundledEricHome(p, bundle)).toBe(null);
                const home = join(bundle, 'eric', p.id);
                mkdirSync(join(home, 'lib'), { recursive: true });
                expect(bundledEricHome(p, bundle)).toBe(null);
                writeFileSync(join(home, 'lib', 'libericapi.so'), '');
                expect(bundledEricHome(p, bundle)).toBe(home);
                expect(bundledEricHome(p, join(bundle, 'gi'))).toBe(home);
                expect(bundledEricHome(null, bundle)).toBe(null);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('looks for the library name of the platform', async () => {
            const root = mkdtempSync(join(tmpdir(), 'eric-bundled-win-'));
            try {
                const p = platformById('Windows-x86_64');
                mkdirSync(join(root, 'eric', p.id, 'dll'), { recursive: true });
                writeFileSync(join(root, 'eric', p.id, 'dll', 'ericapi.dll'), '');
                expect(bundledEricHome(p, root)).toBe(join(root, 'eric', p.id));
                expect(bundledEricHome(platformById('Linux-x86_64'), root)).toBe(null);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    });

    await describe('ERiC home precedence', async () => {
        await it('ranks own folder, ERIC_HOME, bundled, project, user installation', async () => {
            const root = mkdtempSync(join(tmpdir(), 'eric-prec-'));
            const saved = process.env.ERIC_HOME;
            try {
                mkdirSync(join(root, 'elster', 'runtime'), { recursive: true });
                const probe = { bundled: '/bundled', cwd: root };
                delete process.env.ERIC_HOME;
                setConfiguredEricHome(undefined);
                expect(resolveEricHomeWithSource(undefined, probe).source).toBe('bundled');
                expect(resolveEricHomeWithSource(undefined, { ...probe, bundled: null }).source).toBe('project');
                expect(resolveEricHomeWithSource(undefined, { bundled: null, cwd: join(root, 'x') }).source).toBe(
                    'data',
                );
                process.env.ERIC_HOME = '/from-env';
                expect(resolveEricHomeWithSource(undefined, probe)).toStrictEqual({ home: '/from-env', source: 'env' });
                setConfiguredEricHome(' /own ');
                expect(resolveEricHomeWithSource(undefined, probe)).toStrictEqual({ home: '/own', source: 'config' });
                setConfiguredEricHome('');
                expect(resolveEricHomeWithSource(undefined, probe).source).toBe('env');
            } finally {
                setConfiguredEricHome(undefined);
                if (saved === undefined) delete process.env.ERIC_HOME;
                else process.env.ERIC_HOME = saved;
                rmSync(root, { recursive: true, force: true });
            }
        });
    });

    await describe('bundled Hersteller-ID', async () => {
        await it('reads the id the release pipeline wrote next to the runtime', async () => {
            const root = mkdtempSync(join(tmpdir(), 'eric-hid-'));
            try {
                const p = platformById('Linux-x86_64');
                const home = join(root, 'eric', p.id);
                mkdirSync(join(home, 'lib'), { recursive: true });
                writeFileSync(join(home, 'lib', 'libericapi.so'), '');
                expect(bundledHerstellerId(p, root)).toBe(undefined);
                writeFileSync(join(home, 'hersteller-id'), '12345\n');
                expect(bundledHerstellerId(p, root)).toBe('12345');
                writeFileSync(join(home, 'hersteller-id'), '\n');
                expect(bundledHerstellerId(p, root)).toBe(undefined);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    });

    await describe('JAR extraction', async () => {
        await it('unpacks only the slim runtime of the requested platform', async () => {
            const root = mkdtempSync(join(tmpdir(), 'eric-zip-'));
            try {
                const jar = join(root, 'ERiC-44.3.6.0-Windows-x86_64.jar');
                writeFileSync(
                    jar,
                    buildZip(
                        {
                            'ERiC-44.3.6.0/Windows-x86_64/dll/ericapi.dll': 'API',
                            'ERiC-44.3.6.0/Windows-x86_64/dll/plugins/commonData.dll': 'COMMON'.repeat(50),
                            'ERiC-44.3.6.0/Windows-x86_64/dll/plugins/checkLohn_2025.dll': 'LOHN',
                            'ERiC-44.3.6.0/Windows-x86_64/lizenz.pdf': 'PDF',
                            'ERiC-44.3.6.0/Linux-x86_64/lib/libericapi.so': 'LINUX',
                            'ERiC-44.3.6.0/Windows-x86_64/dll/': '',
                        },
                        new Set(['ERiC-44.3.6.0/Windows-x86_64/dll/plugins/commonData.dll']),
                    ),
                );
                const dest = join(root, 'out');
                const written = extractJar(jar, platformById('Windows-x86_64'), dest);
                expect(written.sort().join(',')).toBe('dll/ericapi.dll,dll/plugins/commonData.dll,lizenz.pdf');
                expect(readFileSync(join(dest, 'dll', 'ericapi.dll'), 'utf8')).toBe('API');
                expect(readFileSync(join(dest, 'dll', 'plugins', 'commonData.dll'), 'utf8')).toBe('COMMON'.repeat(50));
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('says so when the JAR holds another platform', async () => {
            const root = mkdtempSync(join(tmpdir(), 'eric-zip-wrong-'));
            try {
                const jar = join(root, 'a.jar');
                writeFileSync(jar, buildZip({ 'ERiC-44.3.6.0/Linux-x86_64/lib/libericapi.so': 'X' }));
                let message = '';
                try {
                    extractJar(jar, platformById('Darwin-universal'), join(root, 'out'));
                } catch (e) {
                    message = (e as Error).message;
                }
                expect(message.includes('Darwin-universal')).toBe(true);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    });
};
