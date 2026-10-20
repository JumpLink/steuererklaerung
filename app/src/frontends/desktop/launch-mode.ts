/**
 * What an invocation of the packaged binary is asking for.
 *
 * A package ships ONE executable: the window, the CLI and the MCP server are all
 * `steuererklaerung`. On Linux that was easy to miss, because a dev checkout also builds the
 * separate `dist/steuer.gjs.mjs` CLI bundle — so the desktop entry only ever special-cased `mcp`
 * and the backup child, and every other argument fell through to `runAdwaitaApp()`. In a macOS
 * .app, a Windows exe or a Flatpak there is nothing else to run: `steuererklaerung --help` opened
 * a window, printed nothing and hung on the GLib loop (issue #133).
 *
 * Hence the default here is the CLI, not the window. The window is what you get when there is no
 * command at all — which is also what a double-click, a .desktop file and the GNOME overview pass.
 *
 * No imports on purpose: this decides the mode before GTK, the store or a config is touched, and
 * it stays testable on Node without a display.
 */

/**
 * Flags the window understands itself. They must not pull a bare launch into the CLI, which
 * demands a command and would reject them.
 */
const GUI_FLAGS = new Set(['--demo']);

/**
 * argv[2] of the child the window spawns for "Back up now" (background-backup.ts).
 *
 * Deliberately NOT a command name. While this was the plain word `backup`, it shadowed the real
 * `backup` command for the packaged app: `steuererklaerung backup list` took the child protocol
 * and *wrote* a backup labelled "list" instead of listing anything.
 */
export const BACKUP_CHILD_ARG = '--internal-backup';

export type LaunchMode = 'gui' | 'cli' | 'mcp' | 'backup-child';

/** What `args` — `process.argv` without interpreter and bundle — asks this binary to be. */
export function launchMode(args: string[]): LaunchMode {
    if (args[0] === BACKUP_CHILD_ARG) return 'backup-child';
    // `mcp` keeps its own path in the desktop entry: no yargs, no demo seeding, and stdout is the
    // protocol. It is what every snippet in "Connect an external agent" hands out.
    if (args[0] === 'mcp') return 'mcp';
    if (args.every((a) => GUI_FLAGS.has(a))) return 'gui';
    return 'cli';
}

/**
 * The command line for `Gio.Application.run()` — the window's own flags removed.
 *
 * GApplication parses argv itself and bails out on anything it does not know, so a flag the app
 * handles before the loop starts must not reach it: `steuererklaerung --demo` printed
 * `Unbekannte Option --demo` and exited 1 instead of opening the demo window (a second finding
 * from issue #133, present long before the dispatch above). Dropping the flag here loses nothing:
 * `applyDemoEnv()` has already turned it into `STEUER_DEMO=1`, which is what every later read
 * looks at, and restart.ts keeps its own unfiltered snapshot of the launch.
 */
export function guiArgv(args: string[]): string[] {
    return args.filter((a) => !GUI_FLAGS.has(a));
}
