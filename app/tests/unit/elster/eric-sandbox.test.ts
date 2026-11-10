/**
 * What of the Flatpak sandbox checklist (#172) can be proven without a sandbox: where each source
 * of a user-provided ERiC resolves to, where the data directory lands under the sandbox's
 * XDG_DATA_HOME, where ERiC's logs go when the install sits in a folder that cannot take new
 * entries (the document portal), and that "no ERiC" degrades instead of throwing. What needs the
 * real sandbox (dlopen through a portal path) is listed in docs/agents/eric.md.
 */

import { describe, expect, it } from '@gjsify/unit';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    appDataDir,
    ERIC_NOT_FOUND_MESSAGE,
    ericDataDir,
    getEricPaths,
    isEricAvailable,
    setConfiguredEricHome,
} from '../../../../packages/eric/src/paths.ts';
import { BASE_LIBS, ericPlatform, libFileName } from '../../../../packages/eric/src/platform.ts';
import { getEricStatus, invalidateEricStatus } from '../../../src/core/actions/elster/eric-status.ts';

const SANDBOX_DATA = '/home/u/.var/app/eu.jumplink.Steuererklaerung/data';
const PORTAL_DIR = '/run/user/1000/doc/ab12cd34/eric';

/** Run `fn` with the ERiC-relevant environment replaced, then put it back. */
async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
    const keys = ['ERIC_HOME', 'XDG_DATA_HOME', 'HOME'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
        for (const k of keys) delete process.env[k];
        for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
        setConfiguredEricHome(undefined);
        invalidateEricStatus();
        await fn();
    } finally {
        for (const k of keys) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        setConfiguredEricHome(undefined);
        invalidateEricStatus();
    }
}

export default async () => {
    await describe('ERiC in the Flatpak sandbox (#172)', async () => {
        await it('keeps the per-user data directory under the sandbox XDG_DATA_HOME', async () => {
            await withEnv({ XDG_DATA_HOME: SANDBOX_DATA, HOME: '/home/u' }, () => {
                expect(appDataDir('linux')).toBe(`${SANDBOX_DATA}/steuererklaerung`);
                expect(ericDataDir('linux')).toBe(`${SANDBOX_DATA}/steuererklaerung/eric`);
            });
        });

        await it("reports a document-portal folder as the person's own folder and as ERIC_HOME", async () => {
            await withEnv({ XDG_DATA_HOME: SANDBOX_DATA, HOME: '/home/u' }, () => {
                setConfiguredEricHome(PORTAL_DIR);
                const p = ericPlatform();
                const paths = getEricPaths(p);
                expect(paths.source).toBe('config');
                expect(paths.home).toBe(PORTAL_DIR);
                expect(paths.lib).toBe(join(PORTAL_DIR, p?.libDir ?? 'lib'));
                setConfiguredEricHome(undefined);
                process.env.ERIC_HOME = '/home/u/eric';
                expect(getEricPaths(p).source).toBe('env');
            });
        });

        await it("writes ERiC logs to the data directory when the install's parent is read-only", async () => {
            const root = mkdtempSync(join(tmpdir(), 'eric-ro-'));
            try {
                const parent = join(root, 'doc');
                mkdirSync(join(parent, 'eric'), { recursive: true });
                const data = join(root, 'data');
                await withEnv({ XDG_DATA_HOME: data, HOME: root }, () => {
                    setConfiguredEricHome(join(parent, 'eric'));
                    expect(getEricPaths().logs).toBe(join(parent, 'logs'));
                    chmodSync(parent, 0o555);
                    // root ignores the permission bits; the assertion only holds for a normal user
                    if (process.getuid?.() !== 0) {
                        expect(getEricPaths().logs).toBe(join(data, 'steuererklaerung', 'logs'));
                    }
                });
            } finally {
                try {
                    chmodSync(join(root, 'doc'), 0o755);
                } catch {
                    /* already gone */
                }
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('finds an ERiC the person placed in the data directory', async () => {
            const root = mkdtempSync(join(tmpdir(), 'eric-data-'));
            try {
                const p = ericPlatform();
                if (!p) return;
                await withEnv({ XDG_DATA_HOME: root, HOME: root }, () => {
                    const home = ericDataDir();
                    mkdirSync(join(home, p.libDir, 'plugins'), { recursive: true });
                    for (const b of BASE_LIBS) writeFileSync(join(home, p.libDir, libFileName(p, b)), '');
                    writeFileSync(join(home, p.libDir, 'plugins', libFileName(p, 'commonData')), '');
                    const paths = getEricPaths(p);
                    expect(paths.source === 'data' || paths.source === 'project').toBe(true);
                    if (paths.source === 'data') expect(isEricAvailable()).toBe(true);
                });
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('says "not available" without any ERiC and does not throw', async () => {
            const root = mkdtempSync(join(tmpdir(), 'eric-none-'));
            try {
                await withEnv({ XDG_DATA_HOME: root, HOME: root }, async () => {
                    setConfiguredEricHome(join(root, 'nothing-here'));
                    expect(isEricAvailable()).toBe(false);
                    const status = await getEricStatus();
                    expect(status.available).toBe(false);
                    expect(status.source).toBe('config');
                    expect(ERIC_NOT_FOUND_MESSAGE.includes('XML')).toBe(true);
                });
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });
    });
};
