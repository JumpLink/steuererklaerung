/**
 * Anlagen zur Feststellungserklärung für eine Betriebsaufgabe: drei druckfertige Dokumente für die
 * Rückfrage des Finanzamts — Aufgabegewinn-Ermittlung, Aufgabebilanz, Übergangsgewinn. Die Modelle
 * sind reine Funktionen der bereits berechneten Reports ({@link FeststellungReport},
 * {@link AufgabebilanzReport}); gerendert wird über denselben PDF-Weg wie die Prüf-Datenblätter
 * ({@link writeSteuerblattPdf}) und zusätzlich als Markdown. Wie alle Steuerdokumente bleiben sie deutsch.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SteuerblattModel, SteuerblattTable } from '@steuererklaerung/invoice-pdf';

import type { ElsterConfig, SyncConfig } from '../../config/index.ts';
import { fmtDe as fmt } from '../../lib/money.ts';
import { feststellungReport, type FeststellungReport } from './feststellung.ts';
import { aufgabebilanzReport, type AufgabebilanzReport } from './aufgabebilanz.ts';
import { writeSteuerblattPdf } from './steuerblatt-pdf.ts';

type Asset = NonNullable<FeststellungReport['aufgabe']>['assets'][number];

const eur = (n: number): string => `${fmt(n)} €`;

const datumDe = (iso: string): string => {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
};

/** The shared head of every Anlage: Entität, Steuernummer, Stichtag, Bezug zur Erklärung. */
function kopf(elster: ElsterConfig, year: number, datum: string, title: string, subtitle: string): SteuerblattModel {
    return {
        title,
        subtitle,
        meta: [
            {
                label: 'Gesellschaft',
                value: elster.betrieb?.name ?? elster.datenlieferant ?? elster.entity_id,
            },
            { label: 'Steuernummer', value: elster.tax_number },
            { label: 'Stichtag', value: datumDe(datum) },
            { label: 'Bezug', value: `Anlage zur Feststellungserklärung ${year}` },
        ],
        sections: [],
        warnings: [],
        note: null,
    };
}

/** (1) Ermittlung des Aufgabegewinns/-verlusts je Wirtschaftsgut, Aufteilung je Gesellschafter. */
export function aufgabegewinnAnlage(report: FeststellungReport, elster: ElsterConfig): SteuerblattModel {
    const aufgabe = report.aufgabe;
    if (!aufgabe) throw new Error('Keine Betriebsaufgabe konfiguriert (`adjustments.betriebsaufgabe`).');
    const { result } = report;
    const name = (id?: string): string => elster.gesellschafter.find((g) => g.id === id)?.name ?? id ?? '—';

    const model = kopf(
        elster,
        result.year,
        aufgabe.datum,
        `Ermittlung des Aufgabegewinns/-verlusts zum ${datumDe(aufgabe.datum)}`,
        'Betriebsaufgabe, § 16 Abs. 3 EStG — Wirtschaftsgüter: gemeiner Wert ./. Restbuchwert',
    );

    model.landscape = true;
    const behandlung = (a: Asset): string =>
        a.realteilung
            ? 'Realteilung (Buchwert)'
            : a.gemeinerWert === 0 && !a.uebernehmer
              ? 'Abgang ohne Wert'
              : 'Entnahme (gemeiner Wert)';
    const sum = (pick: (a: Asset) => number): number =>
        Math.round(aufgabe.assets.reduce((s, a) => s + pick(a), 0) * 100) / 100;
    model.sections.push({
        heading: 'Wirtschaftsgüter',
        table: {
            columns: [
                { header: 'Gegenstand', weight: 1.4 },
                { header: 'Inv.-ID', nowrap: true },
                { header: 'gemeiner Wert', align: 'right', nowrap: true },
                { header: 'Restbuchwert', align: 'right', nowrap: true },
                { header: 'Ergebnis', align: 'right', nowrap: true },
                { header: 'Übernehmer', weight: 1.2 },
                { header: 'Behandlung', weight: 1.4 },
            ],
            rows: aufgabe.assets.map((a) => [
                a.bezeichnung,
                a.id,
                eur(a.gemeinerWert),
                eur(a.restbuchwert),
                eur(a.gewinn),
                name(a.uebernehmer),
                behandlung(a),
            ]),
            footer: [
                'Summe',
                '',
                eur(sum((a) => a.gemeinerWert)),
                eur(sum((a) => a.restbuchwert)),
                eur(aufgabe.entnahmegewinn),
                '',
                '',
            ],
        },
        rows: [],
    });

    model.sections.push({
        heading: 'Ergebnis',
        rows: [
            {
                label: 'Summe Entnahmegewinn/-verlust Wirtschaftsgüter',
                value: eur(aufgabe.entnahmegewinn),
            },
            { label: '− Aufgabekosten', value: eur(aufgabe.aufgabekosten) },
            {
                label: aufgabe.aufgabegewinn < 0 ? '= Aufgabeverlust' : '= Aufgabegewinn',
                value: eur(aufgabe.aufgabegewinn),
                emphasis: true,
            },
        ],
    });

    model.sections.push({
        heading: 'Aufteilung auf die Gesellschafter',
        rows: result.allocations.map((a) => ({
            label: `${a.gesellschafter.name} (${(a.gesellschafter.quote * 100).toFixed(2).replace('.', ',')} %)`,
            value: eur(a.aufgabegewinnAnteil),
        })),
    });

    if (aufgabe.assets.some((a) => a.realteilung)) {
        model.warnings.push(
            'Realteilung: Die Wirtschaftsgüter gehen zum Buchwert in das Betriebsvermögen des Übernehmers über. Die Sperrfrist nach § 16 Abs. 3 Satz 3 EStG ist zu beachten; bei Verstoß gilt rückwirkend der gemeine Wert.',
        );
    }
    model.note =
        'Die gemeinen Werte sind eine Schätzung des Steuerpflichtigen; Wirtschaftsgüter ohne Wert gehen ohne Gegenleistung ab (Ausbuchung).';
    return model;
}

/** (2) Aufgabebilanz zum Stichtag: Aktiva und Passiva. */
export function aufgabebilanzAnlage(report: AufgabebilanzReport, elster: ElsterConfig): SteuerblattModel {
    const b = report.bilanz;
    const model = kopf(
        elster,
        report.year,
        b.datum,
        `Aufgabebilanz zum ${datumDe(b.datum)}`,
        'Übergang zum Bestandsvergleich (R 4.5 Abs. 6 EStR)',
    );
    model.sections.push({
        heading: 'Aktiva',
        rows: [
            ...b.aktiva.map((z) => ({
                label: z.bezeichnung,
                value: eur(z.betrag),
                indent: 1,
            })),
            { label: 'Summe Aktiva', value: eur(b.summeAktiva), emphasis: true },
        ],
    });
    model.sections.push({
        heading: 'Passiva',
        rows: [
            ...b.passiva.map((z) => ({
                label: z.bezeichnung,
                value: eur(z.betrag),
                indent: 1,
            })),
            { label: 'Summe Passiva', value: eur(b.summeAktiva), emphasis: true },
        ],
    });
    if (report.bank.some((k) => k.quelle === 'buchungen')) {
        model.warnings.push('Banksalden ohne Kontoauszug zum Stichtag aus den Buchungen summiert.');
    }
    return model;
}

/** (3) Übergangsgewinn nach der Anlage zu R 4.6 EStR. */
export function uebergangsgewinnAnlage(report: AufgabebilanzReport, elster: ElsterConfig): SteuerblattModel {
    const b = report.bilanz;
    const u = b.uebergangsgewinn;
    const model = kopf(
        elster,
        report.year,
        b.datum,
        `Übergangsgewinn zum ${datumDe(b.datum)}`,
        'Wechsel von § 4 Abs. 3 zu § 4 Abs. 1 EStG (Anlage zu R 4.6 EStR), netto',
    );
    const posten = (heading: string, rows: typeof b.forderungen): void => {
        if (!rows.length) return;
        model.sections.push({
            heading,
            rows: rows.map((p) => ({
                label: `${datumDe(p.datum)}  ${p.bezeichnung}`,
                value: eur(p.netto),
                indent: 1,
            })),
        });
    };
    posten('Forderungen', b.forderungen);
    posten('Verbindlichkeiten', b.verbindlichkeiten);
    posten('Rückstellungen', b.rueckstellungen);
    model.sections.push({
        heading: 'Berechnung',
        rows: [
            { label: '+ Forderungen', value: eur(u.forderungen) },
            { label: '− Verbindlichkeiten', value: eur(-u.verbindlichkeiten) },
            { label: '− Rückstellungen', value: eur(-u.rueckstellungen) },
            {
                label: '= Übergangsgewinn (laufender Gewinn)',
                value: eur(u.summe),
                emphasis: true,
            },
        ],
    });
    model.note =
        'Der Übergangsgewinn ist laufender Gewinn des letzten Jahres, nicht Teil des Aufgabegewinns nach § 16 EStG.';
    return model;
}

/** A {@link SteuerblattTable} as a Markdown table; the footer is set bold. */
function tableToMarkdown(table: SteuerblattTable, cell: (s: string) => string): string[] {
    const row = (cells: string[], bold = false): string =>
        `| ${cells.map((c) => (bold && c ? `**${cell(c)}**` : cell(c))).join(' | ')} |`;
    return [
        row(table.columns.map((c) => c.header)),
        `|${table.columns.map((c) => (c.align === 'right' ? '---:' : '---')).join('|')}|`,
        ...table.rows.map((r) => row(r)),
        ...(table.footer ? [row(table.footer, true)] : []),
    ];
}

/** Render a datasheet model as Markdown (headings, one table per section). */
export function steuerblattToMarkdown(model: SteuerblattModel): string {
    const cell = (s: string): string => s.replace(/\|/g, '\\|');
    const out: string[] = [`# ${model.title}`, '', `_${model.subtitle}_`, ''];
    for (const m of model.meta) out.push(`- **${m.label}:** ${m.value}`);
    for (const s of model.sections) {
        out.push('', `## ${s.heading}`, '');
        if (s.table) out.push(...tableToMarkdown(s.table, cell));
        if (!s.rows.length) continue;
        if (s.table) out.push('');
        out.push('| Position | Betrag |', '|---|---:|');
        for (const r of s.rows) {
            const label = `${r.indent ? '&nbsp;&nbsp;' : ''}${cell(r.label)}`;
            out.push(
                `| ${r.emphasis ? `**${label}**` : label} | ${r.emphasis && r.value ? `**${r.value}**` : r.value} |`,
            );
        }
    }
    for (const w of model.warnings) out.push('', `> ⚠ ${w}`);
    if (model.note) out.push('', model.note);
    return `${out.join('\n')}\n`;
}

export interface AufgabeAnlagenResult {
    files: string[];
}

/** Compute both reports once and write the three Anlagen as PDF + Markdown into `outDir`. */
export async function exportAufgabeAnlagen(
    syncConfig: SyncConfig,
    elster: ElsterConfig,
    year: number,
    outDir: string,
    options: { accountKeys?: string[] } = {},
): Promise<AufgabeAnlagenResult> {
    const fest = await feststellungReport(syncConfig, elster, year, {
        accountKeys: options.accountKeys,
    });
    const bilanz = await aufgabebilanzReport(syncConfig, elster, year, {
        accountKeys: options.accountKeys,
        agg: fest.euer,
    });
    const docs: Array<[string, SteuerblattModel]> = [
        ['1-aufgabegewinn', aufgabegewinnAnlage(fest, elster)],
        ['2-aufgabebilanz', aufgabebilanzAnlage(bilanz, elster)],
        ['3-uebergangsgewinn', uebergangsgewinnAnlage(bilanz, elster)],
    ];
    mkdirSync(outDir, { recursive: true });
    const files: string[] = [];
    for (const [stem, model] of docs) {
        const base = join(outDir, `${stem}-${year}`);
        files.push(await writeSteuerblattPdf(model, `${base}.pdf`));
        writeFileSync(`${base}.md`, steuerblattToMarkdown(model));
        files.push(`${base}.md`);
    }
    return { files };
}
