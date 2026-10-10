/**
 * `frei-verfuegbar` — how much of one entity's bank balance is free once the USt since the last
 * Voranmeldung, due tax payments and open supplier invoices are set aside, plus the year's
 * Steuerrücklage (Schätzung). Every term prints with its derivation; `--json` gives the raw model.
 * A calculation, not a recommendation — see core/elster/frei-verfuegbar.ts.
 */

import type { CommandModule } from 'yargs';
import { createPresenterSession } from '../../core/presenters/session.ts';
import { loadFreiVerfuegbar } from '../../core/presenters/frei-verfuegbar.ts';
import type { FreiErgebnis, FreiVerfuegbarModel } from '../../core/elster/frei-verfuegbar.ts';
import { ensureDemoSeeded } from './demo.ts';
import { fmtDe } from '../../core/lib/money.ts';

const STATUS: Record<string, string> = {
    teilweise: ' [teilweise]',
    entfaellt: ' [entfällt]',
    'nicht-berechenbar': ' [nicht berechenbar]',
};

function printErgebnis(e: FreiErgebnis): void {
    const wert = e.betrag == null ? 'nicht berechenbar' : `${fmtDe(e.betrag)} €`;
    console.log(`${e.label}: ${wert}${e.vollstaendig ? '' : '  (unvollständig)'}`);
    console.log(`  = ${e.formel}`);
    for (const t of e.terme) {
        const counted = t.status === 'ok' || t.status === 'teilweise';
        console.log(
            `  ${t.op === '-' ? '−' : '+'} ${t.label}: ${counted ? `${fmtDe(t.betrag)} €` : '—'}${STATUS[t.status] ?? ''}`,
        );
        console.log(`      ${t.erklaerung}`);
        for (const z of t.zeilen) {
            const betrag = z.betrag == null ? '' : `  ${fmtDe(z.betrag)} €`;
            console.log(`      · ${z.label}${betrag}${z.herkunft ? `  (${z.herkunft})` : ''}`);
        }
    }
    console.log(`  ${e.hinweis}\n`);
}

function print(m: FreiVerfuegbarModel): void {
    console.log(`\n${m.entityName} — Stand ${m.stichtag}\n`);
    printErgebnis(m.freiVerfuegbar);
    printErgebnis(m.steuerruecklage);
}

export const freiVerfuegbarCommand: CommandModule = {
    command: 'frei-verfuegbar',
    describe:
        'Frei verfügbar (Kontostand − USt seit Voranmeldung − fällige Steuern − offene Eingangsrechnungen) + Steuerrücklage',
    builder: (y) =>
        y
            .option('entity', { type: 'string', describe: 'Entität aus steuererklaerung.json (Standard: erste Firma)' })
            .option('year', { type: 'number', describe: 'Jahr der Steuerrücklage (Standard: laufendes Jahr)' })
            .option('today', {
                type: 'string',
                describe: 'Stichtag YYYY-MM-DD (Standard: heute) — für reproduzierbare Ausgabe',
            })
            .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
    handler: async (argv) => {
        try {
            await ensureDemoSeeded();
            const session = createPresenterSession();
            const entities = session.workspace.entities;
            const wanted = argv.entity as string | undefined;
            const entity = wanted
                ? entities.find((e) => e.id === wanted)
                : (entities.find((e) => !!e.elster) ?? entities[0]);
            if (!entity) {
                throw new Error(
                    wanted
                        ? `Unbekannte Entität '${wanted}'. Bekannt: ${entities.map((e) => e.id).join(', ') || '—'}`
                        : 'Keine Entität in steuererklaerung.json.',
                );
            }
            const today = argv.today as string | undefined;
            if (today && !/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error('--today erwartet YYYY-MM-DD.');
            const model = await loadFreiVerfuegbar(session, entity, { year: argv.year as number | undefined, today });
            if (argv.json) console.log(JSON.stringify(model, null, 2));
            else print(model);
            process.exit(0);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    },
};
