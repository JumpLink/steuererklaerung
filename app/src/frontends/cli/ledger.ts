import type { CommandModule } from 'yargs';

import { ledgerImportFromStore, ledgerInit, ledgerStatusReport } from '../../core/actions/ledger.ts';
import type { LedgerStatus } from '@steuererklaerung/store';
import { runAndExit } from './output.ts';

function printStatus(s: LedgerStatus): void {
    console.log(`\nLedger (SQLite) — ${s.dbPath}`);
    console.log('='.repeat(56));
    console.log(
        `  schema v${s.schemaVersion} | entities ${s.entities} | accounts ${s.accounts} | chart ${s.chartOfAccounts}`,
    );
    console.log(
        `  transactions: ${s.transactions} | classifications: ${s.classifications} (decision layer — open, nothing persisted)`,
    );
    if (s.byAccount.length > 0) {
        console.log('\n  RAW transactions per account:');
        for (const a of s.byAccount) {
            const span = a.from && a.to ? `${a.from} … ${a.to}` : '—';
            console.log(
                `    ${a.accountKey.padEnd(34)} ${String(a.count).padStart(5)}  [${a.entityId ?? '?'}]  ${span}`,
            );
        }
    }
}

export const ledgerCommand: CommandModule = {
    command: 'ledger',
    describe:
        'SQLite bookkeeping ledger (system-of-record foundation). Stores RAW transactions + master data; classifications stay OPEN (not persisted) until verified.',
    handler: () => {},
    builder: (yargs) =>
        yargs
            .demandCommand(1, 'Choose a subcommand: init, import, status')
            .command({
                command: 'init',
                describe: 'Create the ledger schema and seed master data (entities + chart of accounts). Idempotent.',
                handler: () => runAndExit(() => ledgerInit()),
            })
            .command({
                command: 'import',
                describe:
                    'Import every RAW transaction from the NDJSON store into the ledger (idempotent upsert). No classifications are written.',
                handler: () => runAndExit(() => ledgerImportFromStore()),
            })
            .command({
                command: 'status',
                describe: 'Show ledger contents: schema version, master-data + transaction counts per account.',
                handler: () => runAndExit(() => ledgerStatusReport(), { print: printStatus }),
            }),
};
