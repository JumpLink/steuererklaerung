/**
 * `zve` — query and record the zu versteuernde Einkommen per Veranlagungsjahr.
 *
 *   zve                                  every recorded year
 *   zve --jahr 2024                      one year (the Bescheid value)
 *   zve --jahr 2024 --schaetzung         the app's own Schätzung instead, clearly marked as one
 *   zve --jahr 2024 --json               machine-readable (for other programmes)
 *   zve record --jahr 2024 --betrag 12345 --beleg paperless:123
 *   zve suggest --beleg paperless:123    propose the value from the OCR text, apply it with --apply
 *   zve remove --jahr 2024
 *
 * Thin adapter: all logic lives in `core/actions/zve.ts`, so that the CLI, MCP and later a
 * D-Bus service deliver the same value with the same provenance.
 *
 * `--year` is the canonical option name (as in every other command); `--jahr` is its alias.
 */

import type { CommandModule } from 'yargs';
import { fmtDe } from '../../core/lib/money.ts';
import {
    getZvE,
    listZvE,
    recordZvE,
    removeZvE,
    suggestZvEFromDocument,
    type ZvEVorschlag,
    type ZvEWert,
} from '../../core/actions/zve.ts';
import { pickArgv, printJson } from './output.ts';

const HERKUNFT_LABEL: Record<string, string> = {
    bescheid: 'Bescheid',
    schaetzung: 'Schätzung (kein Bescheidwert)',
};

/**
 * One row. The entity is always printed: without `--entity` the LIST spans every entity (a household
 * may file per person), so two rows for the same year would otherwise be indistinguishable.
 */
function printWert(w: ZvEWert): void {
    const beleg = w.belegId ? ` · Beleg ${w.belegId}` : '';
    console.log(
        `  ${w.jahr}  ${fmtDe(w.betrag)} €  ${w.entityId}  [${HERKUNFT_LABEL[w.herkunft] ?? w.herkunft}]${beleg}`,
    );
    if (w.erfasstAm) console.log(`        erfasst am ${w.erfasstAm.slice(0, 10)}`);
    if (w.hinweis) console.log(`        ⚠ ${w.hinweis}`);
}

function printVorschlag(v: ZvEVorschlag): void {
    console.log(`\nBescheid ${v.belegId}`);
    console.log(`  Vorschlag zvE: ${v.betrag != null ? `${fmtDe(v.betrag)} €` : '— (nicht erkannt)'}`);
    console.log(`  Veranlagungsjahr laut Dokument: ${v.jahr ?? '—'}`);
    for (const t of v.treffer) console.log(`  Fundstelle: „${t.zeile}" → ${fmtDe(t.betrag)} €`);
    for (const h of v.hinweise) console.log(`  • ${h}`);
}

/** `--year`/`--jahr` as a number, or undefined. */
function yearArg(raw: Record<string, unknown>): number | undefined {
    const v = pickArgv<number>(raw, 'year', 'jahr');
    return v == null ? undefined : Number(v);
}

function entityArg(raw: Record<string, unknown>): string | undefined {
    const v = pickArgv<string>(raw, 'entity');
    return v == null ? undefined : String(v);
}

/** Run a synchronous body, print its error and exit non-zero on failure (house handler envelope). */
function handle(body: () => void): void {
    try {
        body();
        process.exit(0);
    } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
    }
}

export const zveCommand: CommandModule = {
    command: 'zve',
    describe:
        'Zu versteuerndes Einkommen (zvE) je Veranlagungsjahr — mit Herkunft (Bescheid vs. Schätzung) und Belegverweis',
    builder: (yargs) =>
        yargs
            .option('year', { type: 'number', alias: 'jahr', describe: 'Veranlagungsjahr, z. B. 2024' })
            .option('entity', { type: 'string', describe: 'Workspace-Entität (Vorgabe: die privat-Entität)' })
            .option('schaetzung', {
                type: 'boolean',
                default: false,
                describe: 'Ohne erfassten Bescheidwert die eigene ESt-Schätzung liefern (als Schätzung markiert)',
            })
            .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON' })
            .command({
                command: 'record',
                describe: 'Den zvE-Wert eines Jahres aus dem Einkommensteuerbescheid erfassen (oder ersetzen)',
                builder: (y) =>
                    y
                        .option('year', {
                            type: 'number',
                            alias: 'jahr',
                            demandOption: true,
                            describe: 'Veranlagungsjahr',
                        })
                        .option('betrag', {
                            type: 'number',
                            demandOption: true,
                            describe: 'Zu versteuerndes Einkommen laut Bescheid, in Euro',
                        })
                        .option('beleg', {
                            type: 'string',
                            describe: 'Belegverweis auf den Bescheid, z. B. paperless:2900 (dringend empfohlen)',
                        })
                        .option('notiz', { type: 'string', describe: 'Freitext, z. B. „Änderungsbescheid"' })
                        .option('entity', { type: 'string', describe: 'Workspace-Entität (Vorgabe: privat)' }),
                handler: (argv) =>
                    handle(() => {
                        const raw = argv as Record<string, unknown>;
                        const saved = recordZvE({
                            jahr: yearArg(raw) as number,
                            betrag: Number(raw.betrag),
                            entityId: entityArg(raw),
                            belegId: pickArgv<string>(raw, 'beleg'),
                            notiz: pickArgv<string>(raw, 'notiz'),
                        });
                        console.log('Erfasst:');
                        printWert(saved);
                    }),
            })
            .command({
                command: 'suggest',
                describe: 'zvE aus dem OCR-Text eines Paperless-Bescheids vorschlagen (mit --apply übernehmen)',
                builder: (y) =>
                    y
                        .option('beleg', {
                            type: 'string',
                            demandOption: true,
                            describe: 'Paperless-Dokument des Bescheids, z. B. paperless:2900',
                        })
                        .option('year', {
                            type: 'number',
                            alias: 'jahr',
                            describe: 'Veranlagungsjahr (Vorgabe: das im Bescheid genannte)',
                        })
                        .option('apply', {
                            type: 'boolean',
                            default: false,
                            describe: 'Den Vorschlag erfassen — nur bei eindeutigem Betrag und bekanntem Jahr',
                        })
                        .option('entity', { type: 'string', describe: 'Workspace-Entität (Vorgabe: privat)' }),
                handler: async (argv) => {
                    const raw = argv as Record<string, unknown>;
                    try {
                        const beleg = String(raw.beleg);
                        const vorschlag = await suggestZvEFromDocument(beleg);
                        printVorschlag(vorschlag);
                        const jahr = yearArg(raw) ?? vorschlag.jahr ?? undefined;
                        if (!raw.apply) {
                            console.log('  (Vorschau — mit --apply übernehmen)\n');
                            process.exit(0);
                        }
                        // Fail loud rather than write a guess: an unconfirmed figure recorded as a
                        // Bescheid value is exactly the error this feature exists to prevent.
                        if (vorschlag.betrag == null) {
                            throw new Error(
                                'Kein eindeutiger Betrag erkannt — bitte mit „zve record --betrag" erfassen.',
                            );
                        }
                        if (jahr == null) {
                            throw new Error('Kein Veranlagungsjahr erkannt — bitte mit --jahr angeben.');
                        }
                        const saved = recordZvE({
                            jahr,
                            betrag: vorschlag.betrag,
                            entityId: entityArg(raw),
                            belegId: beleg,
                        });
                        console.log('\nErfasst:');
                        printWert(saved);
                        process.exit(0);
                    } catch (err) {
                        console.error(err instanceof Error ? err.message : err);
                        process.exit(1);
                    }
                },
            })
            .command({
                command: 'remove',
                describe: 'Den erfassten zvE-Wert eines Jahres löschen',
                builder: (y) =>
                    y
                        .option('year', {
                            type: 'number',
                            alias: 'jahr',
                            demandOption: true,
                            describe: 'Veranlagungsjahr',
                        })
                        .option('entity', { type: 'string', describe: 'Workspace-Entität (Vorgabe: privat)' }),
                handler: (argv) =>
                    handle(() => {
                        const raw = argv as Record<string, unknown>;
                        const jahr = yearArg(raw) as number;
                        const removed = removeZvE(jahr, { entityId: entityArg(raw) });
                        console.log(removed ? `Gelöscht: ${jahr}` : `Kein Eintrag für ${jahr}.`);
                    }),
            }),
    // No subcommand: `--jahr` asks for one year, without it we list every recorded year.
    handler: (argv) =>
        handle(() => {
            const raw = argv as Record<string, unknown>;
            const jahr = yearArg(raw);
            const entityId = entityArg(raw);
            if (jahr != null) {
                const wert = getZvE(jahr, { entityId, fallback: raw.schaetzung ? 'schaetzung' : undefined });
                if (raw.json) return printJson(wert);
                if (!wert) {
                    console.log(
                        `Kein zvE für ${jahr} erfasst. Aus dem Bescheid übernehmen: ` +
                            `„zve record --jahr ${jahr} --betrag <euro> --beleg paperless:<id>"` +
                            `${raw.schaetzung ? '' : ' — oder --schaetzung für die eigene Schätzung.'}`,
                    );
                    return;
                }
                console.log('');
                printWert(wert);
                console.log('');
                return;
            }
            const werte = listZvE({ entityId });
            if (raw.json) return printJson(werte);
            if (werte.length === 0) {
                console.log(
                    'Noch kein zvE erfasst — „zve record --jahr <jahr> --betrag <euro> --beleg paperless:<id>".',
                );
                return;
            }
            console.log(`\nZu versteuerndes Einkommen (${werte.length} Jahr(e))\n`);
            for (const w of werte) printWert(w);
            console.log('');
        }),
};
