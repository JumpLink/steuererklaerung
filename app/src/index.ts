import 'dotenv/config';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
    backupCommand,
    checkApisCommand,
    qontoCommand,
    paperlessCommand,
    syncCommand,
    elsterCommand,
    bmfKurseCommand,
    invoicesCommand,
    mcpCommand,
    fintsCommand,
    qontoExportCommand,
    camtExportCommand,
    transactionsCommand,
    reconcileCommand,
    ledgerCommand,
    webCommand,
    fristenCommand,
    freiVerfuegbarCommand,
    hinweiseCommand,
    buchungenCommand,
    belegeCommand,
    laufendeKostenCommand,
    finanzierungCommand,
    filingCommand,
    umsatzAufstellungCommand,
    demoCommand,
    configCommand,
    contactsCommand,
    timeCommand,
    projectsCommand,
    zveCommand,
} from './frontends/cli/index.ts';
import { installMigrationBackup } from './core/actions/backup.ts';
import { applyDemoEnv } from './core/config/demo.ts';
import { setFinTSInteraction } from './core/clients/fints/interaction.ts';
import { terminalFinTSInteraction } from './frontends/cli/fints-interaction.ts';
import { applyPathEnv } from './core/paths.ts';

// Demo mode (STEUER_DEMO=1 / --demo): redirect config + store paths to app/demo BEFORE anything reads
// them, so the fictional demo data stays fully isolated from real data. No-op in normal use.
applyDemoEnv();
installMigrationBackup();
// Then give a FRESH installation a home: without this, an app launched from the GNOME overview has
// cwd `/` or `$HOME` and finds no manifest at all. Strictly additive — an existing installation
// (a manifest in cwd, an override, a store beside the module) is left exactly as it was.
applyPathEnv();
// The terminal answers the bank's TAN/PIN questions. Registered here rather than inside the FinTS
// client so the same session code can serve a window (see core/clients/fints/interaction.ts).
setFinTSInteraction(terminalFinTSInteraction);

function reportError(err: unknown): void {
    // With yargs' `.fail(false)` (below) yargs no longer prints its own usage dump on a
    // validation/demandCommand failure — so we surface every error's message here, exactly once.
    // For a YError that message is the demandCommand/validation hint (e.g. "Use a command: …").
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
}

const parseArgs = () =>
    yargs(hideBin(process.argv))
        .command(checkApisCommand)
        .command(qontoCommand)
        .command(qontoExportCommand)
        .command(paperlessCommand)
        .command(syncCommand)
        .command(elsterCommand)
        .command(bmfKurseCommand)
        .command(invoicesCommand)
        .command(mcpCommand)
        .command(fintsCommand)
        .command(camtExportCommand)
        .command(transactionsCommand)
        .command(reconcileCommand)
        .command(ledgerCommand)
        .command(fristenCommand)
        .command(freiVerfuegbarCommand)
        .command(hinweiseCommand)
        .command(buchungenCommand)
        .command(belegeCommand)
        .command(laufendeKostenCommand)
        .command(finanzierungCommand)
        .command(filingCommand)
        .command(contactsCommand)
        .command(timeCommand)
        .command(projectsCommand)
        .command(zveCommand)
        .command(umsatzAufstellungCommand)
        .command(webCommand)
        .command(demoCommand)
        .command(configCommand)
        .command(backupCommand)
        .option('demo', {
            type: 'boolean',
            default: false,
            describe: 'Gegen das mitgelieferte Demo-Workspace (app/demo) laufen — keine echten Daten',
        })
        .demandCommand(1, 'Bitte ein Kommando angeben — „steuer --help" zeigt alle verfügbaren Kommandos.')
        // Reject unknown commands instead of silently resolving — on GJS an unmatched
        // command would otherwise leave the main loop running forever (hang); on Node it
        // would exit 0. With this, both reject → reportError → exit 1.
        .strictCommands()
        // The product is `steuererklaerung`; the command is the short `steuer` — every usage line,
        // help page and validation error must name what the user actually types.
        .scriptName('steuer')
        .help()
        // Don't let yargs print its own multi-line usage dump on a validation/demandCommand failure
        // — it otherwise doubled with the hint we print in reportError (once from yargs, once from
        // us). `.fail(false)` makes yargs THROW instead of printing; reportError then prints the
        // single-line hint. The full command table is still available via `--help`.
        .fail(false)
        .exitProcess(false)
        .parseAsync();

// yargs (with exitProcess(false) + fail(false)) can throw *synchronously* for some nested
// demandCommand failures instead of rejecting. On GJS that surfaces as an uncaught "Module threw
// an exception"; on Node it's an uncaught throw. Normalize it to a rejection so the handlers below
// report it exactly once (reportError prints the hint — yargs no longer prints its own).
let parsed: ReturnType<typeof parseArgs>;
try {
    parsed = parseArgs();
} catch (err) {
    parsed = Promise.reject(err);
}

// Runtime detection (the same probe the gjsify examples use — no extra dependency).
const isGjs = typeof (globalThis as { imports?: unknown }).imports !== 'undefined';

if (isGjs) {
    // GJS has no always-on event loop, so a GLib main loop keeps async command
    // handlers (and the long-lived MCP stdio server) alive and pumps their I/O.
    //
    // Most commands kick off async work and call process.exit() themselves when it
    // finishes (directly or via runAndExit), relying on Node keeping its event loop
    // alive in the meantime. So the loop just runs until that happens — we must NOT
    // quit it merely because parseAsync settled: a synchronous, fire-and-forget
    // handler settles it long before its work (and its process.exit) completes. We
    // only step in where nothing else will exit:
    //   - parse/validation errors (rejection) → report + exit;
    //   - yargs' built-in --help / --version → they resolve with no command running.
    //
    // A top-level `await` is deliberately avoided: we drive parse fire-and-forget
    // and run the loop synchronously so it pumps I/O at once and owns teardown.
    // Always exit via process.exit() (gjsify idle-schedules GLib.MainLoop.quit() +
    // system.exit()); a bare imports.system.exit() from an async continuation sets
    // GJS's exit flag without quitting the loop and would hang. (An earlier note
    // here blamed a TLA microtask-draining stall — that was pre-1.72 GJS behaviour;
    // modern GJS 1.86+ drains correctly.)
    const GLib = (
        globalThis as unknown as {
            imports: { gi: { GLib: { MainLoop: new (ctx: unknown, running: boolean) => { run(): void } } } };
        }
    ).imports.gi.GLib;
    const loop = new GLib.MainLoop(null, false);
    parsed.then(
        (argv) => {
            const a = argv as Record<string, unknown> | undefined;
            // Only --help / --version resolve here with nothing left to run.
            if (a?.help || a?.version) process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
            // Otherwise a command's async work is in flight and will call process.exit().
        },
        (err) => {
            reportError(err);
            process.exit(typeof process.exitCode === 'number' ? process.exitCode : 1);
        },
    );
    loop.run();
} else {
    parsed.catch(reportError);
}
