/**
 * `hinweise` — the year's Hinweise for one entity: what each check found (with the affected bookings
 * and the actions the app offers), what it checked without a finding, and what it could not check.
 * `hinweise ok <key>` marks the current finding „in Ordnung"; a new finding under the same key shows
 * again. `--json` gives the raw model (status, betroffen, handlungen, fingerprint); `--vor-abgabe` only the
 * findings to clear before a USt-VA or the annual returns go out (Idee 10).
 */

import type { CommandModule } from 'yargs';
import { createPresenterSession } from '../../core/presenters/session.ts';
import {
    loadHinweise,
    loadVorAbgabeHinweise,
    markHinweisInOrdnung,
    type YearHinweis,
} from '../../core/presenters/hinweise.ts';
import type { EntityModel } from '../../core/presenters/workspace.ts';
import { ensureDemoSeeded } from './demo.ts';
import { runAndExit } from './output.ts';

const LEVEL: Record<string, string> = { warnung: '⚠', tipp: '★', info: 'ℹ' };

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

function print(hints: YearHinweis[]): void {
    if (hints.length === 0) {
        console.log('Keine Hinweise.');
        return;
    }
    for (const h of hints) {
        const erledigt = h.erledigt ? '  [in Ordnung]' : '';
        console.log(`${LEVEL[h.level] ?? '·'} ${h.title}${h.ref ? `  (${h.ref})` : ''}${erledigt}`);
        console.log(`  ${h.text}`);
        if (h.status === 'ohne_befund') console.log(`  Geprüft, ohne Befund${h.geprueft ? `: ${h.geprueft}` : ''}`);
        if (h.status === 'nicht_pruefbar') console.log(`  Nicht prüfbar${h.weil ? `, weil ${h.weil}` : ''}`);
        for (const b of h.betroffen ?? []) console.log(`    · ${b.zeile}  [${b.art} ${b.id}]`);
        if (h.betroffenWeitere) console.log(`    · und ${h.betroffenWeitere} weitere`);
        if (h.handlungen?.length && !h.erledigt) {
            console.log(`  → ${h.handlungen.map((a) => a.label).join(' · ')}   (Schlüssel: ${h.key})`);
        }
        console.log('');
    }
}

const commonOptions = {
    entity: { type: 'string', describe: 'Entität aus steuererklaerung.json (Standard: erste Firma)' },
    year: { type: 'number', describe: 'Jahr (Standard: laufendes Jahr)' },
    today: { type: 'string', describe: 'Stichtag YYYY-MM-DD (Standard: heute) — für reproduzierbare Ausgabe' },
} as const;

function today(raw: unknown): string | undefined {
    const t = raw as string | undefined;
    if (t && !/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new Error('--today erwartet YYYY-MM-DD.');
    return t;
}

export const hinweiseCommand: CommandModule = {
    command: 'hinweise',
    describe: 'Hinweise eines Jahres: Befunde mit Buchungen und Handlungen, „ohne Befund", „nicht prüfbar"',
    builder: (y) =>
        y
            .command({
                command: ['liste', '$0'],
                describe: 'Hinweise anzeigen',
                builder: (yy) =>
                    yy
                        .options(commonOptions)
                        .option('alle', {
                            type: 'boolean',
                            default: false,
                            describe: 'Auch die als in Ordnung markierten zeigen',
                        })
                        .option('vor-abgabe', {
                            type: 'boolean',
                            default: false,
                            describe: 'Nur, was vor der Abgabe zu klären ist (USt-VA und Jahreserklärung)',
                        })
                        .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
                handler: (argv) =>
                    runAndExit(
                        async () => {
                            await ensureDemoSeeded();
                            const session = createPresenterSession();
                            const entity = pickEntity(session.workspace.entities, argv.entity as string | undefined);
                            const year = (argv.year as number | undefined) ?? new Date().getFullYear();
                            const opts = { today: today(argv.today), alle: !!argv.alle };
                            return argv['vor-abgabe']
                                ? loadVorAbgabeHinweise(session, entity, year, opts)
                                : loadHinweise(session, entity, year, opts);
                        },
                        { print: argv.json ? (v) => console.log(JSON.stringify(v, null, 2)) : print },
                    ),
            })
            .command({
                command: 'ok <key>',
                describe: 'Den aktuellen Befund eines Hinweises als in Ordnung markieren',
                builder: (yy) =>
                    yy
                        .positional('key', { type: 'string', demandOption: true, describe: 'Schlüssel des Hinweises' })
                        .options(commonOptions),
                handler: (argv) =>
                    runAndExit(async () => {
                        await ensureDemoSeeded();
                        const session = createPresenterSession();
                        const entity = pickEntity(session.workspace.entities, argv.entity as string | undefined);
                        const year = (argv.year as number | undefined) ?? new Date().getFullYear();
                        return markHinweisInOrdnung(session, entity, year, String(argv.key), {
                            today: today(argv.today),
                        });
                    }),
            }),
    handler: () => {},
};
