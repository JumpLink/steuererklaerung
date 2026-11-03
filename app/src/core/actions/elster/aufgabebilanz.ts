/**
 * Aufgabebilanz report: gathers the inputs for {@link computeAufgabebilanz} from what the app
 * already holds — the Restbuchwerte of the Betriebsaufgabe, the bank balances at the Aufgabe date,
 * the post-Aufgabe §24 flows of the EÜR and the configured nachträgliche Posten — so the balance
 * sheet rests on the same data as the filed EÜR and Feststellung.
 */

import { loadStatements, searchAccountKeys } from '@steuererklaerung/store';

import type { ElsterConfig, SyncConfig } from '../../config/index.ts';
import { loadManifest, defaultAccountScope } from '../../config/index.ts';
import { round2, fmtDe as fmt } from '../../lib/money.ts';
import {
    computeAufgabebilanz,
    type AufgabebilanzResult,
    type AufgabeBilanzPosten,
    type AufgabePostenInput,
} from '../../elster/aufgabebilanz.ts';
import type { EuerTxAggregate } from '../../elster/euer-transactions.ts';
import { transactionsSummary } from '../transactions.ts';
import { buildAufgabegewinn, euerReportByTransactions } from './euer.ts';

export interface AufgabebilanzBank {
    accountKey: string;
    konto: string;
    saldo: number;
    /** 'auszug' = closing balance of a statement ending on the Aufgabe date; 'buchungen' = Σ bookings. */
    quelle: 'auszug' | 'buchungen';
}

export interface AufgabebilanzReport {
    year: number;
    bilanz: AufgabebilanzResult;
    bank: AufgabebilanzBank[];
}

/** Bank balance at `datum`: a statement closing on that day wins; otherwise Σ of all bookings up to it. */
function bankSaldo(accountKey: string, datum: string): { saldo: number; quelle: AufgabebilanzBank['quelle'] } {
    const stmt = loadStatements(accountKey).find((s) => s.to === datum && s.closing != null);
    if (stmt) return { saldo: round2(stmt.closing!), quelle: 'auszug' };
    const saldo = searchAccountKeys([accountKey], { to: datum }).reduce((s, t) => s + t.amount, 0);
    return { saldo: round2(saldo), quelle: 'buchungen' };
}

export async function aufgabebilanzReport(
    syncConfig: SyncConfig,
    elster: ElsterConfig,
    year: number,
    options: { accountKeys?: string[]; agg?: EuerTxAggregate } = {},
): Promise<AufgabebilanzReport> {
    const aufgabe = buildAufgabegewinn(elster, year);
    if (!aufgabe) throw new Error('Keine Betriebsaufgabe konfiguriert (`adjustments.betriebsaufgabe`).');
    const datum = aufgabe.datum;
    if (!datum.startsWith(String(year))) {
        throw new Error(`Die Betriebsaufgabe (${datum}) liegt nicht im Jahr ${year}.`);
    }
    const cfg = elster.adjustments?.aufgabebilanz;
    const euer =
        options.agg ?? (await euerReportByTransactions(syncConfig, year, { accountKeys: options.accountKeys, elster }));

    const zuordnung = new Map((cfg?.zuordnung ?? []).map((z) => [z.transaktion_id, z.als]));
    const posten: AufgabePostenInput[] = euer.coverage.outsidePeriod
        .filter((r) => r.included && r.bookingDate > datum)
        .map((r) => ({
            ref: r.id,
            datum: r.bookingDate,
            bezeichnung: [r.counterparty, r.purpose].filter(Boolean).join(' | '),
            netto: Math.abs(r.net),
            ust: Math.abs(r.vat),
            art: r.amount >= 0 ? 'einnahme' : 'ausgabe',
            als: zuordnung.get(r.id),
        }));
    (elster.adjustments?.nachtraegliche_posten ?? []).forEach((p, i) => {
        if (!p.datum.startsWith(String(year))) return;
        posten.push({
            ref: `nachtraegliche_posten[${i}]`,
            datum: p.datum,
            bezeichnung: p.bezeichnung,
            netto: p.netto,
            ust: round2(p.netto * p.ust_satz),
            art: p.art,
            entstanden: p.entstanden,
            als: p.als,
        });
    });

    const scopeKeys = options.accountKeys?.length
        ? options.accountKeys
        : defaultAccountScope(
              loadManifest(),
              transactionsSummary().accounts.map((a) => a.accountKey),
              elster,
          );
    const bank: AufgabebilanzBank[] = scopeKeys.map((k) => ({
        accountKey: k,
        konto: elster.account_labels[k] ?? k,
        ...bankSaldo(k, datum),
    }));

    const bilanz = computeAufgabebilanz({
        datum,
        anlagen: aufgabe.assets.map((a) => ({ id: a.id, bezeichnung: a.bezeichnung, restbuchwert: a.restbuchwert })),
        bank: bank.map((b) => ({ konto: b.konto, saldo: b.saldo })),
        kasse: cfg?.kasse,
        posten,
        steuerposten: cfg?.steuerposten,
        laufenderGewinn: euer.totals.profit,
        nachtraeglichNet: euer.totals.nachtraeglichNet,
    });
    return { year, bilanz, bank };
}

const line = (label: string, betrag: number, width = 58): string =>
    `  ${label.length > width ? `${label.slice(0, width - 1)}…` : label.padEnd(width)} ${fmt(betrag).padStart(12)} €`;

function printPosten(title: string, rows: AufgabeBilanzPosten[]): void {
    if (!rows.length) return;
    console.log(`\n${title}:`);
    for (const p of rows) {
        console.log(
            `  ${p.datum}  ${p.bezeichnung.slice(0, 44).padEnd(44)} netto ${fmt(p.netto).padStart(10)} € · brutto ${fmt(p.brutto).padStart(10)} €`,
        );
    }
}

/** Print the Aufgabebilanz, the Übergangsgewinn and the Überleitung to the EÜR's laufender Gewinn. */
export function printAufgabebilanz(report: AufgabebilanzReport, elster: ElsterConfig): void {
    const b = report.bilanz;
    const [y, m, d] = b.datum.split('-');
    console.log(`\nAufgabebilanz zum ${d}.${m}.${y} — Übergang zum Bestandsvergleich (R 4.5 Abs. 6 EStR)`);
    console.log('='.repeat(76));
    console.log(`${elster.betrieb?.name ?? elster.datenlieferant} · Steuernummer ${elster.tax_number}`);

    console.log('\nAktiva:');
    for (const z of b.aktiva) console.log(line(z.bezeichnung, z.betrag));
    console.log(line('Summe Aktiva', b.summeAktiva));
    console.log('\nPassiva:');
    for (const z of b.passiva) console.log(line(z.bezeichnung, z.betrag));
    console.log(line('Summe Passiva', b.summeAktiva));

    printPosten('Forderungen (Rechnung vor, Zahlung nach der Aufgabe)', b.forderungen);
    printPosten('Verbindlichkeiten', b.verbindlichkeiten);
    printPosten('Rückstellungen', b.rueckstellungen);
    printPosten('Bleibt nachträglich (§24 Nr. 2 EStG, nach der Aufgabe entstanden)', b.nachtraeglich);

    const u = b.uebergangsgewinn;
    console.log('\nÜbergangsgewinn (Anlage zu R 4.6 EStR, netto):');
    console.log(line('+ Forderungen', u.forderungen));
    console.log(line('− Verbindlichkeiten', -u.verbindlichkeiten));
    console.log(line('− Rückstellungen', -u.rueckstellungen));
    console.log(line('= Übergangsgewinn (laufender Gewinn)', u.summe));

    const ue = b.ueberleitung;
    console.log('\nÜberleitung zum laufenden Gewinn:');
    console.log(line(`EÜR bis ${d}.${m}.${y}`, ue.euerBisAufgabe));
    console.log(line('+ Übergangsgewinn', ue.uebergangsgewinn));
    if (ue.nachtraeglichNet) console.log(line('+ nachträgliche Einnahmen/Ausgaben (§24)', ue.nachtraeglichNet));
    console.log(line('= laufender Gewinn', ue.laufenderGewinn));
    console.log(line('laufender Gewinn lt. EÜR', ue.laufenderGewinnLautEuer));

    const ausBuchungen = report.bank.filter((k) => k.quelle === 'buchungen');
    if (ausBuchungen.length) {
        console.log(
            `\nℹ Banksalden ohne Auszug zum Stichtag aus den Buchungen summiert (${ausBuchungen.map((k) => k.konto).join(', ')}) — setzt die vollständige Buchungshistorie ab Kontoeröffnung voraus; gegen den Kontoauszug prüfen.`,
        );
    }
    if (ue.abweichung) {
        console.log(
            `\n⚠ Die Posten erklären die §24-Summe der EÜR nicht vollständig (Abweichung ${fmt(ue.abweichung)} €) — fehlt ein nachträglicher Posten?`,
        );
    }
    if (!(elster.adjustments?.aufgabebilanz?.steuerposten ?? []).length) {
        console.log(
            '\nℹ Keine Steuerposten konfiguriert (USt-Verbindlichkeit, GewSt-Erstattung): sie ändern nur das Eigenkapital, nicht den Übergangsgewinn. Stand zum Stichtag aus dem FA-Steuerkonto übernehmen.',
        );
    }
}
