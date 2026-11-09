/**
 * ERiC status cache/probe split: the Konten view needs a fast file-system probe first and a
 * cached native version lookup afterwards. These tests run from a temp directory so they work on
 * every supported platform without a real ERiC installation.
 */

import { describe, expect, it } from '@gjsify/unit';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getEricStatus, invalidateEricStatus, probeEricStatus } from '../../../src/core/actions/elster/eric-status.ts';
import { setConfiguredEricHome } from '../../../../packages/eric/src/paths.ts';
import { ericPlatform, libFileName, BASE_LIBS } from '../../../../packages/eric/src/platform.ts';

function createFakeEricHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'eric-cache-'));
    const p = ericPlatform();
    if (!p) throw new Error(`Unsupported platform ${process.platform}/${process.arch}`);
    const libDir = join(home, p.libDir);
    const pluginsDir = join(libDir, 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    for (const base of BASE_LIBS) {
        writeFileSync(join(libDir, libFileName(p, base)), '');
    }
    writeFileSync(join(pluginsDir, libFileName(p, 'commonData')), '');
    return home;
}

function cleanup(home: string): void {
    try {
        // node:fs rmSync may fail on dangling handles; best-effort.
        const { rmSync } = require('node:fs');
        rmSync(home, { recursive: true, force: true });
    } catch {
        /* ignore */
    }
}

export default async () => {
    await describe('ERiC status probe/cache split', async () => {
        await it('probeEricStatus only checks files, never loads the native binding', async () => {
            const savedEnv = process.env.ERIC_HOME;
            const home = createFakeEricHome();
            try {
                delete process.env.ERIC_HOME;
                setConfiguredEricHome(undefined);
                invalidateEricStatus();
                process.env.ERIC_HOME = home;

                const status = await probeEricStatus();
                expect(status.nativePending).toBe(true);
                expect(status.available).toBe(false);
                expect(status.error).toBeUndefined();
                expect(status.ericHome).toBe(home);
            } finally {
                cleanup(home);
                setConfiguredEricHome(undefined);
                invalidateEricStatus();
                if (savedEnv === undefined) delete process.env.ERIC_HOME;
                else process.env.ERIC_HOME = savedEnv;
            }
        });

        await it('getEricStatus caches the result and skips native init on second call', async () => {
            const savedEnv = process.env.ERIC_HOME;
            const home = createFakeEricHome();
            try {
                delete process.env.ERIC_HOME;
                setConfiguredEricHome(undefined);
                invalidateEricStatus();
                process.env.ERIC_HOME = home;

                const first = await getEricStatus();
                expect(first.available).toBe(false);
                expect(first.error).toBeTruthy();

                const second = await getEricStatus();
                expect(second).toBe(first);
            } finally {
                cleanup(home);
                setConfiguredEricHome(undefined);
                invalidateEricStatus();
                if (savedEnv === undefined) delete process.env.ERIC_HOME;
                else process.env.ERIC_HOME = savedEnv;
            }
        });

        await it('invalidateEricStatus forces a re-probe', async () => {
            const savedEnv = process.env.ERIC_HOME;
            const home = createFakeEricHome();
            try {
                delete process.env.ERIC_HOME;
                setConfiguredEricHome(undefined);
                invalidateEricStatus();
                process.env.ERIC_HOME = home;

                const first = await getEricStatus();
                invalidateEricStatus();
                const second = await getEricStatus();
                expect(second).not.toBe(first);
                expect(second.available).toBe(false);
                expect(second.error).toBeTruthy();
            } finally {
                cleanup(home);
                setConfiguredEricHome(undefined);
                invalidateEricStatus();
                if (savedEnv === undefined) delete process.env.ERIC_HOME;
                else process.env.ERIC_HOME = savedEnv;
            }
        });

        await it('probeEricStatus does not populate the cache used by getEricStatus', async () => {
            const savedEnv = process.env.ERIC_HOME;
            const home = createFakeEricHome();
            try {
                delete process.env.ERIC_HOME;
                setConfiguredEricHome(undefined);
                invalidateEricStatus();
                process.env.ERIC_HOME = home;

                const probe = await probeEricStatus();
                expect(probe.nativePending).toBe(true);

                const full = await getEricStatus();
                expect(full.nativePending).toBe(false);
                expect(full).not.toBe(probe);
            } finally {
                cleanup(home);
                setConfiguredEricHome(undefined);
                invalidateEricStatus();
                if (savedEnv === undefined) delete process.env.ERIC_HOME;
                else process.env.ERIC_HOME = savedEnv;
            }
        });

        await it('emits no timing output when STEUER_DEBUG_TIMING is unset', async () => {
            const savedTiming = process.env.STEUER_DEBUG_TIMING;
            const savedEnv = process.env.ERIC_HOME;
            const home = createFakeEricHome();
            const originalWrite = process.stderr.write.bind(process.stderr);
            const captured: string[] = [];
            process.stderr.write = (chunk: string | Uint8Array) => {
                captured.push(String(chunk));
                return true;
            };
            try {
                delete process.env.STEUER_DEBUG_TIMING;
                delete process.env.ERIC_HOME;
                setConfiguredEricHome(undefined);
                invalidateEricStatus();
                process.env.ERIC_HOME = home;

                await getEricStatus();

                expect(captured.some((line) => line.includes('[timing]'))).toBe(false);
            } finally {
                process.stderr.write = originalWrite;
                cleanup(home);
                setConfiguredEricHome(undefined);
                invalidateEricStatus();
                if (savedTiming === undefined) delete process.env.STEUER_DEBUG_TIMING;
                else process.env.STEUER_DEBUG_TIMING = savedTiming;
                if (savedEnv === undefined) delete process.env.ERIC_HOME;
                else process.env.ERIC_HOME = savedEnv;
            }
        });
    });
};
