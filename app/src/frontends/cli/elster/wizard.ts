import { buildTaxReturnPlan, printTaxReturnPlan } from '../../../core/actions/elster/wizard.ts';
import { loadPaperlessConfig } from '../../../core/config/index.ts';
import { pickArgv } from '../output.ts';
import { accountKeysFrom, parseElsterArgs } from './shared.ts';

import type { CommandModule as YargsCommandModule } from 'yargs';

/** `elster wizard` — Steuererklärungs-Assistent: the step-by-step readiness plan for a tax year. */
export const wizardSubcommand: YargsCommandModule = {
    command: 'wizard',
    describe:
        'Steuererklärungs-Assistent: Schritt-für-Schritt-Plan (Vollständigkeit → Formulare → Abgabe) für ein Jahr.',
    builder: (y) =>
        y
            .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
            .option('account-key', { type: 'array', describe: 'Account(s) to sum (default: all camt:)' })
            .option('json', { type: 'boolean', default: false, describe: 'Output the raw plan as JSON' }),
    handler: async (argv) => {
        const raw = argv as Record<string, unknown>;
        const year = pickArgv<number>(raw, 'year') as number;
        try {
            const elster = parseElsterArgs(raw);
            const plan = await buildTaxReturnPlan(loadPaperlessConfig(), elster, year, {
                accountKeys: accountKeysFrom(raw),
            });
            if (raw.json) console.log(JSON.stringify(plan, null, 2));
            else printTaxReturnPlan(plan);
            process.exit(0);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    },
};
