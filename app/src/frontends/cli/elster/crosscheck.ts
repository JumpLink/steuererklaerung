import { computeCrossChecks, printCrossChecks } from '../../../core/actions/elster/cross-checks.ts';
import { loadPaperlessConfig } from '../../../core/config/index.ts';
import { pickArgv } from '../output.ts';
import { accountKeysFrom, parseElsterArgs } from './shared.ts';

import type { CommandModule as YargsCommandModule } from 'yargs';

/** `elster crosscheck` — machine-evaluated cross-checks (S6): reconcile the reports before filing. */
export const crosscheckSubcommand: YargsCommandModule = {
    command: 'crosscheck',
    describe:
        'Querprüfungen: die Berichte gegeneinander abstimmen (ΣUSt-VA↔USt-Jahr, Steuerkonto↔USt, EÜR↔Feststellung, Vollständigkeit, USt-Verprobung) — Bereitschaft vor der Abgabe.',
    builder: (y) =>
        y
            .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
            .option('account-key', { type: 'array', describe: 'Account(s) to sum (default: the --entity accounts)' })
            .option('json', { type: 'boolean', default: false, describe: 'Output the raw CrossCheckResult[] as JSON' }),
    handler: async (argv) => {
        const raw = argv as Record<string, unknown>;
        const year = pickArgv<number>(raw, 'year') as number;
        try {
            // Resolve scope like `elster euer report`: explicit --account-key wins, else --entity's
            // accounts; the ELSTER config is optional (a private entity has none → USt checks skip).
            const accountKeys = accountKeysFrom(raw);
            let elster: ReturnType<typeof parseElsterArgs> | undefined;
            try {
                elster = parseElsterArgs(raw);
            } catch {
                elster = undefined;
            }
            const entity = pickArgv<string>(raw, 'entity');
            const results = await computeCrossChecks(loadPaperlessConfig(), { entity, year, accountKeys, elster });
            if (raw.json) console.log(JSON.stringify(results, null, 2));
            else printCrossChecks(results, year, entity);
            process.exit(0);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    },
};
