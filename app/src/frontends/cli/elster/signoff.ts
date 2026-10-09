import {
    signOffFiling,
    getSignoffStatus,
    evaluateSubmissionGate,
    revokeFilingSignoff,
    listFilingSignoffs,
} from '../../../core/actions/elster/signoffs.ts';
import { pickArgv } from '../output.ts';
import { SNAPSHOT_FORMS } from './shared.ts';

import type { FilingSignoff } from '@steuererklaerung/store';
import type { CommandModule as YargsCommandModule } from 'yargs';

/** One-line summary of a sign-off for the CLI. */
function printSignoffLine(s: FilingSignoff): void {
    const flags = [s.revoked ? 'widerrufen' : 'aktiv', s.crossChecksClean ? 'Querprüfungen ok' : 'Querprüfungen ⚠'];
    console.log(`  ${s.id}  ${s.formType.padEnd(12)} ${s.signedAt}  ${s.signedBy ?? '—'}  [${flags.join(' · ')}]`);
}

/**
 * `elster signoff` — fingerprint-bound filing sign-offs (S9): the submission gate for the ELSTER
 * "Absenden" flow. `status` shows the current release + gate (unlocked + Blocker); `sign` records an
 * explicit release bound to the latest snapshot's fingerprint (refusing a stale/drifted snapshot);
 * `revoke <id>` withdraws a release. A release becomes invalid the moment the underlying data drifts.
 */
export const signoffSubcommand: YargsCommandModule = {
    command: 'signoff',
    describe:
        'Snapshot-gebundene Freigaben (sign-off): das Abgabe-Gate für die ELSTER-Übermittlung — status (Gate + Blocker), sign (freigeben), revoke (widerrufen). Eine Freigabe gilt nur für den Snapshot, für den sie erteilt wurde, und wird ungültig, sobald sich die zugrunde liegenden Daten ändern.',
    handler: () => {},
    builder: (y) =>
        y
            .demandCommand(1, 'Choose a subcommand: status, sign, revoke')
            .command({
                command: 'status',
                describe: 'Freigabe-Status + Abgabe-Gate (unlocked + Blocker) für Entität/Jahr/Form.',
                builder: (yy) =>
                    yy
                        .option('entity', {
                            type: 'string',
                            demandOption: true,
                            describe: 'Workspace-Entität (gbr|jumplink|privat)',
                        })
                        .option('year', { type: 'number', demandOption: true, describe: 'Steuerjahr, z. B. 2025' })
                        .option('period', {
                            type: 'string',

                            describe:
                                'USt-VA: Periode, z. B. 2025-Q1 — ohne sie gilt der neueste Snapshot des Formulars',
                        })
                        .option('form', {
                            choices: SNAPSHOT_FORMS,
                            demandOption: true,
                            describe: 'Formulartyp (ustva|euer|uste|gewst|feststellung)',
                        })
                        .option('list', {
                            type: 'boolean',
                            default: false,
                            describe: 'Freigabe-Historie auflisten (statt Status)',
                        })
                        .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const entity = pickArgv<string>(raw, 'entity') as string;
                    const year = pickArgv<number>(raw, 'year') as number;
                    const form = pickArgv<string>(raw, 'form') as string;
                    try {
                        if (raw.list) {
                            const signoffs = listFilingSignoffs(entity, year, form);
                            if (raw.json) console.log(JSON.stringify(signoffs, null, 2));
                            else if (signoffs.length === 0)
                                console.log(`Keine Freigaben für ${entity} ${year} (${form}).`);
                            else {
                                console.log(`\nFreigaben — ${entity} ${year} · ${form} (${signoffs.length})`);
                                for (const s of signoffs) printSignoffLine(s);
                                console.log('');
                            }
                            process.exit(0);
                        }
                        const status = getSignoffStatus({ entity, year, formType: form });
                        const gate = evaluateSubmissionGate({ entity, year, formType: form });
                        if (raw.json) {
                            console.log(JSON.stringify({ ...status, gate }, null, 2));
                            process.exit(0);
                        }
                        console.log(`\nFreigabe-Status — ${entity} ${year} · ${form}`);
                        console.log('='.repeat(72));
                        console.log(
                            `  Snapshot: ${status.snapshot ? `${status.snapshot.id} (${status.snapshot.status})` : '—'}` +
                                (status.snapshot ? `  [${status.stale ? '⚠ veraltet' : 'aktuell'}]` : ''),
                        );
                        console.log(
                            `  Freigabe: ${
                                status.signoff
                                    ? `${status.signoff.id} · ${status.signoff.signedAt} · ${status.signoff.signedBy ?? '—'}` +
                                      `${status.signoff.revoked ? ' · widerrufen' : ''}`
                                    : '—'
                            }`,
                        );
                        console.log(`  Gültig: ${status.valid ? '✓ ja' : '✗ nein'}`);
                        if (status.reason) console.log(`  Hinweis: ${status.reason}`);
                        console.log(`\n  Abgabe (Absenden): ${gate.unlocked ? '✓ freigeschaltet' : '✗ gesperrt'}`);
                        if (gate.blockers.length > 0) {
                            console.log('  Blocker:');
                            for (const b of gate.blockers) console.log(`    ✗ ${b}`);
                        }
                        console.log('');
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'sign',
                describe:
                    'Eine Steuererklärung freigeben — bindet an EINEN Snapshot (dessen eingefrorene Zahlen; verweigert veraltete/driftende Snapshots) und hält den Querprüfungs-Befund fest.',
                builder: (yy) =>
                    yy
                        .option('entity', {
                            type: 'string',
                            demandOption: true,
                            describe: 'Workspace-Entität (gbr|jumplink|privat)',
                        })
                        .option('year', { type: 'number', demandOption: true, describe: 'Steuerjahr, z. B. 2025' })
                        .option('form', {
                            choices: SNAPSHOT_FORMS,
                            demandOption: true,
                            describe: 'Formulartyp (ustva|euer|uste|gewst|feststellung)',
                        })
                        .option('snapshot-id', {
                            type: 'string',
                            describe: 'Bestimmten Snapshot freigeben (sonst der neueste des Formulars)',
                        })
                        .option('by', { type: 'string', describe: 'Wer gibt frei (wird als signed_by gespeichert)' })
                        .option('note', { type: 'string', describe: 'Notiz zur Freigabe' })
                        .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const entity = pickArgv<string>(raw, 'entity') as string;
                    const year = pickArgv<number>(raw, 'year') as number;
                    const form = pickArgv<string>(raw, 'form') as string;
                    try {
                        const result = await signOffFiling({
                            entity,
                            year,
                            formType: form,
                            period: pickArgv<string>(raw, 'period'),
                            snapshotId: pickArgv<string>(raw, 'snapshotId'),
                            signedBy: pickArgv<string>(raw, 'by'),
                            note: pickArgv<string>(raw, 'note'),
                        });
                        if (raw.json) {
                            console.log(JSON.stringify(result, null, 2));
                            process.exit(0);
                        }
                        const { signoff, crossChecks } = result;
                        console.log(`\nFreigabe erstellt: ${signoff.id}`);
                        console.log(
                            `  Entität: ${signoff.entityId} · Jahr: ${signoff.year} · Form: ${signoff.formType}`,
                        );
                        console.log(`  Snapshot: ${signoff.snapshotId}`);
                        console.log(`  Freigegeben: ${signoff.signedAt} von ${signoff.signedBy ?? '—'}`);
                        console.log(`  Fingerprint: ${signoff.fingerprint}`);
                        if (signoff.note) console.log(`  Notiz: ${signoff.note}`);
                        const verdict = crossChecks
                            ? `${crossChecks.summary.error} Fehler · ${crossChecks.summary.warn} Warnung(en) — ${crossChecks.summary.clean ? 'sauber' : 'NICHT sauber'}`
                            : 'nicht ermittelbar';
                        console.log(`  Querprüfungen: ${verdict}`);
                        if (!signoff.crossChecksClean)
                            console.log('  ⚠ Querprüfungen nicht sauber — Abgabe bleibt gesperrt, bis geklärt.');
                        console.log('');
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'revoke <id>',
                describe: 'Eine Freigabe widerrufen (soft, auditierbar — die inhaltlichen Felder bleiben eingefroren).',
                builder: (yy) =>
                    yy
                        .positional('id', { type: 'string', describe: 'Sign-off id (signoff_…)' })
                        .option('entity', {
                            type: 'string',
                            demandOption: true,
                            describe: 'Workspace-Entität (Besitzprüfung)',
                        })
                        .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
                handler: (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const id = pickArgv<string>(raw, 'id') as string;
                    const entity = pickArgv<string>(raw, 'entity') as string;
                    try {
                        const revoked = revokeFilingSignoff(entity, id);
                        if (raw.json) {
                            console.log(JSON.stringify(revoked, null, 2));
                        } else if (!revoked) {
                            console.log(`Keine Freigabe mit id '${id}'.`);
                        } else {
                            console.log(`Freigabe ${revoked.id} widerrufen (Snapshot ${revoked.snapshotId}).`);
                        }
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            }),
};
