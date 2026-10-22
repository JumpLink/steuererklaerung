/** The restart into demo/own data needs a command line; Windows has no /proc to read it from. */

import { describe, expect, it } from '@gjsify/unit';

import { ownCommandLine, relaunchesThroughNode } from '../../../src/frontends/desktop/restart.ts';

export default async () => {
    await describe('ownCommandLine on Windows', async () => {
        const execPath = 'C:\\Apps\\Steuer\\node.exe';
        const argv = [execPath, 'C:\\Apps\\Steuer\\app\\steuer-app.node.mjs', '--demo'];

        await it('is the launcher next to node.exe plus the user arguments', async () => {
            const cmd = ownCommandLine('win32', execPath, argv, () => true);
            expect(cmd?.length).toBe(2);
            expect(cmd?.[0].endsWith('steuererklaerung.exe')).toBe(true);
            expect(cmd?.[1]).toBe('--demo');
        });

        await it('is undefined when there is no launcher, so the app asks for a manual restart', async () => {
            expect(ownCommandLine('win32', execPath, argv, () => false)).toBe(undefined);
        });
    });

    // Measured in the macOS `.app`: no /proc, so the welcome's "demo" choice only showed "restart
    // yourself" — and a manual restart opened own data again, because nothing was remembered.
    await describe('ownCommandLine on macOS', async () => {
        const execPath = '/Applications/Steuer.app/Contents/MacOS/node';
        const argv = [execPath, '/Applications/Steuer.app/Contents/Resources/lib/steuer-app.node.mjs', '--demo'];

        await it('is node plus the bundle and the user arguments under node', async () => {
            expect(ownCommandLine('darwin', execPath, argv, () => false, false)).toStrictEqual(argv);
        });

        await it('is undefined under GJS, so the app asks for a manual restart', async () => {
            expect(ownCommandLine('darwin', execPath, argv, () => false, true)).toBe(undefined);
        });

        await it('relaunches through node, never through the SIP-protected /bin/sh', async () => {
            expect(relaunchesThroughNode('darwin', false)).toBe(true);
            expect(relaunchesThroughNode('linux', false)).toBe(false);
            expect(relaunchesThroughNode('win32', false)).toBe(true);
        });
    });
};
