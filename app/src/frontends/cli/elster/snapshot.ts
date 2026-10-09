import { createFilingSnapshot, listFilingSnapshots, isSnapshotStale } from '../../../core/actions/elster/snapshots.ts';
import { validateFilingSnapshot } from '../../../core/actions/elster/submit.ts';
import { lockLedgerPeriod, ledgerPeriodStatus } from '../../../core/actions/ledger.ts';
import { pickArgv } from '../output.ts';
import { SNAPSHOT_FORMS } from './shared.ts';

import type { FilingSnapshot } from '@steuererklaerung/store';
import type { CommandModule as YargsCommandModule } from 'yargs';

/** `elster lock` — GoBD Festschreibung gate on the ledger periods table. */
export const lockSubcommand: YargsCommandModule = {
    command: 'lock',
    describe: 'Lock a tax year (GoBD Festschreibung) — mark the books final before filing.',
    builder: (y) =>
        y
            .option('entity', {
                type: 'string',
                default: 'artcode',
                describe: 'Ledger entity (artcode|jumplink|private)',
            })
            .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
            .option('status', { type: 'boolean', default: false, describe: 'Only show the current lock status' }),
    handler: async (argv) => {
        const raw = argv as Record<string, unknown>;
        const entity = (pickArgv<string>(raw, 'entity') as string) ?? 'artcode';
        const year = pickArgv<number>(raw, 'year') as number;
        try {
            if (raw.status) {
                const s = await ledgerPeriodStatus(entity, year);
                console.log(`${entity} ${year}: ${s ?? 'open (no period row)'}`);
            } else {
                const r = await lockLedgerPeriod(entity, year);
                console.log(`Locked ${r.entityId} ${r.year} (status: ${r.status}).`);
            }
            process.exit(0);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    },
};

/** One-line summary of a snapshot for the CLI, with its live drift verdict. */
function printSnapshotLine(s: FilingSnapshot): void {
    let drift: string;
    try {
        drift = isSnapshotStale(s) ? '⚠ Daten geändert seit Erfassung' : 'aktuell';
    } catch (err) {
        drift = `Drift n/a (${err instanceof Error ? err.message : String(err)})`;
    }
    // The period is what tells two USt-VA snapshots of one year apart; a list without it is a list
    // of rows that look identical.
    const scope = s.period ? `${s.formType} ${s.period}` : s.formType;
    console.log(`  ${s.id}  ${scope.padEnd(16)} ${s.status.padEnd(10)} ${s.createdAt}  [${drift}]`);
}

/** Drift verdict that degrades to false instead of throwing (used in list/JSON output). */
function safeStale(s: FilingSnapshot): boolean {
    try {
        return isSnapshotStale(s);
    } catch {
        return false;
    }
}

/**
 * `elster snapshot` — capture / list IMMUTABLE filing snapshots (S8): the frozen ELSTER XML +
 * headline figures + input fingerprint a submission binds to. `--list` shows the history with a
 * live drift verdict; without it, one snapshot for the given form is created.
 */
export const snapshotSubcommand: YargsCommandModule = {
    command: 'snapshot',
    describe:
        'Unveränderliche Filing-Snapshots: die eingefrorene ELSTER-XML + Kennzahlen + Eingabe-Fingerprint einer Steuererklärung erfassen/auflisten (mit Drift-Prüfung gegen die aktuellen Daten).',
    builder: (y) =>
        y
            .option('entity', {
                type: 'string',
                demandOption: true,
                describe: 'Workspace-Entität (gbr|jumplink|privat)',
            })
            .option('year', { type: 'number', demandOption: true, describe: 'Steuerjahr, z. B. 2025' })
            .option('form', {
                choices: SNAPSHOT_FORMS,
                describe: 'Formulartyp (ustva|euer|uste|gewst|feststellung) — für die Erstellung erforderlich',
            })
            .option('quarter', {
                type: 'number',
                describe: 'USt-VA: Quartal (1–4). Ohne Angabe gilt die Periode aus der ELSTER-Config.',
            })
            .option('month', { type: 'number', describe: 'USt-VA: Monat (1–12), statt eines Quartals' })
            .option('period', {
                type: 'string',
                describe: 'USt-VA: Periode eines vorhandenen Snapshots, z. B. 2025-Q1 (für --validate)',
            })
            .option('list', {
                type: 'boolean',
                default: false,
                describe: 'Vorhandene Snapshots auflisten (statt erstellen)',
            })
            .option('validate', {
                type: 'boolean',
                default: false,
                describe:
                    'Den (neuesten) Snapshot lokal gegen ERiC validieren und bei Erfolg als „validated" markieren (test-first, KEIN Versand)',
            })
            .option('snapshot-id', {
                type: 'string',
                describe: 'Bestimmten Snapshot wählen (statt des neuesten des Formulars) — für --validate',
            })
            .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
    handler: async (argv) => {
        const raw = argv as Record<string, unknown>;
        const entity = pickArgv<string>(raw, 'entity') as string;
        const year = pickArgv<number>(raw, 'year') as number;
        const form = pickArgv<string>(raw, 'form');
        try {
            if (raw.list) {
                const snaps = listFilingSnapshots(entity, year, form);
                if (raw.json) {
                    console.log(
                        JSON.stringify(
                            snaps.map((s) => ({ ...s, stale: safeStale(s) })),
                            null,
                            2,
                        ),
                    );
                } else if (snaps.length === 0) {
                    console.log(`Keine Filing-Snapshots für ${entity} ${year}${form ? ` (${form})` : ''}.`);
                } else {
                    console.log(`\nFiling-Snapshots — ${entity} ${year}${form ? ` · ${form}` : ''} (${snaps.length})`);
                    for (const s of snaps) printSnapshotLine(s);
                    console.log('');
                }
                return process.exit(0);
            }
            if (raw.validate) {
                if (!form) {
                    throw new Error('--form <ustva|euer|uste|gewst|feststellung|est> für --validate angeben.');
                }
                const result = await validateFilingSnapshot({
                    entity,
                    year,
                    formType: form,
                    period: pickArgv<string>(raw, 'period'),
                    snapshotId: pickArgv<string>(raw, 'snapshotId'),
                });
                if (raw.json) {
                    console.log(JSON.stringify(result, null, 2));
                    return process.exit(result.ok ? 0 : 1);
                }
                console.log(`\nLokale ERiC-Validierung — ${entity} ${year} · ${form}`);
                console.log('='.repeat(72));
                console.log(`  ${result.ok ? '✓' : '✗'} ${result.message}`);
                if (result.snapshotId)
                    console.log(`  Snapshot: ${result.snapshotId}${result.status ? ` → Status ${result.status}` : ''}`);
                if (result.hinweise) console.log(`  Hinweise: ${result.hinweise}`);
                for (const b of result.blockers) console.log(`    ✗ ${b}`);
                console.log('');
                return process.exit(result.ok ? 0 : 1);
            }
            if (!form) {
                throw new Error('--form <ustva|euer|uste|gewst|feststellung|est> angeben (oder --list zum Auflisten).');
            }
            const snap = await createFilingSnapshot(entity, year, form, {
                quarter: pickArgv<number>(raw, 'quarter'),
                month: pickArgv<number>(raw, 'month'),
            });
            if (raw.json) {
                console.log(JSON.stringify({ ...snap, stale: safeStale(snap) }, null, 2));
            } else {
                console.log(`\nSnapshot erstellt: ${snap.id}`);
                console.log(
                    `  Entität: ${snap.entityId} · Jahr: ${snap.year} · Form: ${snap.formType}` +
                        `${snap.period ? ` · Periode: ${snap.period}` : ''} · Status: ${snap.status}`,
                );
                console.log(`  Erfasst: ${snap.createdAt}`);
                console.log(
                    `  Fingerprint: ${snap.fingerprint}  [${safeStale(snap) ? '⚠ bereits abweichend' : 'aktuell'}]`,
                );
                const fig = snap.figures as { headline?: Record<string, number> } | null;
                if (fig?.headline && Object.keys(fig.headline).length > 0) {
                    const parts = Object.entries(fig.headline).map(([k, v]) => `${k}=${v}`);
                    console.log(`  Kennzahlen: ${parts.join(' · ')}`);
                }
                console.log('');
            }
            return process.exit(0);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            return process.exit(1);
        }
    },
};
