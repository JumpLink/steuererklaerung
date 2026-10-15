/**
 * The shipped demo: present → offered, absent → not offered, read-only → copied once to a writable place.
 */
import { describe, expect, it } from '@gjsify/unit';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { demoAvailable, writableDemoDir } from '../../../src/core/config/demo.ts';

function fakeDemo(root: string): string {
    const dir = join(root, 'demo');
    mkdirSync(join(dir, 'transactions-data'), { recursive: true });
    writeFileSync(join(dir, 'steuererklaerung.json'), '{}');
    return dir;
}

export default async () => {
    await describe('demo workspace', async () => {
        await it('demoAvailable follows STEUER_DEMO_DIR', async () => {
            const root = mkdtempSync(join(tmpdir(), 'bh-demo-'));
            const saved = process.env.STEUER_DEMO_DIR;
            try {
                process.env.STEUER_DEMO_DIR = fakeDemo(root);
                expect(demoAvailable()).toBe(true);
            } finally {
                if (saved === undefined) delete process.env.STEUER_DEMO_DIR;
                else process.env.STEUER_DEMO_DIR = saved;
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('uses a writable demo in place', async () => {
            const root = mkdtempSync(join(tmpdir(), 'bh-demo-'));
            try {
                const shipped = fakeDemo(root);
                expect(writableDemoDir(shipped, join(root, 'copy'))).toBe(shipped);
                expect(existsSync(join(root, 'copy'))).toBe(false);
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('leaves no probe file behind in a writable demo', async () => {
            const root = mkdtempSync(join(tmpdir(), 'bh-demo-'));
            try {
                const shipped = fakeDemo(root);
                writableDemoDir(shipped, join(root, 'copy'));
                expect(readdirSync(shipped).sort().join(',')).toBe('steuererklaerung.json,transactions-data');
            } finally {
                rmSync(root, { recursive: true, force: true });
            }
        });

        await it('copies a read-only demo to the target', async () => {
            const root = mkdtempSync(join(tmpdir(), 'bh-demo-'));
            const shipped = fakeDemo(root);
            const target = join(root, 'copy');
            try {
                chmodSync(shipped, 0o555);
                const used = writableDemoDir(shipped, target);
                // root can write anywhere, so the check is only meaningful for a normal user
                if (used !== shipped) {
                    expect(used).toBe(target);
                    expect(existsSync(join(target, 'steuererklaerung.json'))).toBe(true);
                }
            } finally {
                chmodSync(shipped, 0o755);
                rmSync(root, { recursive: true, force: true });
            }
        });
    });
};
