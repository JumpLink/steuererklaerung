/**
 * `buchungen` — the „Zu prüfen" queue without the app: the bookings nothing classified and the ones
 * only an Auffangregel caught, each with the rule that matched. `buchungen bestaetigen <id>` records
 * the current category as checked (the EÜR does not change); umbuchen happens in the app or through the
 * MCP tool `record_classification`. `--json` gives the raw rows (incl. `matchedRule`).
 *
 * `buchungen erstattungen` lists the incoming payments that may refund an earlier debit (Idee 9) with
 * their candidates; `buchungen erstattung <id> --ja|--nein <original>` or `--loesen` decides.
 *
 * `buchungen aufteilungen` lists the split bookings (Idee 13); `buchungen aufteilen <id> --teil …`
 * splits one, `--bewirtung` takes the 70/30 preset, `--aufheben` undoes it. In a filed period both
 * need `--trotz-abgabe`.
 */

import type { CommandModule } from 'yargs';
import { createPresenterSession } from '../../core/presenters/session.ts';
import { confirmZuPruefen, loadZuPruefen, type ZuPruefenRow } from '../../core/presenters/zu-pruefen.ts';
import { GRUND_TEXT, zuPruefenTitel } from '../../core/elster/zu-pruefen.ts';
import {
    erstattungenTitel,
    lehneErstattungAb,
    loadErstattungen,
    loeseErstattung,
    verknuepfeErstattung,
    type ErstattungenData,
} from '../../core/presenters/erstattungen.ts';
import {
    aufteilungAnsicht,
    aufteilungTitel,
    bewirtungsTeile,
    hebeAufteilungAuf,
    listeAufteilungen,
    speichereAufteilung,
} from '../../core/presenters/aufteilung.ts';
import { teilAusText } from '../../core/elster/splitbuchung.ts';
import type { EuerTeilZeile } from '../../core/elster/euer-transactions.ts';
import type { EntityModel } from '../../core/presenters/workspace.ts';
import { fmtDe } from '../../core/lib/money.ts';
import { ensureDemoSeeded } from './demo.ts';
import { runAndExit } from './output.ts';

function pickEntity(entities: EntityModel[], wanted?: string): EntityModel {
    const entity = wanted ? entities.find((e) => e.id === wanted) : (entities.find((e) => !!e.elster) ?? entities[0]);
    if (!entity) {
        throw new Error(
            wanted
                ? `Unbekannte Entität '${wanted}'. Bekannt: ${entities.map((e) => e.id).join(', ') || '—'}`
                : 'Keine Entität in steuererklaerung.json.',
        );
    }
    return entity;
}

function print(rows: ZuPruefenRow[]): void {
    if (rows.length === 0) {
        console.log('Alles geprüft — keine Buchung zu prüfen.');
        return;
    }
    console.log(`${zuPruefenTitel(rows.length)}\n`);
    for (const r of rows) {
        const who = (r.counterparty?.trim() || r.purpose?.trim() || '—').slice(0, 32).padEnd(32);
        console.log(`  ${r.bookingDate}  ${fmtDe(r.amount).padStart(11)} €  ${who}  ${GRUND_TEXT[r.grund]}`);
        const was = r.grund === 'unklassifiziert' ? 'weder Beleg noch Regel' : `${r.category} · ${r.herkunft}`;
        console.log(`      ${was}   [${r.id}]`);
    }
    console.log('\n→ bestätigen: buchungen bestaetigen <id>   (unklassifizierte bitte umbuchen)');
}

function printErstattungen(d: ErstattungenData): void {
    if (d.offen.length === 0) console.log(`Keine Erstattung zuzuordnen (${d.year}).`);
    else console.log(`${erstattungenTitel(d.offen.length)} (${d.year})\n`);
    for (const o of d.offen) {
        console.log(`  ${o.zeile}   [${o.buchung.id}]`);
        console.log('      Gehört das zu dieser Zahlung?');
        for (const k of o.kandidaten) {
            const art = k.exakt ? 'gleicher Betrag' : `Teilerstattung, offen ${fmtDe(k.offen)} €`;
            const zweck = k.zweckTreffer ? ' · Verwendungszweck passt' : '';
            console.log(`      · ${k.zeile} — ${k.category} (${art}${zweck})   [${k.id}]`);
        }
    }
    if (d.verknuepft.length > 0) {
        console.log('\nVerknüpft:');
        for (const v of d.verknuepft) console.log(`  ${v.zeile} → ${v.ursprung}   [${v.buchung.id}]`);
    }
    if (d.offen.length > 0) console.log('\n→ buchungen erstattung <id> --ja <kandidat> | --nein <kandidat>');
}

function teilZeile(p: EuerTeilZeile): string {
    const satz = `${Math.round(p.vatRate * 100)} %`;
    const rest = p.rest ? ' (Rest)' : '';
    const privat = p.betrieblich ? '' : ' · privat, keine Vorsteuer';
    return `      ${p.nr}. ${fmtDe(p.betrag).padStart(10)} €  ${p.category} · ${satz}${rest}${privat}`;
}

function printAufteilungen(rows: Awaited<ReturnType<typeof listeAufteilungen>>): void {
    if (rows.length === 0) {
        console.log('Keine Buchung aufgeteilt.');
        return;
    }
    for (const r of rows) {
        const who = (r.counterparty?.trim() || r.purpose?.trim() || '—').slice(0, 32);
        console.log(
            `  ${r.bookingDate}  ${fmtDe(r.amount).padStart(11)} €  ${who} — ${aufteilungTitel(r.teile.length)}   [${r.id}]`,
        );
        for (const p of r.teile) console.log(teilZeile(p));
    }
    console.log('\n→ buchungen aufteilen <id> --aufheben');
}

/**
 * A write refused in a filed period becomes an error (exit 1) with the warning — unless `--json`
 * asked for the raw result.
 */
function abgelehntAlsFehler<T>(r: T, json: boolean): T {
    const b = r as { bestaetigungNoetig?: boolean; warnung?: string };
    if (b.bestaetigungNoetig && !json) {
        throw new Error(`${b.warnung}\n→ Nichts geändert. Zum Ändern trotzdem: --trotz-abgabe`);
    }
    return r;
}

function printAufteilungErgebnis(v: unknown): void {
    const r = v as {
        ok: boolean;
        danach?: string | null;
        doppelzaehlung?: string | null;
        teile?: Array<Omit<EuerTeilZeile, 'kz' | 'gross'>>;
    };
    if (r.teile) {
        console.log(`Aufgeteilt in ${r.teile.length} Teile:`);
        for (const p of r.teile) console.log(teilZeile({ ...p, kz: '', gross: p.betrag }));
    } else console.log(r.ok ? 'Aufteilung aufgehoben.' : 'Die Buchung war nicht aufgeteilt.');
    if (r.danach) console.log(r.danach);
    if (r.doppelzaehlung) console.log(`Hinweis: ${r.doppelzaehlung}`);
}

const commonOptions = {
    entity: { type: 'string', describe: 'Entität aus steuererklaerung.json (Standard: erste Firma)' },
    year: { type: 'number', describe: 'Jahr (Standard: laufendes Jahr)' },
} as const;

export const buchungenCommand: CommandModule = {
    command: 'buchungen',
    describe: 'Buchungen „Zu prüfen": unklassifiziert oder nur von einer Auffangregel erfasst',
    builder: (y) =>
        y
            .command({
                command: ['zu-pruefen', '$0'],
                describe: 'Die Buchungen zu prüfen, mit der Regel, die gegriffen hat',
                builder: (yy) =>
                    yy
                        .options(commonOptions)
                        .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
                handler: (argv) =>
                    runAndExit(
                        async () => {
                            await ensureDemoSeeded();
                            const session = createPresenterSession();
                            const entity = pickEntity(session.workspace.entities, argv.entity as string | undefined);
                            const year = (argv.year as number | undefined) ?? new Date().getFullYear();
                            return (await loadZuPruefen(session, entity, year)).rows;
                        },
                        { print: argv.json ? (v) => console.log(JSON.stringify(v, null, 2)) : print },
                    ),
            })
            .command({
                command: 'bestaetigen <id>',
                describe: 'Die aktuelle Kategorie einer Buchung als geprüft bestätigen (ändert die EÜR nicht)',
                builder: (yy) =>
                    yy
                        .positional('id', { type: 'string', demandOption: true, describe: 'Transaktions-ID' })
                        .options(commonOptions),
                handler: (argv) =>
                    runAndExit(async () => {
                        await ensureDemoSeeded();
                        const session = createPresenterSession();
                        const entity = pickEntity(session.workspace.entities, argv.entity as string | undefined);
                        const year = (argv.year as number | undefined) ?? new Date().getFullYear();
                        return confirmZuPruefen(session, entity, year, String(argv.id), 'cli');
                    }),
            })
            .command({
                command: 'erstattungen',
                describe: 'Eingänge, die eine frühere Zahlung erstatten könnten, mit ihren Kandidaten',
                builder: (yy) =>
                    yy
                        .options(commonOptions)
                        .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
                handler: (argv) =>
                    runAndExit(
                        async () => {
                            await ensureDemoSeeded();
                            const session = createPresenterSession();
                            const entity = pickEntity(session.workspace.entities, argv.entity as string | undefined);
                            const year = (argv.year as number | undefined) ?? new Date().getFullYear();
                            return loadErstattungen(session, entity, year);
                        },
                        { print: argv.json ? (v) => console.log(JSON.stringify(v, null, 2)) : printErstattungen },
                    ),
            })
            .command({
                command: 'erstattung <id>',
                describe:
                    'Eine Erstattung zuordnen (--ja <kandidat>: erbt Kategorie und USt-Satz), einen Kandidaten ablehnen (--nein) oder die Verknüpfung lösen (--loesen)',
                builder: (yy) =>
                    yy
                        .positional('id', {
                            type: 'string',
                            demandOption: true,
                            describe: 'Transaktions-ID des Eingangs',
                        })
                        .options(commonOptions)
                        .option('ja', { type: 'string', describe: 'Transaktions-ID der Ursprungsbuchung' })
                        .option('nein', { type: 'string', describe: 'Transaktions-ID des abgelehnten Kandidaten' })
                        .option('loesen', { type: 'boolean', default: false, describe: 'Verknüpfung lösen' }),
                handler: (argv) =>
                    runAndExit(async () => {
                        const ja = argv.ja as string | undefined;
                        const nein = argv.nein as string | undefined;
                        const loesen = Boolean(argv.loesen);
                        if ([ja != null, nein != null, loesen].filter(Boolean).length !== 1) {
                            throw new Error('Genau eines angeben: --ja <kandidat>, --nein <kandidat> oder --loesen.');
                        }
                        await ensureDemoSeeded();
                        const session = createPresenterSession();
                        const entity = pickEntity(session.workspace.entities, argv.entity as string | undefined);
                        const year = (argv.year as number | undefined) ?? new Date().getFullYear();
                        const id = String(argv.id);
                        if (ja != null) return verknuepfeErstattung(session, entity, year, id, ja, 'cli');
                        if (nein != null) return lehneErstattungAb(session, entity, year, id, nein, 'cli');
                        return loeseErstattung(session, entity, id);
                    }),
            })
            .command({
                command: 'aufteilungen',
                describe: 'Die aufgeteilten Buchungen (Splitbuchungen) mit ihren Teilen',
                builder: (yy) =>
                    yy
                        .options(commonOptions)
                        .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
                handler: (argv) =>
                    runAndExit(
                        async () => {
                            await ensureDemoSeeded();
                            const session = createPresenterSession();
                            const entity = pickEntity(session.workspace.entities, argv.entity as string | undefined);
                            const year = (argv.year as number | undefined) ?? new Date().getFullYear();
                            return listeAufteilungen(session, entity, year);
                        },
                        { print: argv.json ? (v) => console.log(JSON.stringify(v, null, 2)) : printAufteilungen },
                    ),
            })
            .command({
                command: 'aufteilen <id>',
                describe:
                    'Eine Buchung in Teile aufteilen (--teil "Kategorie=Betrag@Satz", ein Teil ohne Betrag nimmt den Rest), die Vorlage Bewirtung 70/30 nehmen (--bewirtung) oder die Aufteilung aufheben (--aufheben)',
                builder: (yy) =>
                    yy
                        .positional('id', { type: 'string', demandOption: true, describe: 'Transaktions-ID' })
                        .options(commonOptions)
                        .option('teil', {
                            type: 'string',
                            array: true,
                            describe: 'Ein Teil: "4930=59,50@19"; ohne Betrag der Rest: "1800 Privatentnahme"',
                        })
                        .option('bewirtung', {
                            type: 'boolean',
                            default: false,
                            describe: '70 % Bewirtungskosten, Rest nicht abziehbar (Vorsteuer voll)',
                        })
                        .option('satz', { type: 'number', describe: 'Steuersatz in % für --bewirtung (Standard 19)' })
                        .option('aufheben', { type: 'boolean', default: false, describe: 'Aufteilung aufheben' })
                        .option('trotz-abgabe', {
                            type: 'boolean',
                            default: false,
                            describe: 'Auch ändern, wenn der Zeitraum schon eingereicht ist (Berichtigung nötig)',
                        })
                        .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
                handler: (argv) =>
                    runAndExit(
                        async () => {
                            const teile = (argv.teil as string[] | undefined) ?? [];
                            const bewirtung = Boolean(argv.bewirtung);
                            const aufheben = Boolean(argv.aufheben);
                            if ([teile.length > 0, bewirtung, aufheben].filter(Boolean).length > 1) {
                                throw new Error('Nur eines angeben: --teil …, --bewirtung oder --aufheben.');
                            }
                            await ensureDemoSeeded();
                            const session = createPresenterSession();
                            const entity = pickEntity(session.workspace.entities, argv.entity as string | undefined);
                            const year = (argv.year as number | undefined) ?? new Date().getFullYear();
                            const id = String(argv.id);
                            const opts = { trotzAbgabe: Boolean(argv['trotz-abgabe']), decidedBy: 'cli' };
                            const json = Boolean(argv.json);
                            if (aufheben)
                                return abgelehntAlsFehler(
                                    await hebeAufteilungAuf(session, entity, year, id, opts),
                                    json,
                                );
                            if (bewirtung || teile.length > 0) {
                                const ansicht = await aufteilungAnsicht(session, entity, year, id);
                                const satz = argv.satz != null ? Number(argv.satz) / 100 : (ansicht.belegSatz ?? 0.19);
                                const eingaben = bewirtung
                                    ? bewirtungsTeile(ansicht.amount, satz)
                                    : teile.map(teilAusText);
                                return abgelehntAlsFehler(
                                    await speichereAufteilung(session, entity, year, id, eingaben, opts),
                                    json,
                                );
                            }
                            return aufteilungAnsicht(session, entity, year, id);
                        },
                        {
                            print: argv.json
                                ? (v) => console.log(JSON.stringify(v, null, 2))
                                : (v) => {
                                      const a = v as {
                                          kategorien?: unknown;
                                          teile?: EuerTeilZeile[] | null;
                                          danach?: string | null;
                                          abgaben?: { label: string }[];
                                      };
                                      if (a.kategorien) {
                                          if (!a.teile) console.log('Nicht aufgeteilt.');
                                          else for (const p of a.teile) console.log(teilZeile(p));
                                          if (a.danach) console.log(a.danach);
                                          if (a.abgaben?.length) {
                                              console.log(
                                                  `Schon eingereicht: ${a.abgaben.map((x) => x.label).join(', ')}`,
                                              );
                                          }
                                          return;
                                      }
                                      printAufteilungErgebnis(v);
                                  },
                        },
                    ),
            }),
    handler: () => {},
};
