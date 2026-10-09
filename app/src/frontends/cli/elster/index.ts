import type { CommandModule } from 'yargs';

import { wizardSubcommand } from './wizard.ts';
import { estSubcommand } from './est.ts';
import { euerSubcommand } from './euer.ts';
import { explainSubcommand, reclassifySubcommand } from './explain.ts';
import { feststellungSubcommand } from './feststellung.ts';
import { stammdatenSubcommand } from './stammdaten.ts';
import { steuerkontoSubcommand } from './steuerkonto.ts';
import { crosscheckSubcommand } from './crosscheck.ts';
import { gewstSubcommand } from './gewst.ts';
import { usteSubcommand } from './uste.ts';
import { snapshotSubcommand, lockSubcommand } from './snapshot.ts';
import { kontoabfrageSubcommand } from './kontoabfrage.ts';
import { pinSubcommand } from './pin.ts';
import { signoffSubcommand } from './signoff.ts';
import { submitSubcommand } from './submit.ts';
import { filingSubcommand } from './filing.ts';
import { ustvaSubcommand } from './ustva.ts';
import { exitWhenTaxOff } from './shared.ts';

export const elsterCommand: CommandModule = {
    command: 'elster',
    describe: 'ELSTER-related tools (e.g. USt-VA XML for Mein ELSTER upload).',
    handler: () => {},
    builder: (yargs) =>
        yargs
            .demandCommand(
                1,
                'Choose a subcommand: setup, ustva, euer, explain, reclassify, uste, gewst, feststellung, stammdaten, wizard, est, steuerkonto, kontoabfrage, pin, crosscheck, snapshot, signoff, submit, filing, lock',
            )
            .option('entity', {
                type: 'string',
                describe:
                    'Workspace entity id from steuererklaerung.json — scopes the report to that entity’s accounts and selects its inline ELSTER config (e.g. jumplink, gbr). Overridden by explicit --account-key.',
            })
            .middleware((argv) => exitWhenTaxOff(argv._.slice(1).map(String), argv))
            .command(wizardSubcommand)
            .command(estSubcommand)
            .command(euerSubcommand)
            .command(explainSubcommand)
            .command(reclassifySubcommand)
            .command(feststellungSubcommand)
            .command(stammdatenSubcommand)
            .command(steuerkontoSubcommand)
            .command(crosscheckSubcommand)
            .command(gewstSubcommand)
            .command(usteSubcommand)
            .command(kontoabfrageSubcommand)
            .command(pinSubcommand)
            .command(snapshotSubcommand)
            .command(signoffSubcommand)
            .command(submitSubcommand)
            .command(filingSubcommand)
            .command(lockSubcommand)
            .command({
                command: 'setup',
                describe: 'Extract ERiC JAR and verify installation.',
                handler: async () => {
                    try {
                        const eric = await import('@steuererklaerung/eric');
                        const result = eric.runSetup();
                        if (!result.ok) {
                            console.error('Setup failed. Missing files:');
                            for (const f of result.missing) console.error(`  - ${f}`);
                            process.exit(1);
                        }
                        console.log(`Runtime directory: ${result.runtimeDir}`);
                        console.log(`Plugins found: ${result.pluginCount}`);

                        // Smoke test: initialize and shut down
                        console.log('Running smoke test...');
                        eric.initializeEric();
                        const version = eric.getVersion();
                        eric.shutdownEric();
                        console.log('Smoke test passed.');
                        console.log(`ERiC version info:\n${version}`);
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command(ustvaSubcommand),
};
