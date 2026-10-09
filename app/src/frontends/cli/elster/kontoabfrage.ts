/**
 * `elster kontoabfrage` — ask the Finanzamt what it has on record for a Steuernummer.
 *
 * The counterpart to every other elster subcommand: those send what WE computed, this one reads
 * back what the Finanzamt actually booked. It answers two questions nothing else here can:
 * which Voranmeldungen ever arrived (the register only knows what we told it, so a return filed
 * by a former Steuerberater is invisible), and what has been paid (a payment from an account we
 * do not import leaves no trace).
 *
 * `--check` validates the request locally and sends nothing; without a PIN that is all it does.
 */

import type { CommandModule as YargsCommandModule } from 'yargs';
import { pickArgv } from '../output.ts';
import { resolveEntityElster } from '../../../core/config/accessors.ts';
import {
    buildKontoabfrageEds,
    KONTOABFRAGE_DATENART_VERSION,
    type KontoabfrageQuery,
    type KontoabfrageSteuerart,
} from '../../../core/elster/kontoabfrage-xml.ts';
import { parseKontoabfrage, fehlendeAnmeldungen } from '../../../core/elster/kontoabfrage-parse.ts';
import { fmtDe } from '../../../core/lib/money.ts';
import { resolveElsterPin } from '../../../core/elster/pin.ts';

/** Turn the flags into one of the three query shapes the schema allows. */
function queryFromArgs(raw: Record<string, unknown>): KontoabfrageQuery {
    const steuerart = pickArgv<string>(raw, 'steuerart') as KontoabfrageSteuerart | undefined;
    const jahr = pickArgv<number>(raw, 'jahr');
    if (jahr != null) {
        if (!steuerart) throw new Error('--jahr braucht --steuerart (z. B. --steuerart USt).');
        return { art: 'ZS', steuerart, zeitraum: jahr };
    }
    return { art: 'O' };
}

export const kontoabfrageSubcommand: YargsCommandModule = {
    command: 'kontoabfrage',
    describe: 'Steuerkonto beim Finanzamt abfragen (offene Posten oder Sollstellungen eines Jahres).',
    builder: (y) =>
        y
            .option('entity', {
                type: 'string',
                demandOption: true,
                describe: 'Workspace-Entität (gbr|jumplink|privat)',
            })
            .option('steuerart', {
                type: 'string',
                choices: ['ESt', 'GewSt', 'KapESt', 'KSt', 'LSt', 'USt', 'ZaSt'],
                describe: 'Steuerart — zusammen mit --jahr eine Sollstellungs-Abfrage (ZS)',
            })
            .option('jahr', { type: 'number', describe: 'Jahr der Sollstellungen; ohne --jahr: offene Posten (O)' })
            .option('pin', { type: 'string', describe: 'Zertifikats-PIN — ohne sie wird nur lokal geprüft' })
            .option('check', { type: 'boolean', default: false, describe: 'Nur lokal validieren, NICHT senden' })
            .option('json', { type: 'boolean', default: false, describe: 'Rohes JSON ausgeben' }),
    handler: async (argv: Record<string, unknown>) => {
        const raw = argv as Record<string, unknown>;
        const entity = pickArgv<string>(raw, 'entity') as string;
        const config = resolveEntityElster(entity);
        if (!config) throw new Error(`Entität '${entity}' hat keine ELSTER-Config.`);

        const query = queryFromArgs(raw);
        const xml = buildKontoabfrageEds(config, query);
        const { validateXml, sendXml } = await import('@steuererklaerung/eric');

        const validation = validateXml(xml, KONTOABFRAGE_DATENART_VERSION);
        if (validation.returnCode !== 0) {
            console.error(`ERiC lehnt die Anfrage ab (rc=${validation.returnCode}).`);
            console.error(validation.fehler || validation.hinweise || '');
            return process.exit(1);
        }

        const keystoreForPin = pickArgv<string>(raw, 'keystore') ?? config.keystore_path ?? '';
        // Resolved BEFORE the --check branch so `--check` also reports whether a PIN would be
        // found — otherwise the dry run says "pass --pin" even when the keyring already holds one.
        let resolved: { pin: string; source: string } | undefined;
        try {
            resolved = resolveElsterPin(pickArgv<string>(raw, 'pin'), keystoreForPin);
        } catch {
            resolved = undefined;
        }
        if (raw.check || !resolved) {
            console.log(`\nSteuerkontoabfrage — ${entity} · ${query.art}`);
            console.log('='.repeat(72));
            console.log('  ✓ Anfrage lokal gültig (ERiC).');
            console.log(
                resolved
                    ? `  PIN gefunden (${resolved.source}) — ohne --check wird abgefragt.`
                    : '  Keine PIN hinterlegt: `elster pin speichern --entity <e>` oder ELSTER_PIN setzen.',
            );
            console.log('  Die Berechtigung prüft der Server: das Zertifikat muss für das');
            console.log('  Verfahren ElsterKontoabfrage zugelassen sein.');
            return;
        }

        const keystore = keystoreForPin;
        if (!keystore) throw new Error('Kein Zertifikat: --keystore angeben oder keystore_path in der Config setzen.');
        const pin = resolved.pin;
        // `allowLive` is the normal case for a QUERY, not a weakening of the guard. That guard
        // exists so a declaration cannot reach the live system by accident — an irreversible act.
        // A Kontoabfrage files nothing and changes nothing; it reads. And a query stamped with a
        // Testmerker would ask the test system about a fictional account, which answers the one
        // question this command exists for with nothing.
        const result = sendXml(xml, KONTOABFRAGE_DATENART_VERSION, {
            keystorePath: keystore,
            pin,
            allowLive: true,
        });
        if (!result.ok) {
            // The server's own words, not just our return code. ERiC's 610101xxx range means the
            // request REACHED the ELSTER server and it answered — the reason is in that answer,
            // and printing only the code throws away the one thing that explains the failure.
            console.error(`Abfrage fehlgeschlagen (rc=${result.returnCode}).`);
            const antwort = result.serverantwortXml || result.rueckgabeXml || '';
            const texte = [...antwort.matchAll(/<(?:\w+:)?Text>([^<]+)<\/(?:\w+:)?Text>/g)].map((m) => m[1].trim());
            if (texte.length > 0) {
                console.error('\nServerantwort:');
                for (const t of texte) console.error(`  ${t}`);
            } else if (antwort) {
                console.error(`\nServerantwort (roh):\n${antwort.slice(0, 1500)}`);
            }
            return process.exit(1);
        }

        const parsed = parseKontoabfrage(result.serverantwortXml);
        if (raw.json) {
            console.log(JSON.stringify(parsed, null, 2));
            return;
        }

        console.log(`\nSteuerkonto ${parsed.steuernummer ?? '—'} · Stand ${parsed.tagesdatum ?? '—'}`);
        console.log('='.repeat(72));
        for (const g of parsed.steuerarten) {
            const sum = g.gesamtbetrag != null ? `  (${fmtDe(g.gesamtbetrag)} €)` : '';
            console.log(`\n▸ ${g.steuerart}${sum}`);
            for (const t of g.teilbetraege) {
                const wert = t.wert != null ? `${fmtDe(t.wert).padStart(12)} €` : ''.padStart(14);
                const faellig = t.faelligkeit ? ` fällig ${t.faelligkeit}` : '';
                console.log(`   ${t.zeitraum.padEnd(10)}${wert}${faellig}  ${t.erlaeuterung ?? ''}`);
            }
        }
        if (parsed.gesamtsumme != null) console.log(`\n  Gesamtsumme: ${fmtDe(parsed.gesamtsumme)} €`);

        // The finding that has no other source: the Finanzamt naming a period it never received.
        const fehlend = fehlendeAnmeldungen(parsed);
        if (fehlend.length > 0) {
            console.log(`\n⚠ Vom Finanzamt als fehlend geführt: ${fehlend.join(', ')}`);
            console.log('  Das Abgaberegister kann das nicht wissen — es kennt nur, was WIR eingetragen haben.');
        }
    },
};
