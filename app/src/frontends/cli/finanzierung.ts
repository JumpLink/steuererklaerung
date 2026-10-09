/**
 * `finanzierung` — compute an Immobilien- or Sanierungsfinanzierung.
 *
 *   finanzierung darlehen --betrag 220000 --zins 3.9 --tilgung 2 --zinsbindung 10
 *   finanzierung haushalt [--entity privat]
 *   finanzierung bedarf   [--entity privat]
 *   finanzierung szenario [--entity privat] [--zins 3.9] [--tilgung 2]
 *   finanzierung unterlagen [--entity privat]
 *
 * `darlehen` computes standalone from the conditions passed in — it needs no config
 * for that, it is the calculator for a meeting at the bank. The other commands read
 * the entity's `finanzierung` block from the manifest.
 */

import type { CommandModule } from 'yargs';
import {
    annuitaet,
    effektivzins,
    finanzierungsmix,
    maxDarlehen,
    mixRestschuldNach,
    tilgungsplan,
    type Tranche,
} from '@steuererklaerung/kredit';
import { resolveEntityFinanzierung } from '../../core/config/accessors.ts';
import { parseNumericString } from '../../core/lib/parsing.ts';
import {
    berechneBedarf,
    berechneHaushalt,
    berechneSzenarien,
    berechneUnterlagen,
} from '../../core/actions/finanzierung/index.ts';
import type { FinanzierungConfig } from '../../core/config/schema/finanzierung.ts';

const DEFAULT_ENTITY = 'privat';

function eur(n: number): string {
    return `${n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

/** Interest rates German-style — "2,35 %", not "2.348 %", which reads as 2348 %. */
function pct(n: number, digits = 2): string {
    return `${n.toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: digits })} %`;
}

/** `232.000` / `1.234.000` — dots grouping three digits, no decimal comma. */
const DE_TAUSENDER = /^-?\d{1,3}(\.\d{3})+$/;

/**
 * Read a number the way a German user types it into this CLI.
 *
 * The inputs here get copied straight off a German bank quote, where a rate is
 * written `4,4` and an amount `232.000`. Both of the obvious parsers fail
 * silently rather than loudly: `Number('4,4')` is `NaN`, and
 * `Number.parseFloat('4,4')` is `4` — a *plausible-looking wrong financing*,
 * which is worse than an error.
 *
 * Delegates to {@link parseNumericString} for the ordinary cases. It handles one
 * shape differently on purpose: a bare `232.000` is German thousands here, while
 * `parseNumericString` reads a trailing dot group as an English decimal and
 * returns `232`. That reading is right for an API payload and wrong for a bank
 * quote, so the disambiguation lives here — in the German-only surface — instead
 * of being changed underneath the accounting importers.
 *
 * @throws If the value is not a finite number.
 */
export function deZahl(raw: unknown, feld: string): number {
    if (typeof raw === 'number') {
        if (!Number.isFinite(raw)) throw new Error(`${feld}: „${raw}" ist keine Zahl.`);
        return raw;
    }
    const text = String(raw).trim();
    const n = DE_TAUSENDER.test(text) ? Number(text.replace(/\./g, '')) : parseNumericString(text);
    if (n == null || !Number.isFinite(n)) throw new Error(`${feld}: „${text}" ist keine Zahl.`);
    return n;
}

/**
 * A numeric CLI option that accepts German notation. Declared as a string so the
 * raw text survives long enough for {@link deZahl} to see it — yargs' own
 * `type: 'number'` would already have destroyed `4,4` into `NaN`.
 */
function zahlOption(describe: string, extra: Record<string, unknown> = {}) {
    return {
        type: 'string' as const,
        describe,
        coerce: (v: unknown) => (v === undefined ? undefined : deZahl(v, describe)),
        ...extra,
    };
}

function eurShort(n: number): string {
    return `${Math.round(n).toLocaleString('de-DE')} €`;
}

/** Load the entity's financing block, failing with an actionable message when absent. */
function requireConfig(entity: string): FinanzierungConfig {
    const cfg = resolveEntityFinanzierung(entity);
    if (!cfg) {
        throw new Error(
            `Entity „${entity}" hat keinen finanzierung-Block im Manifest (steuererklaerung.json). ` +
                'Lege ihn unter entities[].finanzierung an — oder rechne freistehend mit ' +
                '„finanzierung darlehen --betrag … --zins … --tilgung …".',
        );
    }
    return cfg;
}

const entityOption = {
    type: 'string' as const,
    default: DEFAULT_ENTITY,
    describe: 'Entity-Id im Manifest (Standard: privat)',
};

/** `finanzierung darlehen` — the standalone loan calculator. */
const darlehenCommand: CommandModule = {
    command: 'darlehen',
    describe: 'Annuität, Tilgungsplan, Restschuld nach Zinsbindung und Effektivzins rechnen',
    builder: (y) =>
        y
            .option('betrag', zahlOption('Nettodarlehensbetrag in €', { demandOption: true }))
            .option('zins', zahlOption('Sollzins p.a. in % (z. B. 3,9)', { demandOption: true }))
            .option('tilgung', zahlOption('Anfängliche Tilgung p.a. in % (z. B. 2)'))
            .option('rate', zahlOption('Feste Monatsrate in € — Alternative zu --tilgung'))
            .option('zinsbindung', zahlOption('Zinsbindung in Jahren', { default: '10' }))
            .option('sondertilgung', zahlOption('Sondertilgung pro Jahr in €', { default: '0' }))
            .option('disagio', zahlOption('Disagio in % des Betrags', { default: '0' }))
            .option('gebuehren', zahlOption('Einmalige Gebühren in €', { default: '0' }))
            .option('plan', { type: 'boolean', default: false, describe: 'Jahres-Tilgungsplan ausgeben' }),
    handler: (argv) => {
        const input = {
            betrag: Number(argv.betrag),
            sollzins: Number(argv.zins),
            tilgung: argv.tilgung === undefined ? undefined : Number(argv.tilgung),
            rate: argv.rate === undefined ? undefined : Number(argv.rate),
            zinsbindungJahre: Number(argv.zinsbindung),
            sondertilgungProJahr: Number(argv.sondertilgung),
        };
        const plan = tilgungsplan(input);

        console.log('\nAnnuitätendarlehen');
        console.log('='.repeat(64));
        console.log(`  Darlehensbetrag       ${eur(input.betrag).padStart(16)}`);
        console.log(`  Sollzins p.a.         ${`${input.sollzins} %`.padStart(16)}`);
        if (input.tilgung !== undefined) {
            console.log(`  Anfangstilgung p.a.   ${`${input.tilgung} %`.padStart(16)}`);
        }
        console.log(`  Monatsrate            ${eur(plan.rate).padStart(16)}`);

        if (plan.laufzeitMonate === null) {
            console.log('\n  ⚠ Die Rate deckt die Zinsen nicht — das Darlehen tilgt nie.');
            return;
        }

        const jahre = Math.floor(plan.laufzeitMonate / 12);
        const monate = plan.laufzeitMonate % 12;
        console.log(`  Laufzeit              ${`${jahre} J ${monate} M`.padStart(16)}`);
        console.log(`  Zinsen gesamt         ${eur(plan.summeZins).padStart(16)}`);

        if (plan.restschuldNachBindung !== null) {
            console.log(`\n  Nach ${input.zinsbindungJahre} Jahren Zinsbindung:`);
            console.log(`    Restschuld          ${eur(plan.restschuldNachBindung).padStart(16)}`);
            if (plan.gezahltBisBindung !== null) {
                console.log(`    davon gezahlt       ${eur(plan.gezahltBisBindung).padStart(16)}`);
            }
            console.log(
                '    ↳ Das ist der Betrag, für den eine Anschlussfinanzierung nötig wird —\n' +
                    '      zu dann gültigen Zinsen. Das ist das eigentliche Zinsrisiko.',
            );
        }

        const disagio = Number(argv.disagio);
        const gebuehren = Number(argv.gebuehren);
        if (disagio > 0 || gebuehren > 0) {
            const eff = effektivzins(input, { disagioProzent: disagio, gebuehren });
            console.log(`\n  Effektivzins          ${`${eff} %`.padStart(16)}`);
        }

        if (argv.plan) {
            console.log('\nTilgungsplan (Jahre)');
            console.log('-'.repeat(64));
            console.log(
                `${'Jahr'.padStart(4)} ${'Rate'.padStart(13)} ${'Zins'.padStart(13)} ${'Tilgung'.padStart(13)} ${'Restschuld'.padStart(15)}`,
            );
            for (const j of plan.jahre) {
                const tilg = j.tilgung + j.sondertilgung;
                console.log(
                    `${String(j.jahr).padStart(4)} ${eurShort(j.rate).padStart(13)} ${eurShort(j.zins).padStart(13)} ${eurShort(tilg).padStart(13)} ${eurShort(j.restschuld).padStart(15)}`,
                );
            }
        }
        console.log('');
    },
};

/**
 * Parse `Name:Betrag:Zins:Tilgung[:Anlaufjahre[:Zinsbindung]]`.
 * The name must not contain a colon — it is the one free-text field.
 */
function parseTranche(spec: string, index: number): Tranche {
    const teile = spec.split(':');
    if (teile.length < 4) {
        throw new Error(
            `Ungültige --tranche Angabe "${spec}". Erwartet: ` + 'Name:Betrag:Zins:Tilgung[:Anlaufjahre[:Zinsbindung]]',
        );
    }
    const [name, betrag, zins, tilgung, anlauf, bindung] = teile;
    const zahl = (v: string, feld: string): number => deZahl(v, `${feld} in "${spec}"`);
    // An empty segment means "not given", so a Zinsbindung can be set without an
    // Anlaufzeit: "Bank:92000:4.4:2::10".
    const optional = (v: string | undefined, feld: string): number | undefined =>
        v === undefined || v.trim() === '' ? undefined : zahl(v, feld);
    return {
        key: `t${index + 1}`,
        name: name.trim(),
        betrag: zahl(betrag, 'Betrag'),
        sollzins: zahl(zins, 'Zins'),
        tilgung: zahl(tilgung, 'Tilgung'),
        tilgungsfreieAnlaufjahre: optional(anlauf, 'Anlaufjahre'),
        zinsbindungJahre: optional(bindung, 'Zinsbindung'),
    };
}

/** Parse `Name:Betrag` for a non-repayable grant. */
function parseZuschuss(spec: string, index: number): Tranche {
    const idx = spec.lastIndexOf(':');
    if (idx < 0) throw new Error(`Ungültige --zuschuss Angabe "${spec}". Erwartet: Name:Betrag`);
    const betrag = deZahl(spec.slice(idx + 1), `Betrag in "${spec}"`);
    // A grant is modelled as a tranche that carries the money but no debt: a
    // symbolic 1 € at 0 % repaid immediately, so it never shows up as a burden.
    return {
        key: `z${index + 1}`,
        name: spec.slice(0, idx).trim(),
        betrag: 1,
        sollzins: 0,
        tilgung: 100,
        zuschuss: betrag,
    };
}

/** `finanzierung mix` — several tranches in parallel, with the steps in the burden. */
const mixCommand: CommandModule = {
    command: 'mix',
    describe: 'Finanzierungsmix rechnen: mehrere Tranchen parallel (Förderkredit + Bank + Zuschuss)',
    builder: (y) =>
        y
            .option('tranche', {
                type: 'string',
                array: true,
                demandOption: true,
                describe:
                    'Tranche, mehrfach: Name:Betrag:Zins:Tilgung[:Anlaufjahre[:Zinsbindung]] ' +
                    '(Name ohne Doppelpunkt)',
            })
            .option('zuschuss', {
                type: 'string',
                array: true,
                describe: 'Nicht rückzahlbarer Zuschuss, mehrfach: Name:Betrag',
            })
            .option('bedarf', zahlOption('Kapitalbedarf in € — prüft, ob der Mix reicht'))
            .option('tragbar', zahlOption('Tragbare Monatsrate in € — prüft die HÖCHSTE Rate'))
            .option('restschuld-nach', {
                type: 'number',
                array: true,
                default: [10, 15, 20],
                describe: 'Jahre, für die die kombinierte Restschuld ausgewiesen wird',
            })
            .option('plan', { type: 'boolean', default: false, describe: 'Jahrestabelle ausgeben' })
            .example(
                '$0 finanzierung mix --tranche "KfW 308:140000:1:2:5:10" --tranche "Bank:92000:4:2::10" --tragbar 700',
                'Förderkredit mit 5 tilgungsfreien Jahren plus Bankdarlehen',
            ),
    handler: (argv) => {
        const tranchen = [
            ...(argv.tranche as string[]).map(parseTranche),
            ...((argv.zuschuss as string[] | undefined) ?? []).map(parseZuschuss),
        ];
        const bedarf = argv.bedarf === undefined ? undefined : Number(argv.bedarf);
        const mix = finanzierungsmix({ tranchen, bedarf });

        console.log('\nFinanzierungsmix');
        console.log('='.repeat(78));
        console.log(
            `${'Tranche'.padEnd(28)} ${'Betrag'.padStart(13)} ${'Zins'.padStart(7)} ${'Anteil'.padStart(8)} ${'Startrate'.padStart(13)}`,
        );
        console.log('-'.repeat(78));
        for (const t of mix.tranchen) {
            const start = t.plan.zeilen[0]?.rate ?? 0;
            const zuschuss = t.zuschuss > 0;
            console.log(
                `${t.name.slice(0, 28).padEnd(28)} ${eur(zuschuss ? t.zuschuss : t.betrag).padStart(13)} ` +
                    `${(zuschuss ? 'Zuschuss' : pct(t.sollzins)).padStart(7)} ` +
                    `${(zuschuss ? '—' : `${Math.round(t.anteil * 100)} %`).padStart(8)} ` +
                    `${(zuschuss ? '—' : eur(start)).padStart(13)}`,
            );
        }
        console.log('-'.repeat(78));
        console.log(`  Darlehen gesamt       ${eur(mix.summeDarlehen).padStart(16)}`);
        if (mix.summeZuschuss > 0) {
            console.log(`  Zuschüsse             ${eur(mix.summeZuschuss).padStart(16)}`);
            console.log(`  Deckung gesamt        ${eur(mix.deckung).padStart(16)}`);
        }
        console.log(`  Mischzins             ${pct(mix.mischzins).padStart(16)}`);

        if (mix.luecke !== null) {
            const l = mix.luecke;
            console.log(`  Kapitalbedarf         ${eur(bedarf ?? 0).padStart(16)}`);
            console.log(
                `  ${l > 0 ? 'LÜCKE' : 'Überdeckung'}${' '.repeat(l > 0 ? 17 : 11)}${eur(Math.abs(l)).padStart(16)}` +
                    (l > 0 ? '  ⚠ der Mix deckt den Bedarf nicht' : ''),
            );
        }

        console.log('\nMonatliche Belastung');
        console.log('-'.repeat(78));
        console.log(`  Startrate             ${eur(mix.startRate).padStart(16)}`);
        console.log(
            `  Höchste Rate          ${eur(mix.maxRate).padStart(16)}` +
                `   ab Monat ${mix.maxRateMonat} (Jahr ${Math.ceil(mix.maxRateMonat / 12)})`,
        );
        if (mix.maxRate > mix.startRate + 1) {
            console.log(
                '    ↳ Tragfähigkeit gegen die HÖCHSTE Rate prüfen, nicht gegen die erste.\n' +
                    '      Die Startrate ist die Zahl, die im Beratungsgespräch fällt.',
            );
        }
        for (const s of mix.stufen) {
            const richtung = s.rateNachher > s.rateVorher ? '↑' : '↓';
            console.log(
                `  ${richtung} Monat ${String(s.monat).padStart(3)} (Jahr ${String(s.jahr).padStart(2)}): ` +
                    `${eur(s.rateVorher)} → ${eur(s.rateNachher)}   ${s.grund}`,
            );
        }

        const tragbar = argv.tragbar === undefined ? undefined : Number(argv.tragbar);
        if (tragbar !== undefined) {
            const ok = mix.maxRate <= tragbar;
            console.log(
                `\n  Tragbare Rate         ${eur(tragbar).padStart(16)}   ` +
                    `${ok ? '✓ die höchste Rate passt' : `✗ höchste Rate liegt ${eur(mix.maxRate - tragbar)} darüber`}`,
            );
        }

        console.log('\nRestschuld (Anschlussfinanzierung)');
        console.log('-'.repeat(78));
        for (const j of argv['restschuld-nach'] as number[]) {
            console.log(`  nach ${String(j).padStart(2)} Jahren       ${eur(mixRestschuldNach(mix, j)).padStart(16)}`);
        }
        console.log(`  Zinsen gesamt         ${eur(mix.summeZins).padStart(16)}`);
        if (mix.laufzeitMonate !== null) {
            console.log(
                `  Laufzeit              ${`${Math.floor(mix.laufzeitMonate / 12)} J ${mix.laufzeitMonate % 12} M`.padStart(16)}`,
            );
        } else {
            console.log('  ⚠ Mindestens eine Tranche tilgt nie.');
        }

        if (argv.plan) {
            console.log('\nJahrestabelle (kombiniert)');
            console.log('-'.repeat(78));
            console.log(
                `${'Jahr'.padStart(4)} ${'Rate/Monat'.padStart(13)} ${'Zins'.padStart(13)} ${'Tilgung'.padStart(13)} ${'Restschuld'.padStart(15)}`,
            );
            const proJahr = new Map<number, { rate: number; zins: number; tilgung: number; rest: number }>();
            for (const m of mix.monate) {
                const e = proJahr.get(m.jahr) ?? { rate: 0, zins: 0, tilgung: 0, rest: 0 };
                e.rate += m.rate;
                e.zins += m.zins;
                e.tilgung += m.tilgung;
                e.rest = m.restschuld;
                proJahr.set(m.jahr, e);
            }
            for (const [jahr, e] of proJahr) {
                console.log(
                    `${String(jahr).padStart(4)} ${eurShort(e.rate / 12).padStart(13)} ${eurShort(e.zins).padStart(13)} ` +
                        `${eurShort(e.tilgung).padStart(13)} ${eurShort(e.rest).padStart(15)}`,
                );
            }
        }
        console.log('');
    },
};

/** `finanzierung bedarf` — the capital requirement. */
const bedarfCommand: CommandModule = {
    command: 'bedarf',
    describe: 'Kapitalbedarf: Ablösung + Auszahlung + Nebenkosten + Sanierung − Eigenkapital',
    builder: (y) => y.option('entity', entityOption),
    handler: (argv) => {
        const cfg = requireConfig(String(argv.entity));
        const b = berechneBedarf(cfg.bedarf);

        console.log('\nKapitalbedarf');
        console.log('='.repeat(64));
        if (cfg.objekt) console.log(`  Objekt: ${cfg.objekt.bezeichnung}\n`);
        console.log(`  Ablösung bestehendes Darlehen   ${eur(b.abloesung).padStart(16)}`);
        console.log(`  Auszahlung an Verkäufer         ${eur(b.auszahlungVerkaeufer).padStart(16)}`);
        console.log(`  ${'Kaufpreis'.padEnd(30)}  ${eur(b.kaufpreis).padStart(16)}`);
        console.log('');
        console.log(`  Grunderwerbsteuer               ${eur(b.nebenkosten.grunderwerbsteuer).padStart(16)}`);
        console.log(`  Notar + Grundbuch               ${eur(b.nebenkosten.notarGrundbuch).padStart(16)}`);
        if (b.nebenkosten.makler > 0) {
            console.log(`  Makler (Käuferanteil)           ${eur(b.nebenkosten.makler).padStart(16)}`);
        }
        if (b.nebenkosten.sonstige > 0) {
            console.log(`  Sonstige Nebenkosten            ${eur(b.nebenkosten.sonstige).padStart(16)}`);
        }
        console.log(`  ${'Kaufnebenkosten'.padEnd(30)}  ${eur(b.nebenkosten.summe).padStart(16)}`);
        console.log('');
        console.log(`  Sanierung                       ${eur(b.sanierung).padStart(16)}`);
        if (b.eigenkapital > 0) {
            console.log(`  Eigenkapital                    ${`−${eur(b.eigenkapital)}`.padStart(16)}`);
        }
        console.log('-'.repeat(64));
        console.log(`  ${'Darlehensbedarf'.padEnd(30)}  ${eur(b.darlehensbedarf).padStart(16)}\n`);
    },
};

/** `finanzierung haushalt` — the Haushaltsrechnung. */
const haushaltCommand: CommandModule = {
    command: 'haushalt',
    describe: 'Haushaltsrechnung: freies Einkommen und tragbare Rate (Ist-Rechnung + Bank-Sicht)',
    builder: (y) => y.option('entity', entityOption),
    handler: (argv) => {
        const cfg = requireConfig(String(argv.entity));
        const h = berechneHaushalt(cfg.haushalt);

        console.log('\nHaushaltsrechnung');
        console.log('='.repeat(64));
        console.log(`  Haushalt: ${cfg.haushalt.erwachsene} Erwachsene, ${cfg.haushalt.kinder} Kind(er)\n`);
        console.log(`  Einnahmen gesamt                ${eur(h.einnahmenGesamt).padStart(16)}`);
        if (h.einnahmenSicher !== h.einnahmenGesamt) {
            console.log(`  davon von der Bank anerkannt    ${eur(h.einnahmenSicher).padStart(16)}`);
        }
        console.log(`  Ausgaben heute                  ${eur(h.ausgabenGesamt).padStart(16)}`);
        console.log(`  Ausgaben nach Kauf              ${eur(h.ausgabenNachKauf).padStart(16)}`);

        if (h.entfallend.length > 0) {
            console.log('\n  Entfällt mit dem Kauf:');
            for (const p of h.entfallend) {
                console.log(`    ${p.bezeichnung.padEnd(28)} ${eur(p.betragMonat).padStart(14)}`);
            }
        }
        if (h.hinzukommend.length > 0) {
            console.log('\n  Kommt mit dem Eigentum hinzu:');
            for (const p of h.hinzukommend) {
                console.log(`    ${p.bezeichnung.padEnd(28)} ${eur(p.betragMonat).padStart(14)}`);
            }
        }

        console.log('\n  Ist-Rechnung (deine echten Zahlen)');
        console.log(`    frei heute                    ${eur(h.freiHeute).padStart(14)}`);
        console.log(`    frei nach Kauf                ${eur(h.freiNachKauf).padStart(14)}`);
        console.log(
            `    Puffer (${cfg.haushalt.puffer_prozent} %)                  ${`−${eur(h.puffer)}`.padStart(14)}`,
        );
        console.log(`    → tragbare Rate               ${eur(h.tragbareRate).padStart(14)}`);

        console.log('\n  Bank-Sicht (Lebenshaltungspauschale statt echter Ausgaben)');
        console.log(`    Pauschale Lebenshaltung       ${eur(h.lebenshaltungPauschale).padStart(14)}`);
        console.log(`    frei nach Kauf                ${eur(h.freiNachKaufBankSicht).padStart(14)}`);
        console.log(`    → tragbare Rate               ${eur(h.tragbareRateBankSicht).padStart(14)}`);
        console.log(
            '\n  ⚠ Die Pauschale ist ein Richtwert und je Bank unterschiedlich — sie ist in\n' +
                '    der Config anpassbar. Frag deinen Berater, welchen Satz seine Bank ansetzt;\n' +
                '    die Differenz zur Ist-Rechnung ist genau der Verhandlungsspielraum.\n',
        );
    },
};

/** `finanzierung szenario` — the comparison matrix. */
const szenarioCommand: CommandModule = {
    command: 'szenario',
    describe: 'Varianten vergleichen: Auszahlung × Sanierung → Rate, Restschuld, Tragfähigkeit',
    builder: (y) =>
        y
            .option('entity', entityOption)
            .option('zins', zahlOption('Sollzins p.a. in % — überschreibt das Angebot'))
            .option('tilgung', zahlOption('Tilgung p.a. in % — überschreibt das Angebot'))
            .option('zinsbindung', zahlOption('Zinsbindung in Jahren')),
    handler: (argv) => {
        const cfg = requireConfig(String(argv.entity));

        // A quote passed on the command line wins — that is how a fresh number from the
        // advisor gets tried without editing the config.
        const basis = cfg.angebote[0];
        const angebot =
            argv.zins !== undefined || argv.tilgung !== undefined || argv.zinsbindung !== undefined
                ? {
                      bank: basis?.bank ?? 'Annahme',
                      sollzins: Number(argv.zins ?? basis?.sollzins ?? 0),
                      tilgung: Number(argv.tilgung ?? basis?.tilgung ?? 2),
                      zinsbindung_jahre: Number(argv.zinsbindung ?? basis?.zinsbindung_jahre ?? 10),
                      sondertilgung_pro_jahr: basis?.sondertilgung_pro_jahr ?? 0,
                      disagio_prozent: basis?.disagio_prozent ?? 0,
                      gebuehren: basis?.gebuehren ?? 0,
                  }
                : undefined;

        const r = berechneSzenarien(cfg, { angebot });

        console.log('\nSzenarien');
        console.log('='.repeat(88));
        console.log(
            `  Kondition: ${r.angebot.bank} · ${r.angebot.sollzins} % Sollzins · ` +
                `${r.angebot.tilgung} % Tilgung · ${r.angebot.zinsbindung_jahre} J Zinsbindung`,
        );
        console.log(
            `  Tragbare Rate: ${eur(r.haushalt.tragbareRate)} (Ist) · ${eur(r.haushalt.tragbareRateBankSicht)} (Bank)`,
        );
        console.log(
            `  Entfällt mit dem Kauf: ${eur(r.wohnkostenHeute)} · ` +
                `neu als Eigentümer: ${eur(r.zusatzkostenNachKauf)}\n`,
        );

        console.log(
            `${'Variante'.padEnd(30)} ${'Darlehen'.padStart(12)} ${'Rate'.padStart(11)} ${'vs. heute'.padStart(11)} ${'Restschuld'.padStart(12)} ${'Tragbar'.padStart(8)}`,
        );
        console.log('-'.repeat(88));
        for (const v of r.varianten) {
            const diff = `${v.differenzZuHeute >= 0 ? '+' : ''}${eurShort(v.differenzZuHeute)}`;
            const rest = v.restschuldNachBindung === null ? '—' : eurShort(v.restschuldNachBindung);
            const flag = v.tragbarBankSicht ? '✓✓' : v.tragbar ? '✓' : '✗';
            console.log(
                `${v.label.padEnd(30)} ${eurShort(v.bedarf.darlehensbedarf).padStart(12)} ${eurShort(v.rate).padStart(11)} ${diff.padStart(11)} ${rest.padStart(12)} ${flag.padStart(8)}`,
            );
        }
        console.log('-'.repeat(88));
        console.log('  ✓✓ trägt auch die Bank-Sicht · ✓ trägt die Ist-Rechnung · ✗ zu teuer');
        console.log('  „Restschuld" = offen am Ende der Zinsbindung, also der Anschlussfinanzierungsbedarf.');
        console.log(
            '  „vs. heute" = Rate + neue Eigentümerkosten − entfallende Miete. Nicht Rate vs. Miete:\n' +
                '  Nebenkosten, die du schon selbst zahlst, werden durch den Kauf nicht billiger.\n',
        );
    },
};

/** `finanzierung unterlagen` — the document checklist. */
const unterlagenCommand: CommandModule = {
    command: 'unterlagen',
    describe: 'Unterlagen-Checkliste für die Bank mit Ist-Stand',
    builder: (y) =>
        y
            .option('entity', entityOption)
            .option('offen', { type: 'boolean', default: false, describe: 'Nur offene Punkte zeigen' }),
    handler: (argv) => {
        const cfg = requireConfig(String(argv.entity));
        const r = berechneUnterlagen(cfg);
        const z = r.zusammenfassung;

        console.log('\nUnterlagen für die Finanzierung');
        console.log('='.repeat(72));
        console.log(
            `  ${z.eingereicht} eingereicht · ${z.vorhanden} vorhanden · ${z.angefordert} angefordert · ${z.offen} offen\n`,
        );

        const labels: Record<string, string> = {
            person: 'Person',
            einkommen: 'Einkommen & Bonität',
            objekt: 'Objekt',
            vorhaben: 'Vorhaben & Sanierung',
        };
        const marks: Record<string, string> = {
            eingereicht: '✓✓',
            vorhanden: '✓ ',
            angefordert: '⋯ ',
            offen: '☐ ',
        };

        const eintraege = argv.offen ? r.offen : r.eintraege;
        for (const kat of ['person', 'einkommen', 'objekt', 'vorhaben'] as const) {
            const group = eintraege.filter((e) => e.kategorie === kat);
            if (group.length === 0) continue;
            console.log(`  ${labels[kat]}`);
            for (const e of group) {
                const ref = e.paperlessId ? `  [Paperless #${e.paperlessId}]` : '';
                console.log(`    ${marks[e.status]} ${e.bezeichnung}${ref}`);
                if (e.notiz) console.log(`         ↳ ${e.notiz}`);
            }
            console.log('');
        }
        console.log(
            '  Die Liste ist der Standardsatz einer Baufinanzierung — jede Bank fragt ihren\n' +
                '  eigenen Mix ab. Einträge unter finanzierung.unterlagen überschreiben ihn.\n',
        );
    },
};

/** `finanzierung tragbar` — invert the household calculation into a loan ceiling. */
const tragbarCommand: CommandModule = {
    command: 'tragbar',
    describe: 'Aus einer Monatsrate den maximalen Darlehensbetrag rechnen',
    builder: (y) =>
        y
            .option('rate', zahlOption('Monatsrate in €', { demandOption: true }))
            .option('zins', zahlOption('Sollzins p.a. in %', { demandOption: true }))
            .option('tilgung', zahlOption('Anfangstilgung p.a. in %', { default: '2' })),
    handler: (argv) => {
        const rate = Number(argv.rate);
        const zins = Number(argv.zins);
        const tilgung = Number(argv.tilgung);
        const betrag = maxDarlehen(rate, zins, tilgung);

        console.log('\nMaximaler Darlehensbetrag');
        console.log('='.repeat(56));
        console.log(`  Monatsrate            ${eur(rate).padStart(16)}`);
        console.log(`  Sollzins p.a.         ${`${zins} %`.padStart(16)}`);
        console.log(`  Anfangstilgung p.a.   ${`${tilgung} %`.padStart(16)}`);
        console.log('-'.repeat(56));
        console.log(`  Darlehensbetrag       ${eur(betrag).padStart(16)}`);
        console.log(`  Gegenprobe: Rate      ${eur(annuitaet(betrag, zins, tilgung)).padStart(16)}\n`);
    },
};

/** The `finanzierung` command group. */
export const finanzierungCommand: CommandModule = {
    command: 'finanzierung',
    describe: 'Immobilien-/Sanierungsfinanzierung: Darlehen rechnen, Haushaltsrechnung, Szenarien, Unterlagen',
    builder: (y) =>
        y
            .command(darlehenCommand)
            .command(mixCommand)
            .command(tragbarCommand)
            .command(bedarfCommand)
            .command(haushaltCommand)
            .command(szenarioCommand)
            .command(unterlagenCommand)
            .demandCommand(1, 'Bitte ein Unterkommando angeben.'),
    handler: () => {
        /* handled by the subcommands */
    },
};
