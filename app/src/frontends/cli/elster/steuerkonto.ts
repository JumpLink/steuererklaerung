import { loadSteuerkontoScope, printSteuerkonto, steuerkontoReport } from '../../../core/actions/elster/steuerkonto.ts';
import { pickArgv } from '../output.ts';
import { accountKeysFrom } from './shared.ts';

import type { CommandModule as YargsCommandModule } from 'yargs';

/** `elster steuerkonto` — tax payments/refunds that flowed through the accounts, by entity. */
export const steuerkontoSubcommand: YargsCommandModule = {
    command: 'steuerkonto',
    describe:
        'Steuer-Zahlungsübersicht aus den Konten: USt/GewSt/ESt-Zahlungen + Erstattungen je Entität (GbR vs JumpLink vs persönlich), als Abgleich für Mein ELSTER.',
    builder: (y) =>
        y
            .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
            .option('account-key', { type: 'array', describe: 'Account(s) to scan (default: all camt:)' })
            .option('json', { type: 'boolean', default: false, describe: 'Output raw JSON' }),
    handler: (argv) => {
        const raw = argv as Record<string, unknown>;
        const year = pickArgv<number>(raw, 'year') as number;
        try {
            const report = steuerkontoReport(loadSteuerkontoScope(), year, accountKeysFrom(raw));
            if (raw.json) console.log(JSON.stringify(report, null, 2));
            else printSteuerkonto(report);
            process.exit(0);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    },
};
