/**
 * `selfCommand` starts a copy of the app for a backup. The Windows and macOS packages run under
 * node, which takes the bundle as a plain script path — gjs's `-m` flag would make node fail.
 */

import { describe, expect, it } from '@gjsify/unit';

import { bundlePath, selfCommand } from '../../../src/frontends/desktop/self-launch.ts';

export default async () => {
    await describe('selfCommand', async () => {
        await it('runs the bundle with node itself, without gjs flags', async () => {
            expect(JSON.stringify(selfCommand(['backup', 'exit'], false))).toBe(
                JSON.stringify([process.execPath, bundlePath(), 'backup', 'exit']),
            );
        });

        await it('passes the module flag under gjs', async () => {
            const [, flag, bundle, ...args] = selfCommand(['backup', 'exit'], true);
            expect(flag).toBe('-m');
            expect(bundle).toBe(bundlePath());
            expect(args.join(' ')).toBe('backup exit');
        });
    });
};
