/**
 * `laufende-kosten` — the debits at a fixed interval (rent, software, insurance) the app detected over
 * all of an entity's bookings, with the owner's decisions (Idee 8). `laufende-kosten entscheiden <key>
 * --als bestaetigt|abgelehnt|beendet|vorschlag` records one; only confirmed series count in
 * `frei-verfuegbar` and leave the Geld-Prüfungen. `--json` gives the raw model.
 */

import type { CommandModule } from 'yargs';
import { createPresenterSession } from '../../core/presenters/session.ts';
import {
    entscheideLaufendeKosten,
    loadLaufendeKosten,
    type LaufendeKosten,
    type LaufendeKostenUebersicht,
    type LkEntscheidungInput,
} from '../../core/presenters/laufende-kosten.ts';
import { ABSTAND_TEXT, zuBestaetigenTitel, type SerienAbstand } from '../../core/elster/laufende-kosten.ts';
import type { EntityModel } from '../../core/presenters/workspace.ts';
import { fmtDe } from '../../core/lib/money.ts';
import { ensureDemoSeeded } from './demo.ts';
import { runAndExit } from './output.ts';

function pickEntity(entities: EntityModel[], wanted?: string): EntityModel {
    const entity = wanted ? entities.find((e) => e.id === wanted) : (entities.find((e) => e.hasElster) ?? entities[0]);
    if (!entity) {
        throw new Error(
            wanted
                ? `Unbekannte Entität '${wanted}'. Bekannt: ${entities.map((e) => e.id).join(', ') || '—'}`
                : 'Keine Entität in steuererklaerung.json.',
        );
    }
    return entity;
}

function zeile(k: LaufendeKosten): void {
    const wer = k.empfaenger.slice(0, 32).padEnd(32);
    const naechste = k.aktiv ? `nächste ${k.naechste}` : 'beendet?';
    console.log(
        `  ${wer}  ${fmtDe(k.betrag).padStart(10)} €  ${ABSTAND_TEXT[k.abstand].padEnd(15)}  zuletzt ${k.zuletzt}  ${naechste}`,
    );
    const p = k.preisaenderung;
    const extra = [
        `${k.zahlungen.length} Zahlungen`,
        p ? `Preisänderung ${fmtDe(p.von)} → ${fmtDe(p.auf)} € am ${p.datum}` : null,
        k.korrigiert ? 'korrigiert' : null,
    ].filter(Boolean);
    console.log(`      ${extra.join(' · ')}   [${k.key}]`);
}

function print(u: LaufendeKostenUebersicht): void {
    const gruppen: [string, LaufendeKosten[]][] = [
        [u.vorschlaege.length ? zuBestaetigenTitel(u.vorschlaege.length) : 'Nichts zu bestätigen', u.vorschlaege],
        ['Bestätigt', u.bestaetigt],
        ['Keine laufenden Kosten', u.abgelehnt],
        ['Beendet', u.beendet],
    ];
    for (const [titel, liste] of gruppen) {
        if (!liste.length && titel !== gruppen[0][0]) continue;
        console.log(`\n${titel}`);
        for (const k of liste) zeile(k);
    }
    console.log(`\nDatenstand: ${u.datenstand ?? '—'}`);
    console.log('→ entscheiden: laufende-kosten entscheiden <key> --als bestaetigt|abgelehnt|beendet|vorschlag');
}

const entityOption = {
    entity: { type: 'string', describe: 'Entität aus steuererklaerung.json (Standard: erste Firma)' },
} as const;

export const laufendeKostenCommand: CommandModule = {
    command: 'laufende-kosten',
    describe: 'Laufende Kosten: erkannte regelmäßige Abbuchungen (Miete, Software, Versicherung) und Entscheidungen',
    builder: (y) =>
        y
            .command({
                command: ['liste', '$0'],
                describe: 'Vorschläge, bestätigte, abgelehnte und beendete laufende Kosten',
                builder: (yy) =>
                    yy
                        .options(entityOption)
                        .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
                handler: (argv) =>
                    runAndExit(
                        async () => {
                            await ensureDemoSeeded();
                            const session = createPresenterSession();
                            const entity = pickEntity(session.workspace.entities, argv.entity as string | undefined);
                            return loadLaufendeKosten(session, entity);
                        },
                        { print: argv.json ? (v) => console.log(JSON.stringify(v, null, 2)) : print },
                    ),
            })
            .command({
                command: 'entscheiden <key>',
                describe:
                    'Eine Serie bestätigen (optional korrigiert), ablehnen, als beendet markieren oder zurücknehmen',
                builder: (yy) =>
                    yy
                        .positional('key', { type: 'string', demandOption: true, describe: 'Schlüssel aus der Liste' })
                        .option('als', {
                            choices: ['bestaetigt', 'abgelehnt', 'beendet', 'vorschlag'] as const,
                            demandOption: true,
                            describe: 'abgelehnt = „keine laufenden Kosten“ · vorschlag = Entscheidung zurücknehmen',
                        })
                        .option('abstand', {
                            choices: ['monatlich', 'vierteljaehrlich', 'halbjaehrlich', 'jaehrlich'] as const,
                            describe: 'Korrigierter Abstand (nur mit --als bestaetigt)',
                        })
                        .option('betrag', {
                            type: 'number',
                            describe: 'Korrigierter Betrag in EUR (nur mit --als bestaetigt)',
                        })
                        .options(entityOption),
                handler: (argv) =>
                    runAndExit(async () => {
                        await ensureDemoSeeded();
                        const session = createPresenterSession();
                        const entity = pickEntity(session.workspace.entities, argv.entity as string | undefined);
                        const als = argv.als as LkEntscheidungInput['status'];
                        if (als !== 'bestaetigt' && (argv.abstand || argv.betrag != null)) {
                            throw new Error('--abstand und --betrag gehen nur mit --als bestaetigt.');
                        }
                        const e: LkEntscheidungInput =
                            als === 'bestaetigt'
                                ? {
                                      status: als,
                                      abstand: argv.abstand as SerienAbstand | undefined,
                                      betrag: argv.betrag as number | undefined,
                                  }
                                : { status: als };
                        return entscheideLaufendeKosten(session, entity, String(argv.key), e);
                    }),
            }),
    handler: () => {},
};
