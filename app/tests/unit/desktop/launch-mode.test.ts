/**
 * What the packaged binary does with its arguments. A package ships one executable, so this one
 * decision is the difference between `steuererklaerung --help` printing the command table and it
 * opening a window that prints nothing (issue #133).
 */

import { describe, expect, it } from '@gjsify/unit';

import { BACKUP_CHILD_ARG, guiArgv, launchMode } from '../../../src/frontends/desktop/launch-mode.ts';

export default async () => {
    await describe('launchMode', async () => {
        await it('opens the window when there is no command', async () => {
            expect(launchMode([])).toBe('gui');
        });

        await it('opens the window for flags the window itself handles', async () => {
            expect(launchMode(['--demo'])).toBe('gui');
        });

        await it('runs the CLI for --help and --version', async () => {
            expect(launchMode(['--help'])).toBe('cli');
            expect(launchMode(['--version'])).toBe('cli');
        });

        await it('runs the CLI for a command', async () => {
            expect(launchMode(['elster', 'plan', '2025'])).toBe('cli');
            expect(launchMode(['config', 'show'])).toBe('cli');
        });

        await it('runs the CLI for a command carrying --demo', async () => {
            expect(launchMode(['--demo', 'buchungen', 'list'])).toBe('cli');
        });

        await it('runs the CLI for an unknown command, so yargs can reject it', async () => {
            // Falling back to the window here is exactly the bug: no output, no exit code, a
            // hanging GLib loop. The CLI's .strictCommands() prints a hint and exits 1.
            expect(launchMode(['nonsense'])).toBe('cli');
        });

        await it('keeps the MCP server on its own path', async () => {
            expect(launchMode(['mcp'])).toBe('mcp');
        });

        await it('reaches the real backup command, not the child protocol', async () => {
            // `backup` used to be the child protocol, so `backup list` *wrote* a backup labelled
            // "list". The child now has a name no command can collide with.
            expect(launchMode(['backup', 'list'])).toBe('cli');
            expect(launchMode(['backup', 'create'])).toBe('cli');
            expect(launchMode([BACKUP_CHILD_ARG, 'manual'])).toBe('backup-child');
        });
    });

    await describe('guiArgv', async () => {
        await it("drops the window's own flags, which GApplication would reject", async () => {
            // `--demo` reached g_application_run and killed the launch with "Unbekannte Option
            // --demo"; by then applyDemoEnv() has long since set STEUER_DEMO=1.
            expect(guiArgv(['--demo'])).toEqualArray([]);
        });

        await it('leaves everything else untouched', async () => {
            expect(guiArgv([])).toEqualArray([]);
            expect(guiArgv(['--gdk-debug=all'])).toEqualArray(['--gdk-debug=all']);
        });
    });
};
