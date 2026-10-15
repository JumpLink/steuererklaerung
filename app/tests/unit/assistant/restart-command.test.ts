/** The restart into demo/own data needs a command line; Windows has no /proc to read it from. */

import { describe, expect, it } from '@gjsify/unit';

import { ownCommandLine } from '../../../src/frontends/desktop/restart.ts';

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
};
