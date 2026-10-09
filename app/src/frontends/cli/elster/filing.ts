import { recordWebFiling, WEB_FILING_FORMS, type WebFilingForm } from '../../../core/actions/elster/web-filing.ts';
import { pickArgv } from '../output.ts';

import type { CommandModule as YargsCommandModule } from 'yargs';

/**
 * `elster filing` — maintain the filing register for submissions done OUTSIDE the ERiC path.
 * `record-web` records a completed Mein-ELSTER web-form submission: it captures a FRESH snapshot from
 * the current figures, marks it submitted with the Transferticket + date (source='web-form'), and
 * records the filing register row so list_filings shows the obligation as done.
 */
export const filingSubcommand: YargsCommandModule = {
    command: 'filing',
    describe: 'Filing-Register pflegen (z. B. eine im Web-Formular abgegebene Jahreserklärung erfassen).',
    handler: () => {},
    builder: (y) =>
        y.demandCommand(1, 'Choose a subcommand: record-web').command({
            command: 'record-web',
            describe:
                'Eine in Mein ELSTER (Web-Formular) abgegebene Erklärung erfassen: frischer Snapshot + als „submitted" (source=web-form) mit Transferticket markieren + Filing-Register-Eintrag.',
            builder: (yy) =>
                yy
                    .option('entity', {
                        type: 'string',
                        demandOption: true,
                        describe: 'Workspace-Entität (gbr|jumplink|privat)',
                    })
                    .option('form', {
                        choices: WEB_FILING_FORMS,
                        demandOption: true,
                        describe: 'Formulartyp (feststellung|uste|gewst|est|euer|ustva)',
                    })
                    .option('year', { type: 'number', demandOption: true, describe: 'Steuerjahr, z. B. 2025' })
                    .option('quarter', {
                        type: 'number',
                        choices: [1, 2, 3, 4],
                        describe: 'Voranmeldungszeitraum (nur --form ustva): Quartal 1–4 → Periode 2026-Q1',
                    })
                    .option('month', {
                        type: 'number',
                        choices: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
                        describe: 'Voranmeldungszeitraum (nur --form ustva, monatlich): 1–12 → Periode 2026-03',
                    })
                    .option('transferticket', {
                        type: 'string',
                        demandOption: true,
                        describe: 'Transferticket vom Übertragungsprotokoll (wird nicht erzeugt)',
                    })
                    .option('date', { type: 'string', describe: 'Abgabedatum YYYY-MM-DD (Vorgabe: heute)' })
                    .option('by', { type: 'string', describe: 'Wer erfasst (wird in der Notiz gespeichert)' })
                    .option('declared', {
                        type: 'number',
                        describe: 'Anmeldungssoll (angemeldete Zahllast, Kz 83) in EUR — treibt Z119',
                    })
                    .option('paid', {
                        type: 'number',
                        describe: 'Tatsächlich gezahlter Betrag in EUR (ggf. inkl. Säumniszuschlag)',
                    })
                    .option('surcharge', {
                        type: 'number',
                        describe: 'Säumniszuschlag / Nebenleistung (§240 AO) in EUR — keine USt',
                    })
                    .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
            handler: async (argv) => {
                const raw = argv as Record<string, unknown>;
                try {
                    const result = await recordWebFiling({
                        entity: pickArgv<string>(raw, 'entity') as string,
                        form: pickArgv<string>(raw, 'form') as WebFilingForm,
                        year: pickArgv<number>(raw, 'year') as number,
                        quarter: pickArgv<number>(raw, 'quarter'),
                        month: pickArgv<number>(raw, 'month'),
                        transferticket: pickArgv<string>(raw, 'transferticket') as string,
                        date: pickArgv<string>(raw, 'date'),
                        recordedBy: pickArgv<string>(raw, 'by'),
                        declared: pickArgv<number>(raw, 'declared'),
                        paid: pickArgv<number>(raw, 'paid'),
                        surcharge: pickArgv<number>(raw, 'surcharge'),
                    });
                    if (raw.json) {
                        console.log(JSON.stringify(result, null, 2));
                        process.exit(0);
                    }
                    const { filing, snapshot } = result;
                    console.log(`\nWeb-Abgabe erfasst — ${filing.entityId} ${filing.period} · ${filing.kind}`);
                    console.log(`  Abgegeben: ${filing.filedAt} · Transferticket: ${filing.note}`);
                    if (snapshot) {
                        console.log(
                            `  Snapshot: ${snapshot.id} (Status: ${snapshot.status}, Quelle: ${snapshot.submissionSource})`,
                        );
                        const fig = snapshot.figures as { headline?: Record<string, number> } | null;
                        if (fig?.headline && Object.keys(fig.headline).length > 0) {
                            console.log(
                                `  Kennzahlen: ${Object.entries(fig.headline)
                                    .map(([k, v]) => `${k}=${v}`)
                                    .join(' · ')}`,
                            );
                        }
                    } else {
                        console.log('  (kein Snapshot — est hat keinen ELSTER-XML-Builder; nur Register-Eintrag)');
                    }
                    console.log('');
                    process.exit(0);
                } catch (err) {
                    console.error(err instanceof Error ? err.message : err);
                    process.exit(1);
                }
            },
        }),
};
