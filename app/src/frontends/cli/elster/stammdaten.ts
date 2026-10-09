import { buildStammdaten, printStammdaten } from '../../../core/actions/elster/stammdaten.ts';
import { pickArgv } from '../output.ts';
import { parseElsterArgs } from './shared.ts';

import type { CommandModule as YargsCommandModule } from 'yargs';

/**
 * `elster stammdaten` — surface the ELSTER master data (Name, Art, Anschrift split into
 * Straße/Hausnummer/PLZ/Ort, Steuernummer, Finanzamt, USt-IdNr, W-IdNr, Rechtsform, Einkunftsart,
 * Betriebsaufgabe-Datum, Versteuerungsart) so they need not be read out of the private config by hand.
 */
export const stammdatenSubcommand: YargsCommandModule = {
    command: 'stammdaten',
    describe:
        'ELSTER-Stammdaten der Entität ausgeben (Name, Art, Anschrift getrennt, Steuernummer, Finanzamt, USt-IdNr/W-IdNr, Rechtsform, Einkunftsart, Betriebsaufgabe, Versteuerung) — zum Ausfüllen der Jahresformulare.',
    builder: (y) =>
        y
            .option('entity', {
                type: 'string',
                describe: 'Workspace-Entität (gbr|jumplink|privat) — wählt deren ELSTER-Config',
            })
            .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
    handler: (argv) => {
        const raw = argv as Record<string, unknown>;
        try {
            const elster = parseElsterArgs(raw);
            const entityId = pickArgv<string>(raw, 'entity') ?? elster.entity_id;
            const s = buildStammdaten(elster, entityId);
            if (raw.json) console.log(JSON.stringify(s, null, 2));
            else printStammdaten(s);
            process.exit(0);
        } catch (err) {
            console.error(err instanceof Error ? err.message : err);
            process.exit(1);
        }
    },
};
