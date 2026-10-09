import { estReport, printEstReport } from '../../../core/actions/elster/est.ts';
import { buildEstPlan, printTaxReturnPlan } from '../../../core/actions/elster/wizard.ts';
import { runEricValidateCommand, printGenerateXmlResult } from '../../../core/actions/elster/eric-cli.ts';
import type { EstConfig } from '../../../core/config/schema/est.ts';
import { buildEstEds, estDatenartVersion, writeEstXml } from '../../../core/elster/est-xml.ts';
import { estToSteuerblatt, writeSteuerblattPdf } from '../../../core/actions/elster/steuerblatt-pdf.ts';
import {
    deriveEntlastungAlleinerziehende,
    applyEntlastungAlleinerziehende,
    deriveKinderbetreuung,
    applyKinderbetreuung,
    deriveHaushalt,
    applyHaushalt,
    deriveLohnersatz,
    applyLohnersatz,
} from '../../../core/actions/elster/est-intake.ts';
import { entlastungBetrag } from '../../../core/actions/elster/est-intake-topics.ts';
import { pickArgv } from '../output.ts';
import { accountKeysFrom, parseEstArgs } from './shared.ts';

import type { EstReport } from '../../../core/actions/elster/est.ts';
import type { CommandModule as YargsCommandModule } from 'yargs';

/**
 * Load the ESt config + report for the XML subcommands: `--entity` selects the manifest entity's
 * inline `est` section (else the default `privat` entity). `detail: true` is required — the E10
 * Einzelaufstellungen (Krankheitskosten, Spenden, §35a) are built from the per-transaction rows.
 */
function loadEstForXml(raw: Record<string, unknown>, year: number): { config: EstConfig; report: EstReport } {
    const config = parseEstArgs(raw);
    const report = estReport(config, year, { accountKeys: accountKeysFrom(raw), detail: true });
    return { config, report };
}

/** Trailing output shared by the `intake-*` subcommands: the derived Hinweise + the apply/preview footer. */
function printIntakeFooter(hinweise: string[], applied: boolean, appliedMsg: string): void {
    for (const h of hinweise) console.log(`  • ${h}`);
    console.log(applied ? appliedMsg : '  (Vorschau — mit --apply schreiben)');
}

/**
 * Envelope shared by the four sync `intake-*` handlers: read year + (privat-default) entity from argv,
 * run the topic body, then exit 0 — or print the error and exit 1. Leaves each handler its own
 * answers → derive/apply → print logic.
 */
function intakeHandler(
    body: (raw: Record<string, unknown>, year: number, entity: string) => void,
): (argv: unknown) => void {
    return (argv) => {
        const raw = argv as Record<string, unknown>;
        const year = pickArgv<number>(raw, 'year') as number;
        const entity = pickArgv<string>(raw, 'entity') ?? 'privat';
        try {
            body(raw, year, entity);
            process.exit(0);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    };
}

/** `elster est` — private Einkommensteuer estimate for a `privat` entity (store-only, a Schätzung). */
export const estSubcommand: YargsCommandModule = {
    command: 'est',
    describe: 'Private Einkommensteuer (Schätzung): Steuer-Themen, Abzüge und voraussichtliche Erstattung.',
    handler: () => {},
    builder: (y) =>
        y
            .demandCommand(1, 'Choose a subcommand: report, generate-xml, validate-eric')
            .command({
                command: 'report',
                describe: 'ESt-Schätzung für ein Jahr (Wasserfall + Steuer-Themen).',
                builder: (yy) =>
                    yy
                        .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
                        .option('entity', {
                            type: 'string',
                            describe:
                                'Privat-Entität aus steuererklaerung.json (z. B. privat) — wählt deren est_config + Konten',
                        })
                        .option('account-key', { type: 'array', describe: 'Private account(s) to include' })
                        .option('detail', { type: 'boolean', default: false, describe: 'Include the plan as well' })
                        .option('json', { type: 'boolean', default: false, describe: 'Output the raw report as JSON' }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const year = pickArgv<number>(raw, 'year') as number;
                    try {
                        // --entity selects the manifest entity's inline `est` section (else default privat).
                        const config = parseEstArgs(raw);
                        const report = estReport(config, year, {
                            accountKeys: accountKeysFrom(raw),
                            detail: !!raw.detail,
                        });
                        if (raw.json) console.log(JSON.stringify(report, null, 2));
                        else {
                            printEstReport(report);
                            if (raw.detail)
                                printTaxReturnPlan(buildEstPlan(config, year, { accountKeys: accountKeysFrom(raw) }));
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
                describe: 'Generate the Einkommensteuererklärung (E10) EDS XML for ERiC validation.',
                builder: (yy) =>
                    yy
                        .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
                        .option('entity', {
                            type: 'string',
                            describe: 'Privat-Entität aus steuererklaerung.json (z. B. privat)',
                        })
                        .option('account-key', { type: 'array', describe: 'Private account(s) to include' })
                        .option('output', { type: 'string', describe: 'Output path' }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const year = pickArgv<number>(raw, 'year') as number;
                    try {
                        const { config, report } = loadEstForXml(raw, year);
                        const file = writeEstXml(
                            config,
                            report.inputs,
                            report.aggregate,
                            pickArgv<string>(raw, 'output'),
                        );
                        printGenerateXmlResult('est', file, year);
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'pruefblatt',
                describe: 'ESt-Prüf-Datenblatt (PDF): Wasserfall Einkünfte → zvE → festzusetzende ESt → Erstattung.',
                builder: (yy) =>
                    yy
                        .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
                        .option('entity', {
                            type: 'string',
                            describe: 'Privat-Entität aus steuererklaerung.json (z. B. privat)',
                        })
                        .option('account-key', { type: 'array', describe: 'Private account(s) to include' })
                        .option('output', { type: 'string', describe: 'Output path' }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const year = pickArgv<number>(raw, 'year') as number;
                    try {
                        const { config, report } = loadEstForXml(raw, year);
                        const out = pickArgv<string>(raw, 'output') ?? `est-${report.entityId}-${year}-pruefblatt.pdf`;
                        console.log(
                            `PDF geschrieben: ${await writeSteuerblattPdf(estToSteuerblatt(report, config), out)}`,
                        );
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'intake-entlastung',
                describe:
                    'Wizard-Intake §24b Alleinerziehende: Klartext-Antworten → abgeleitete Config (monate/weitere Kinder). Demo/Kern der Steuer-Wizard-Naht.',
                builder: (yy) =>
                    yy
                        .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
                        .option('entity', { type: 'string', describe: 'Privat-Entität (Vorgabe: privat)' })
                        .option('von', {
                            type: 'string',
                            describe: 'Erster Monat alleinerziehend YYYY-MM (leer=Januar)',
                        })
                        .option('bis', { type: 'string', describe: 'Letzter Monat YYYY-MM (leer=Dezember)' })
                        .option('kind', { type: 'string', describe: 'IdNr des Kindes im Haushalt (Grundbetrag)' })
                        .option('weitere', { type: 'number', default: 0, describe: 'Weitere Kinder im Haushalt' })
                        .option('andere-person', {
                            type: 'boolean',
                            default: false,
                            describe: 'Andere volljährige Person im Haushalt → §24b entfällt',
                        })
                        .option('nicht-alleinerziehend', {
                            type: 'boolean',
                            default: false,
                            describe: 'Explizit KEIN §24b (setzt auf 0)',
                        })
                        .option('apply', {
                            type: 'boolean',
                            default: false,
                            describe: 'Ergebnis in die Config schreiben',
                        }),
                handler: intakeHandler((raw, year, entity) => {
                    const answers = {
                        alleinstehendMitKind: !raw['nicht-alleinerziehend'],
                        von: pickArgv<string>(raw, 'von'),
                        bis: pickArgv<string>(raw, 'bis'),
                        kindIdnr: pickArgv<string>(raw, 'kind'),
                        weitereKinder: Number(raw.weitere ?? 0),
                        andererVolljaehrigerImHaushalt: !!raw['andere-person'],
                    };
                    const derived = raw.apply
                        ? applyEntlastungAlleinerziehende(entity, year, answers)
                        : deriveEntlastungAlleinerziehende(answers);
                    const betrag = entlastungBetrag(derived.monate, derived.weitere_kinder);
                    console.log(
                        `§24b Entlastungsbetrag ${year} (${entity}): ${derived.monate} Monat(e), ${derived.weitere_kinder} weitere Kind(er) → ${betrag} €`,
                    );
                    printIntakeFooter(
                        derived.hinweise,
                        !!raw.apply,
                        '  ✓ in die Config geschrieben (entlastung_alleinerziehende).',
                    );
                }),
            })
            .command({
                command: 'intake-kinderbetreuung',
                describe:
                    'Wizard-Intake Kinderbetreuung (§10 Nr. 5) mit Aufteilung getrennter Eltern (Doppelabzug-Guard).',
                builder: (yy) =>
                    yy
                        .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
                        .option('entity', { type: 'string', describe: 'Privat-Entität (Vorgabe: privat)' })
                        .option('kind', { type: 'string', demandOption: true, describe: 'IdNr des Kindes' })
                        .option('betrag', { type: 'number', describe: 'Gesamtbetrag im Jahr (beide Eltern zusammen)' })
                        .option('abzug', {
                            type: 'string',
                            choices: ['ich', 'anderer', 'haelftig'],
                            default: 'ich',
                            describe: 'Wer zieht ab (nur einmal je Kind über beide Eltern)',
                        })
                        .option('dienstleister', { type: 'string', describe: 'Name der Kita/Einrichtung' })
                        .option('von', { type: 'string', describe: 'Zeitraum von TT.MM' })
                        .option('bis', { type: 'string', describe: 'Zeitraum bis TT.MM' })
                        .option('kind-im-haushalt', { type: 'boolean', default: true })
                        .option('keine-kosten', { type: 'boolean', default: false, describe: 'Explizit keine Kosten' })
                        .option('apply', {
                            type: 'boolean',
                            default: false,
                            describe: 'Ergebnis in die Config schreiben',
                        }),
                handler: intakeHandler((raw, year, entity) => {
                    const kindIdnr = pickArgv<string>(raw, 'kind') as string;
                    const answers = {
                        hatKosten: !raw['keine-kosten'],
                        dienstleister: pickArgv<string>(raw, 'dienstleister'),
                        betragGesamt: raw.betrag != null ? Number(raw.betrag) : undefined,
                        zeitraumVon: pickArgv<string>(raw, 'von'),
                        zeitraumBis: pickArgv<string>(raw, 'bis'),
                        kindImHaushalt: raw['kind-im-haushalt'] !== false,
                        abzug: (pickArgv<string>(raw, 'abzug') ?? 'ich') as 'ich' | 'anderer' | 'haelftig',
                    };
                    const derived = raw.apply
                        ? applyKinderbetreuung(entity, year, kindIdnr, answers)
                        : deriveKinderbetreuung(answers);
                    if (derived.eintrag) {
                        const abzug80 = Math.round(derived.eintrag.von_mir * 0.8);
                        console.log(
                            `Kinderbetreuung ${year} Kind ${kindIdnr}: Gesamt ${derived.eintrag.betrag} €, dein Anteil ${derived.eintrag.von_mir} € → 80 % = ${abzug80} € Abzug`,
                        );
                    } else {
                        console.log(`Kinderbetreuung ${year} Kind ${kindIdnr}: kein Abzug bei dir.`);
                    }
                    printIntakeFooter(derived.hinweise, !!raw.apply, '  ✓ in die Config geschrieben.');
                }),
            })
            .command({
                command: 'intake-haushalt',
                describe:
                    'Wizard-Intake Haushalts-/Trennungs-Zeitachse (pro Kind): EINE Zeitachse → KBK-Haushaltsblock + §24b-Monate.',
                builder: (yy) =>
                    yy
                        .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
                        .option('entity', { type: 'string', describe: 'Privat-Entität (Vorgabe: privat)' })
                        .option('kind', { type: 'string', demandOption: true, describe: 'IdNr des Kindes' })
                        .option('keine-trennung', {
                            type: 'boolean',
                            default: false,
                            describe: 'Ganzjährig gemeinsamer Haushalt (keine Trennung im Jahr)',
                        })
                        .option('getrennt-ab', {
                            type: 'string',
                            describe: 'Erster Monat der Trennung YYYY-MM (leer=Januar)',
                        })
                        .option('getrennt-bis', { type: 'string', describe: 'Letzter Monat YYYY-MM (leer=Dezember)' })
                        .option('kind-bei', {
                            type: 'string',
                            choices: ['ich', 'anderer'],
                            default: 'ich',
                            describe: 'Bei wem das Kind während der Trennung lebte',
                        })
                        .option('kind-gemeinsam', {
                            type: 'boolean',
                            default: true,
                            describe: 'Kind gehörte im gemeinsamen Haushalt zum Haushalt',
                        })
                        .option('set-entlastung', {
                            type: 'boolean',
                            default: false,
                            describe:
                                'Die abgeleiteten §24b-Monate zusätzlich in entlastung_alleinerziehende schreiben',
                        })
                        .option('apply', {
                            type: 'boolean',
                            default: false,
                            describe: 'Ergebnis in die Config schreiben',
                        }),
                handler: intakeHandler((raw, year, entity) => {
                    const kindIdnr = pickArgv<string>(raw, 'kind') as string;
                    const answers = {
                        getrenntGelebt: !raw['keine-trennung'],
                        getrenntAb: pickArgv<string>(raw, 'getrennt-ab'),
                        getrenntBis: pickArgv<string>(raw, 'getrennt-bis'),
                        kindBeiWem: (pickArgv<string>(raw, 'kind-bei') ?? 'ich') as 'ich' | 'anderer',
                        kindImGemeinsamenHaushalt: raw['kind-gemeinsam'] !== false,
                    };
                    const derived = raw.apply
                        ? applyHaushalt(entity, year, kindIdnr, answers)
                        : deriveHaushalt(answers, year);
                    console.log(`Haushalt ${year} Kind ${kindIdnr}:`);
                    for (const [k, v] of Object.entries(derived.haushalt ?? {})) console.log(`  ${k}: ${v}`);
                    console.log(`  → §24b: ${derived.alleinstehend_monate} Monat(e) alleinstehend`);
                    for (const h of derived.hinweise) console.log(`  • ${h}`);
                    // The §24b months come from the SAME timeline; chain them into the §24b writer on request
                    // (no second writer here — the tested path stays the only §24b seam).
                    if (raw.apply && raw['set-entlastung']) {
                        applyEntlastungAlleinerziehende(entity, year, {
                            alleinstehendMitKind: derived.alleinstehend_monate > 0,
                            von: derived.alleinstehend_von,
                            bis: derived.alleinstehend_bis,
                            kindIdnr,
                        });
                        console.log(
                            `  ✓ §24b-Monate (${derived.alleinstehend_monate}) in entlastung_alleinerziehende übernommen.`,
                        );
                    }
                    console.log(
                        raw.apply
                            ? '  ✓ Haushaltsblock in die Config geschrieben.'
                            : '  (Vorschau — mit --apply schreiben)',
                    );
                }),
            })
            .command({
                command: 'intake-lohnersatz',
                describe:
                    'Wizard-Intake §32b Lohnersatzleistungen (Elterngeld …) inkl. Rückzahlung (Abflussprinzip) → Netto-Progressionsvorbehalt.',
                builder: (yy) =>
                    yy
                        .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
                        .option('entity', { type: 'string', describe: 'Privat-Entität (Vorgabe: privat)' })
                        .option('erhalten', { type: 'number', default: 0, describe: 'Im Jahr zugeflossen (€)' })
                        .option('zurueckgezahlt', { type: 'number', default: 0, describe: 'Im Jahr zurückgezahlt (€)' })
                        .option('art', { type: 'string', describe: 'Art der Leistung (Elterngeld, ALG …)' })
                        .option('keine', {
                            type: 'boolean',
                            default: false,
                            describe: 'Explizit keine Lohnersatzleistungen',
                        })
                        .option('apply', {
                            type: 'boolean',
                            default: false,
                            describe: 'Ergebnis in die Config schreiben',
                        }),
                handler: intakeHandler((raw, year, entity) => {
                    const answers = {
                        hatLohnersatz:
                            !raw.keine && (Number(raw.erhalten ?? 0) > 0 || Number(raw.zurueckgezahlt ?? 0) > 0),
                        erhalten: Number(raw.erhalten ?? 0),
                        zurueckgezahlt: Number(raw.zurueckgezahlt ?? 0),
                        art: pickArgv<string>(raw, 'art'),
                    };
                    const derived = raw.apply ? applyLohnersatz(entity, year, answers) : deriveLohnersatz(answers);
                    console.log(
                        `§32b Lohnersatz ${year} (${entity}): erhalten ${derived.erhalten} € − zurückgezahlt ${derived.zurueckgezahlt} € = netto ${derived.netto} €`,
                    );
                    printIntakeFooter(derived.hinweise, !!raw.apply, '  ✓ in die Config geschrieben (lohnersatz).');
                }),
            })
            .command({
                command: 'validate-eric',
                describe: 'Validate the Einkommensteuererklärung (E10) XML with the local ERiC library.',
                builder: (yy) =>
                    yy
                        .option('year', { type: 'number', demandOption: true, describe: 'Tax year, e.g. 2025' })
                        .option('entity', {
                            type: 'string',
                            describe: 'Privat-Entität aus steuererklaerung.json (z. B. privat)',
                        })
                        .option('account-key', { type: 'array', describe: 'Private account(s) to include' })
                        .option('xml', { type: 'string', describe: 'Path to an existing XML file (skip generation)' }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    const year = pickArgv<number>(raw, 'year') as number;
                    try {
                        await runEricValidateCommand({
                            xmlPath: pickArgv<string>(raw, 'xml'),
                            datenartVersion: estDatenartVersion(year),
                            buildXml: () => {
                                const { config, report } = loadEstForXml(raw, year);
                                return buildEstEds(config, report.inputs, report.aggregate);
                            },
                        });
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            }),
};
