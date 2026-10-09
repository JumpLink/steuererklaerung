import { submitFiling, evaluateSubmitReadiness } from '../../../core/actions/elster/submit.ts';
import { pickArgv } from '../output.ts';
import { SNAPSHOT_FORMS } from './shared.ts';
import { resolveEntityElster } from '../../../core/config/accessors.ts';
import { resolveElsterPin } from '../../../core/elster/pin.ts';

import type { CommandModule as YargsCommandModule } from 'yargs';

/**
 * `elster submit` — transmit a signed-off filing snapshot to ELSTER through ERiC (the "Absenden"
 * action). Defaults to a TEST send (Testmerker, discarded at the clearing house); `--live` requires
 * the full release gate + `--allow-live` + a real certificate. `--check` previews the readiness
 * ladder WITHOUT contacting ERiC. The keystore PIN is used for the call only and never stored.
 */
export const submitSubcommand: YargsCommandModule = {
    command: 'submit',
    describe:
        'Eine freigegebene Steuererklärung an ELSTER übermitteln (Absenden). Standard: Test-Versand (Testmerker, verworfen). --live nur mit vollem Freigabe-Gate + --allow-live + echtem Zertifikat. --check zeigt nur die Bereitschaft.',
    builder: (y) =>
        y
            .option('entity', {
                type: 'string',
                demandOption: true,
                describe: 'Workspace-Entität (gbr|jumplink|privat)',
            })
            .option('year', { type: 'number', demandOption: true, describe: 'Steuerjahr, z. B. 2025' })
            .option('period', {
                type: 'string',

                describe: 'USt-VA: Periode, z. B. 2025-Q1 — ohne sie gilt der neueste Snapshot des Formulars',
            })
            .option('form', {
                choices: SNAPSHOT_FORMS,
                demandOption: true,
                describe: 'Formulartyp (ustva|euer|uste|gewst|feststellung)',
            })
            .option('live', {
                type: 'boolean',
                default: false,
                describe: 'Echt-Versand statt Test (erfordert --allow-live)',
            })
            .option('allow-live', {
                type: 'boolean',
                default: false,
                describe: 'Ausdrückliche Bestätigung für den Echt-Versand',
            })
            .option('korrektur', {
                type: 'boolean',
                default: false,
                describe: 'BERICHTIGUNG einer bereits abgegebenen Erklärung (hebt nur die Doppelabgabe-Sperre)',
            })
            .option('keystore', { type: 'string', describe: 'Pfad zum PKCS#12-Zertifikat (.pfx/.p12)' })
            .option('pin', {
                type: 'string',
                describe: 'PIN des Zertifikats (nur für diesen Aufruf, wird nicht gespeichert)',
            })
            .option('snapshot-id', {
                type: 'string',
                describe: 'Bestimmten Snapshot senden (sonst der neueste des Formulars)',
            })
            .option('by', { type: 'string', describe: 'Wer sendet (Audit bei Echt-Versand)' })
            .option('check', { type: 'boolean', default: false, describe: 'Nur die Bereitschaft prüfen, NICHT senden' })
            .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
    handler: async (argv) => {
        const raw = argv as Record<string, unknown>;
        const entity = pickArgv<string>(raw, 'entity') as string;
        const year = pickArgv<number>(raw, 'year') as number;
        const form = pickArgv<string>(raw, 'form') as string;
        const mode = raw.live ? 'live' : 'test';
        const snapshotId = pickArgv<string>(raw, 'snapshotId');
        const allowLive = raw.allowLive === true;
        try {
            // `--check`, or no PIN available anywhere: a safe dry-run of the readiness ladder —
            // never sends. The keystore path may come from the entity config, so only the PIN is
            // required to send.
            const keystore = pickArgv<string>(raw, 'keystore');
            // Resolved through the same three sources as every other signing command (argument →
            // ELSTER_PIN → keyring), NOT read from `--pin` alone. This is the call site the
            // resolution exists FOR: npm and gjsify echo the resolved command line, so a `--pin`
            // here put the PIN in the clear five times in one working session — and it was the
            // only command still demanding it after the resolution shipped.
            const keystoreForPin = keystore ?? resolveEntityElster(entity)?.keystore_path ?? '';
            let pin: string | undefined;
            let pinSource: string | undefined;
            try {
                const r = resolveElsterPin(pickArgv<string>(raw, 'pin'), keystoreForPin);
                pin = r.pin;
                pinSource = r.source;
            } catch {
                // No PIN anywhere — fall through to the dry run, which explains the three ways.
            }
            if (raw.check || !pin) {
                const readiness = evaluateSubmitReadiness({
                    entity,
                    year,
                    formType: form,
                    period: pickArgv<string>(raw, 'period'),
                    mode,
                    snapshotId,
                    allowLive,
                    isCorrection: raw.korrektur === true,
                });
                if (raw.json) {
                    console.log(JSON.stringify(readiness, null, 2));
                    return process.exit(0);
                }
                console.log(`\nAbsenden-Bereitschaft (${mode}) — ${entity} ${year} · ${form}`);
                console.log('='.repeat(72));
                console.log(
                    `  Snapshot: ${readiness.snapshot ? `${readiness.snapshot.id} (${readiness.snapshot.status})` : '—'}`,
                );
                console.log(`  Artefakt: ${readiness.isTestArtifact ? 'Test (Testmerker)' : 'Echt'}`);
                if (readiness.datenartVersion) console.log(`  Datenart: ${readiness.datenartVersion}`);
                console.log(`  Bereit: ${readiness.ready ? '✓ ja' : '✗ nein'}`);
                if (readiness.blockers.length > 0) {
                    console.log('  Blocker:');
                    for (const b of readiness.blockers) console.log(`    ✗ ${b}`);
                }
                if (readiness.ready && !raw.check) {
                    console.log('\n  → Zum Senden fehlt nur die Zertifikats-PIN. Drei Wege, keiner davon');
                    console.log('    die Kommandozeile (npm echot sie sonst im Klartext):');
                    console.log(`      Schlüsselbund:     npm start -- elster pin speichern --entity ${entity}`);
                    console.log('      Umgebungsvariable: export ELSTER_PIN=…   (bzw. read -rs ELSTER_PIN)');
                    console.log('      Notfalls:          --pin …               (landet in der History)');
                }
                console.log('');
                return process.exit(readiness.ready ? 0 : 1);
            }

            const result = await submitFiling({
                entity,
                year,
                formType: form,
                period: pickArgv<string>(raw, 'period'),
                mode,
                keystorePath: keystore,
                pin,
                snapshotId,
                allowLive,
                isCorrection: raw.korrektur === true,
                submittedBy: pickArgv<string>(raw, 'by'),
            });
            if (raw.json) {
                console.log(JSON.stringify(result, null, 2));
                return process.exit(result.ok ? 0 : 1);
            }
            console.log(`\nAbsenden (${result.mode}) — ${entity} ${year} · ${form}`);
            if (pinSource) console.log(`  PIN-Quelle: ${pinSource}`);
            console.log('='.repeat(72));
            console.log(`  ${result.ok ? '✓' : '✗'} ${result.message}`);
            if (result.snapshotId) console.log(`  Snapshot: ${result.snapshotId} → Status ${result.status ?? '—'}`);
            if (result.blockers.length > 0) for (const b of result.blockers) console.log(`    ✗ ${b}`);
            console.log('');
            return process.exit(result.ok ? 0 : 1);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            return process.exit(1);
        }
    },
};
