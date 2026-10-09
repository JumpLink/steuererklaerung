import { join } from 'node:path';

import { validateUstvaXml, writeUstvaXml, buildUstvaEds } from '../../../core/elster/index.ts';
import { validateUstvaDetails } from '../../../core/actions/elster/validate.ts';
import { aggregateUstvaDerPeriode } from '../../../core/actions/elster/ustva.ts';
import { buildReportJson, printReport } from '../../../core/actions/elster/report.ts';
import { runEricValidateCommand } from '../../../core/actions/elster/eric-cli.ts';
import { ustvaToSteuerblatt, writeSteuerblattPdf } from '../../../core/actions/elster/steuerblatt-pdf.ts';
import { pickArgv } from '../output.ts';
import { parseElsterArgs } from './shared.ts';

import type { CommandModule as YargsCommandModule } from 'yargs';

/** `elster ustva` — USt-Voranmeldung: report, generate-xml, or validate-eric. */
export const ustvaSubcommand: YargsCommandModule = {
    command: 'ustva',
    describe: 'USt-VA: report, generate-xml, or validate-eric',
    handler: () => {},
    builder: (ustvaYargs) =>
        ustvaYargs
            .demandCommand(1, 'Choose: report, generate-xml, or validate-eric')
            .command({
                command: 'report',
                describe: 'List Paperless documents included in USt-VA for the configured period.',
                builder: (y) =>
                    y
                        .option('year', { type: 'number', describe: 'Override period year' })
                        .option('quarter', { type: 'number', describe: 'Override period quarter (1–4)' })
                        .option('month', { type: 'number', describe: 'Override period month (1–12)' })
                        .option('json', { type: 'boolean', describe: 'Output raw JSON', default: false })
                        .option('pdf', {
                            type: 'string',
                            describe: 'Prüf-Datenblatt als PDF in diese Datei schreiben',
                        }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const config = parseElsterArgs(raw);
                    const asJson = Boolean(raw.json);
                    try {
                        const result = await aggregateUstvaDerPeriode(config);
                        const pdfPath = pickArgv<string>(raw, 'pdf');
                        if (pdfPath != null) {
                            const p = config.period;
                            const slug =
                                p.month != null
                                    ? `${p.year}-${String(p.month).padStart(2, '0')}`
                                    : p.quarter != null
                                      ? `${p.year}-Q${p.quarter}`
                                      : `${p.year}`;
                            const out =
                                pdfPath ||
                                join(config.output_directory, `ustva-${config.entity_id}-${slug}-pruefblatt.pdf`);
                            console.log(
                                `PDF geschrieben: ${await writeSteuerblattPdf(
                                    ustvaToSteuerblatt(result.aggregate, config, {
                                        missingBmfRates: result.missingBmfRates,
                                    }),
                                    out,
                                )}`,
                            );
                        } else if (asJson) {
                            const jsonOut = await buildReportJson(result);
                            console.log(JSON.stringify(jsonOut, null, 2));
                        } else {
                            await printReport(result, config);
                        }
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'generate-xml',
                describe: 'Aggregate USt-VA data and write ELSTER-conformant XML.',
                builder: (y) =>
                    y
                        .option('year', { type: 'number', describe: 'Override period year' })
                        .option('quarter', { type: 'number', describe: 'Override period quarter (1–4)' })
                        .option('month', { type: 'number', describe: 'Override period month (1–12)' })
                        .option('output', {
                            type: 'string',
                            describe: 'Output file path (default: output_directory/ustva-YYYY-Qn.xml)',
                        }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const config = parseElsterArgs(raw);
                    const outputOverride = pickArgv<string>(raw, 'output');

                    try {
                        const result = await aggregateUstvaDerPeriode(config);
                        const detailsValidation = validateUstvaDetails(result);
                        const missingAll =
                            detailsValidation.missingRequiredOutgoing.length > 0 ||
                            detailsValidation.missingRequiredIncoming.length > 0;
                        if (missingAll) {
                            console.error(
                                'Required custom fields missing. Run paperless extract-invoice-fields and fix documents:',
                            );
                            if (detailsValidation.missingRequiredOutgoing.length > 0) {
                                console.error(
                                    `  Outgoing (total_net, tax_amount): #${detailsValidation.missingRequiredOutgoing.join(', #')}`,
                                );
                            }
                            if (detailsValidation.missingRequiredIncoming.length > 0) {
                                console.error(
                                    `  Incoming (tax_amount): #${detailsValidation.missingRequiredIncoming.join(', #')}`,
                                );
                            }
                            process.exit(1);
                        }
                        if (detailsValidation.missingQontoFields.length > 0) {
                            console.warn(
                                'Some documents have Qonto link but missing amount/currency on document (run sync match-qonto-paperless):',
                            );
                            for (const f of detailsValidation.missingQontoFields) {
                                console.warn(`  #${f.id}: ${f.title ?? '—'}`);
                            }
                        }
                        if (detailsValidation.currencySkipped.length > 0) {
                            console.warn('Invoice vs Qonto currency differs (amount comparison skipped):');
                            for (const c of detailsValidation.currencySkipped) {
                                console.warn(`  #${c.id}: invoice ${c.invoiceCurrency}, Qonto ${c.qontoCurrency}`);
                            }
                        }
                        if (detailsValidation.qontoMismatches.length > 0) {
                            console.warn('Qonto vs invoice amount mismatch (XML will still be generated):');
                            for (const m of detailsValidation.qontoMismatches) {
                                console.warn(
                                    `  #${m.id}: Qonto ${m.qontoAmount.toFixed(2)} € vs invoice ${m.invoiceAmount.toFixed(2)} €`,
                                );
                            }
                        }
                        if (result.missingBmfRates.length > 0) {
                            console.warn(
                                'Fremdwährungsbelege ohne BMF-Umrechnungskurs (ausgeschlossen — Kurs in bmf-umrechnungskurse.json ergänzen):',
                            );
                            for (const m of result.missingBmfRates) {
                                console.warn(`  #${m.id}: ${m.currency} ${m.month}`);
                            }
                        }
                        const outputPath = writeUstvaXml(result.aggregate, config, outputOverride);
                        const validation = validateUstvaXml(outputPath, config);
                        if (!validation.valid) {
                            console.error('XML validation failed:');
                            validation.errors.forEach((e) => console.error('  -', e));
                            process.exit(1);
                        }
                        console.log(`XML written to ${outputPath}`);
                        console.log('Validation passed.');
                        console.log(
                            'Next: Upload this file in Mein ELSTER (Umsatzsteuer-Voranmeldung → XML-Import), review, then send manually.',
                        );
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'validate-eric',
                describe: 'Validate USt-VA data using the ERiC library (plausibility checks).',
                builder: (y) =>
                    y
                        .option('year', { type: 'number', describe: 'Override period year' })
                        .option('quarter', { type: 'number', describe: 'Override period quarter (1–4)' })
                        .option('month', { type: 'number', describe: 'Override period month (1–12)' })
                        .option('xml', {
                            type: 'string',
                            describe: 'Path to existing XML file (skip aggregation)',
                        }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const config = parseElsterArgs(raw);
                    try {
                        await runEricValidateCommand({
                            xmlPath: pickArgv<string>(raw, 'xml'),
                            // Derive the datenartVersion from the XML namespace (e.g. "ustva/v2026");
                            // a freshly built EDS carries the config schema year in its namespace.
                            datenartVersion: (xml) => {
                                const nsMatch = xml.match(/ustva\/v(\d+)/);
                                return nsMatch ? `UStVA_${nsMatch[1]}` : `UStVA_${config.schema_version}`;
                            },
                            buildXml: async () => {
                                const result = await aggregateUstvaDerPeriode(config);
                                return buildUstvaEds(result.aggregate, config);
                            },
                        });
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            }),
};
