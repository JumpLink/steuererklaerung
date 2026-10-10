/**
 * `belege` — Dokumentregeln (Idee 11) without the app: what a sender's paper is, remembered once.
 *
 * `belege regeln` lists the rules of an entity's built-in DMS; `belege regel-merken` adds one (from
 * values or `--aus-beleg <id>`), `belege regel-entfernen` drops it (receipts keep what it set).
 * `belege hinzufuegen <datei…>` stores receipts through the same path as the app, so a rule applies on
 * arrival — before any AI. `belege herkunft <id>` says where a receipt's fields came from: the stored
 * rule (built-in DMS) or the Paperless rule that most likely assigned them; `belege zuruecknehmen <id>`
 * takes a rule's values off one receipt. `belege mail-konfig|mail-passwort|mail-abruf` fetch receipts from a
 * mail folder (Idee 15, `mail-eingang.ts`).
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { CommandModule } from 'yargs';
import {
    loadDokumentRegeln,
    nimmDokumentRegelZurueck,
    rememberDokumentRegel,
    removeDokumentRegel,
} from '../../core/actions/dokumentregeln.ts';
import { storeReceipt } from '../../core/actions/documents.ts';
import { paperlessZuordnungForEntity } from '../../core/actions/paperless/zuordnung.ts';
import { herkunftSatz, regelZeile, type DokumentRegel } from '../../core/dokumentregeln/regeln.ts';
import { createPresenterSession } from '../../core/presenters/session.ts';
import type { EntityModel } from '../../core/presenters/workspace.ts';
import { ensureDemoSeeded } from './demo.ts';
import { mailAbrufModule, mailKonfigModule, mailPasswortModule } from './mail-eingang.ts';
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

const commonOptions = {
    entity: { type: 'string', describe: 'Entität aus steuererklaerung.json (Standard: erste Firma)' },
} as const;

const jsonOption = { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' } as const;

async function setup(
    wanted: unknown,
): Promise<{ session: ReturnType<typeof createPresenterSession>; entity: EntityModel }> {
    await ensureDemoSeeded();
    const session = createPresenterSession();
    return { session, entity: pickEntity(session.workspace.entities, wanted as string | undefined) };
}

function printRules(rules: DokumentRegel[]): void {
    if (rules.length === 0) {
        console.log('Keine Dokumentregeln. Anlegen: belege regel-merken <muster> --dokumenttyp … --kategorie …');
        return;
    }
    console.log(`${rules.length} Dokumentregel${rules.length === 1 ? '' : 'n'} (die erste passende gilt):\n`);
    for (const r of rules) console.log(`  ${regelZeile(r)}`);
}

export const belegeCommand: CommandModule = {
    command: 'belege',
    describe: 'Dokumentregeln: Absender → Dokumenttyp, Kategorie, Richtung — ohne KI',
    builder: (y) =>
        y
            .command({
                command: ['regeln', '$0'],
                describe: 'Die Dokumentregeln der Entität auflisten',
                builder: (yy) => yy.options(commonOptions).option('json', jsonOption),
                handler: (argv) =>
                    runAndExit(
                        async () => {
                            const { entity } = await setup(argv.entity);
                            return loadDokumentRegeln(entity.id);
                        },
                        { print: argv.json ? (v) => console.log(JSON.stringify(v, null, 2)) : printRules },
                    ),
            })
            .command({
                command: 'regel-merken [muster]',
                describe:
                    'Eine Dokumentregel merken: Belege mit diesem Text (Absender, Titel, Dateiname, PDF-Text) bekommen die Werte; mit --aus-beleg aus den Werten eines Belegs',
                builder: (yy) =>
                    yy
                        .positional('muster', {
                            type: 'string',
                            describe: 'Text, den der Beleg enthält (Standard mit --aus-beleg: dessen Korrespondent)',
                        })
                        .options(commonOptions)
                        .option('aus-beleg', { type: 'string', describe: 'Beleg-ID, deren Werte die Regel übernimmt' })
                        .option('korrespondent', { type: 'string', describe: 'Absender, wie er am Beleg stehen soll' })
                        .option('dokumenttyp', { type: 'string', describe: 'Dokumenttyp, z. B. Rechnung' })
                        .option('kategorie', { type: 'string', describe: 'Kategorie, z. B. "4921 Telefon/Internet"' })
                        .option('richtung', {
                            type: 'string',
                            choices: ['incoming', 'outgoing'],
                            describe: 'incoming = Ausgabe, outgoing = Einnahme',
                        }),
                handler: (argv) =>
                    runAndExit(async () => {
                        const { session, entity } = await setup(argv.entity);
                        const regel: DokumentRegel = { muster: (argv.muster as string | undefined) ?? '' };
                        const aus = argv['aus-beleg'] as string | undefined;
                        if (aus) {
                            const doc = await session.dms(entity).get(aus);
                            if (!doc) throw new Error(`Beleg ${aus} nicht gefunden.`);
                            if (!regel.muster) regel.muster = doc.correspondent ?? '';
                            if (doc.correspondent) regel.korrespondent = doc.correspondent;
                            if (doc.documentType) regel.dokumenttyp = doc.documentType;
                            if (doc.category) regel.kategorie = doc.category;
                            if (doc.direction) regel.richtung = doc.direction;
                        }
                        if (argv.korrespondent) regel.korrespondent = argv.korrespondent as string;
                        if (argv.dokumenttyp) regel.dokumenttyp = argv.dokumenttyp as string;
                        if (argv.kategorie) regel.kategorie = argv.kategorie as string;
                        if (argv.richtung) regel.richtung = argv.richtung as 'incoming' | 'outgoing';
                        return rememberDokumentRegel(entity.id, regel);
                    }),
            })
            .command({
                command: 'regel-entfernen <muster>',
                describe: 'Eine Dokumentregel entfernen (Belege behalten, was sie gesetzt hat)',
                builder: (yy) => yy.positional('muster', { type: 'string', demandOption: true }).options(commonOptions),
                handler: (argv) =>
                    runAndExit(async () => {
                        const { entity } = await setup(argv.entity);
                        const removed = removeDokumentRegel(entity.id, String(argv.muster));
                        if (!removed) throw new Error(`Keine Dokumentregel mit dem Muster „${argv.muster}“.`);
                        return { entfernt: String(argv.muster) };
                    }),
            })
            .command({
                command: 'hinzufuegen <datei..>',
                describe: 'Belege ins eingebaute DMS legen — Dokumentregeln greifen dabei, vor jeder KI',
                builder: (yy) =>
                    yy
                        .positional('datei', { type: 'string', array: true, demandOption: true })
                        .options(commonOptions)
                        .option('year', {
                            type: 'number',
                            describe: 'Jahr, in dem der Beleg erscheinen soll (Standard: laufendes)',
                        }),
                handler: (argv) =>
                    runAndExit(async () => {
                        const { session, entity } = await setup(argv.entity);
                        const provider = session.dms(entity);
                        const out = [];
                        for (const path of argv.datei as string[]) {
                            const doc = await storeReceipt(provider, {
                                bytes: readFileSync(path),
                                filename: basename(path),
                                viewYear: argv.year as number | undefined,
                                entityId: entity.id,
                            });
                            out.push({
                                id: doc.id,
                                datei: basename(path),
                                korrespondent: doc.correspondent,
                                dokumenttyp: doc.documentType,
                                kategorie: doc.category ?? null,
                                richtung: doc.direction,
                                herkunft: doc.ruleOrigin ? herkunftSatz(doc.ruleOrigin) : null,
                            });
                        }
                        return out;
                    }),
            })
            .command({
                command: 'herkunft <id>',
                describe:
                    'Woher die Werte eines Belegs stammen: die gemerkte Regel (eigenes DMS) oder die Paperless-Regel',
                builder: (yy) =>
                    yy
                        .positional('id', {
                            type: 'string',
                            demandOption: true,
                            describe: 'Beleg-ID (Paperless: Dokument-Nummer)',
                        })
                        .options(commonOptions)
                        .option('json', jsonOption),
                handler: (argv) =>
                    runAndExit(
                        async () => {
                            const { session, entity } = await setup(argv.entity);
                            if (entity.dmsType === 'paperless') {
                                const z = await paperlessZuordnungForEntity(entity.id, Number(argv.id));
                                return { kopf: z.kopf, saetze: z.eintraege.map((e) => e.satz), eintraege: z.eintraege };
                            }
                            const doc = await session.dms(entity).get(String(argv.id));
                            if (!doc) throw new Error(`Beleg ${argv.id} nicht gefunden.`);
                            const kopf = doc.ruleOrigin
                                ? herkunftSatz(doc.ruleOrigin)
                                : 'Keine Dokumentregel hat an diesem Beleg etwas gesetzt.';
                            return { kopf, saetze: [] as string[], eintraege: [] as unknown[] };
                        },
                        {
                            print: argv.json
                                ? (v) => console.log(JSON.stringify(v, null, 2))
                                : (v) => {
                                      console.log(v.kopf);
                                      for (const s of v.saetze) console.log(`  · ${s}`);
                                  },
                        },
                    ),
            })
            .command(mailKonfigModule)
            .command(mailPasswortModule)
            .command(mailAbrufModule)
            .command({
                command: 'zuruecknehmen <id>',
                describe: 'Die Werte einer Dokumentregel von einem Beleg entfernen („Danach gilt …")',
                builder: (yy) => yy.positional('id', { type: 'string', demandOption: true }).options(commonOptions),
                handler: (argv) =>
                    runAndExit(
                        async () => {
                            const { session, entity } = await setup(argv.entity);
                            return nimmDokumentRegelZurueck(session.dms(entity), entity.id, String(argv.id));
                        },
                        { print: (v) => console.log(v.satz) },
                    ),
            }),
    handler: () => {},
};
